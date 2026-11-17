#!/usr/bin/env python3
# Box 0.22.0: reads the touchscreens plugged into the box (Linux evdev) and prints one JSON
# line per touch frame: {"points": [{"id": 3, "x": 0.25, "y": 0.75}, ...]} with x and y from
# 0 to 1 across the screen; an empty list when the last finger lifts. The broker turns these
# into DevTools touch events on the plugged-in screen's page.
#
# Why not the compositor: cage 0.1.4 / wlroots 0.15 (Debian 12) never offers touch to
# Chromium ("could not create touch point"). Reading evdev here works everywhere.
#
# Usage: touch-reader.py [/dev/input/eventN ...]   (default: every touchscreen found)
# Standard library only.

import fcntl, json, os, re, select, struct, sys

EV_SYN, EV_KEY, EV_ABS = 0, 1, 3
SYN_REPORT = 0
BTN_TOUCH = 0x14A
ABS_X, ABS_Y = 0x00, 0x01
ABS_MT_SLOT, ABS_MT_X, ABS_MT_Y, ABS_MT_ID = 0x2F, 0x35, 0x36, 0x39
EVENT = struct.Struct("llHHi")  # struct input_event on 64-bit Linux


def touchscreens():
    """Event nodes of devices that report multi-touch positions (bit 53 of ABS)."""
    found = []
    try:
        text = open("/proc/bus/input/devices").read()
    except OSError:
        return found
    for block in text.split("\n\n"):
        abs_m = re.search(r"^B: ABS=([0-9a-f ]+)$", block, re.M)
        ev_m = re.search(r"^H: Handlers=.*\b(event\d+)\b", block, re.M)
        if not abs_m or not ev_m:
            continue
        low = int(abs_m.group(1).split()[-1], 16)
        if (low >> 53) & 1:
            found.append("/dev/input/" + ev_m.group(1))
    return found


def absinfo(fd, code):
    """(min, max) of an axis, via EVIOCGABS."""
    buf = bytearray(24)
    fcntl.ioctl(fd, 0x80184540 + code, buf)
    _value, lo, hi, _fuzz, _flat, _res = struct.unpack("6i", buf)
    return lo, hi


class Device:
    def __init__(self, path):
        self.path = path
        self.fd = os.open(path, os.O_RDONLY | os.O_NONBLOCK)
        try:
            self.x = absinfo(self.fd, ABS_MT_X)
            self.y = absinfo(self.fd, ABS_MT_Y)
            self.mt = True
        except OSError:
            self.x = absinfo(self.fd, ABS_X)
            self.y = absinfo(self.fd, ABS_Y)
            self.mt = False
        self.slot = 0
        self.slots = {}  # slot -> {"id", "x", "y"}
        self.single = None  # single-touch: {"x", "y"} while down
        self.buf = b""

    def norm(self, v, rng):
        lo, hi = rng
        return 0.0 if hi <= lo else min(1.0, max(0.0, (v - lo) / (hi - lo)))

    def points(self):
        if self.mt:
            return [{"id": s["id"], "x": round(self.norm(s.get("x", 0), self.x), 5), "y": round(self.norm(s.get("y", 0), self.y), 5)} for s in self.slots.values() if "x" in s and "y" in s]
        if self.single and "x" in self.single and "y" in self.single:
            return [{"id": 0, "x": round(self.norm(self.single["x"], self.x), 5), "y": round(self.norm(self.single["y"], self.y), 5)}]
        return []

    def handle(self, etype, code, value):
        """Returns True at the end of a frame."""
        if etype == EV_SYN and code == SYN_REPORT:
            return True
        if self.mt and etype == EV_ABS:
            if code == ABS_MT_SLOT:
                self.slot = value
            elif code == ABS_MT_ID:
                if value < 0:
                    self.slots.pop(self.slot, None)
                else:
                    self.slots[self.slot] = {"id": value % 1000000}
            elif code in (ABS_MT_X, ABS_MT_Y) and self.slot in self.slots:
                self.slots[self.slot]["x" if code == ABS_MT_X else "y"] = value
        elif not self.mt:
            if etype == EV_KEY and code == BTN_TOUCH:
                self.single = {} if value else None
            elif etype == EV_ABS and code in (ABS_X, ABS_Y) and self.single is not None:
                self.single["x" if code == ABS_X else "y"] = value
        return False


def main():
    paths = sys.argv[1:] or touchscreens()
    devices = []
    for p in paths:
        try:
            devices.append(Device(p))
        except OSError as e:
            print(json.dumps({"error": f"{p}: {e.strerror}"}), flush=True)
    if not devices:
        print(json.dumps({"error": "no touchscreen to read"}), flush=True)
        return 1
    print(json.dumps({"ready": [d.path for d in devices]}), flush=True)
    last = None
    by_fd = {d.fd: d for d in devices}
    while True:
        ready, _, _ = select.select(list(by_fd), [], [])
        for fd in ready:
            d = by_fd[fd]
            try:
                chunk = os.read(fd, EVENT.size * 64)
            except BlockingIOError:
                continue
            except OSError:
                print(json.dumps({"error": f"{d.path}: unplugged"}), flush=True)
                return 2
            d.buf += chunk
            while len(d.buf) >= EVENT.size:
                _s, _us, etype, code, value = EVENT.unpack_from(d.buf)
                d.buf = d.buf[EVENT.size:]
                if d.handle(etype, code, value):
                    pts = d.points()
                    if pts != last:
                        print(json.dumps({"points": pts}), flush=True)
                        last = pts


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        pass
