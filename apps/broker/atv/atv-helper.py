#!/usr/bin/env python3
"""Apple TV control for the Bar Games broker, over Apple's Companion protocol (pyatv).

The broker starts this once and talks JSON lines over stdin/stdout:
  request  {"id": 1, "op": "key", "identifier": "...", "address": "192.0.2.10", "credentials": "...", "key": "up"}
  response {"id": 1, "ok": true, "result": ...}   or   {"id": 1, "ok": false, "code": "auth|offline|pin|unsupported|error", "error": "..."}

Ops: scan, pair_begin, pair_finish, key, power, state, apps, launch, text,
video_play, video_control, video_status (box 0.27.0).

Video (box 0.27.0): the Apple TV is handed a URL over AirPlay and streams it itself. That
needs an AirPlay connection (credentials from an AirPlay pairing, else transient pairing)
next to Companion. AirPlay playback lasts as long as that connection, so the helper keeps
it open while the video plays. URLs carry the media server's key: never logged.
One Companion connection per Apple TV stays open (remote presses are instant) and is
closed after 10 idle minutes or when the TV drops it. Credentials are passed in by the
broker on every call; nothing is stored here. Logs go to stderr, never credentials.
"""

import asyncio
import json
import sys
import time

import pyatv
from pyatv import exceptions
from pyatv.const import DeviceState, OperatingSystem, PowerState, Protocol
from pyatv.interface import DeviceListener

IDLE_SECONDS = 600
PAIR_SECONDS = 180

# Our key names (the box's remote) -> pyatv RemoteControl methods. Nothing else is callable.
KEYS = {
    "Up": "up",
    "Down": "down",
    "Left": "left",
    "Right": "right",
    "Select": "select",
    "Back": "menu",
    "Home": "home",
    "Play": "play_pause",
    "Rev": "skip_backward",
    "Fwd": "skip_forward",
    "VolumeUp": "volume_up",
    "VolumeDown": "volume_down",
}


class Fail(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def log(*parts):
    print("atv-helper:", *parts, file=sys.stderr, flush=True)


class Lost(DeviceListener):
    def __init__(self, helper, identifier):
        self.helper = helper
        self.identifier = identifier

    def connection_lost(self, exception):
        self.helper.conns.pop(self.identifier, None)

    def connection_closed(self):
        self.helper.conns.pop(self.identifier, None)


class Helper:
    def __init__(self):
        self.loop = asyncio.get_running_loop()
        self.conns = {}  # identifier -> [atv, last_used]
        self.pairings = {}  # identifier -> [handler, started]
        self.locks = {}
        self.videos = {}  # identifier -> {"atv", "task", "error"} (box 0.27.0)

    @staticmethod
    def dev_key(req):
        # Not "key": that name is the remote-control key op below (0.29.8 shadowed it).
        # Box 0.29.8: an AirPlay-only TV (a Roku) has no Apple TV identifier: its address is the key.
        return str(req.get("identifier") or req["address"])

    def lock(self, identifier):
        return self.locks.setdefault(identifier, asyncio.Lock())

    async def find(self, address, identifier=None, timeout=4):
        found = await pyatv.scan(self.loop, hosts=[address], timeout=timeout)
        for conf in found:
            if identifier is None or identifier in conf.all_identifiers:
                return conf
        raise Fail("offline", f"no Apple TV answers at {address}")

    # ---- ops

    async def scan(self, req):
        hosts = [str(h) for h in req.get("hosts") or []] or None
        found = await pyatv.scan(self.loop, timeout=int(req.get("timeout", 4)), hosts=hosts)
        out = []
        for conf in found:
            info = conf.device_info
            companion = conf.get_service(Protocol.Companion)
            if info.operating_system != OperatingSystem.TvOS or companion is None:
                continue  # iPads, Macs, HomePods, AirPlay TVs
            out.append({
                "identifier": conf.identifier,
                "identifiers": list(conf.all_identifiers),
                "name": conf.name,
                "address": str(conf.address),
                "model": info.model_str,
                "version": info.version,
            })
        return out

    async def pair_begin(self, req):
        ident = self.dev_key(req)
        old = self.pairings.pop(ident, None)
        if old:
            await old[0].close()
        conf = await self.find(req["address"], req.get("identifier"))
        # Box 0.27.0: "airplay" pairs AirPlay (for handing the Apple TV video links).
        protocol = Protocol.AirPlay if req.get("protocol") == "airplay" else Protocol.Companion
        handler = await pyatv.pair(conf, protocol, self.loop, name=req.get("name") or "Bar Games box")
        await handler.begin()
        self.pairings[ident] = [handler, time.monotonic()]
        return {"pin": bool(handler.device_provides_pin)}

    async def pair_finish(self, req):
        ident = self.dev_key(req)
        entry = self.pairings.get(ident)
        if not entry:
            raise Fail("error", "start pairing first: the TV shows a new PIN")
        handler = entry[0]
        if req.get("pin") is not None:  # a TV that shows no PIN pairs without one
            handler.pin(int(req["pin"]))
        try:
            await handler.finish()
        except exceptions.PairingError as err:
            # A wrong PIN is an authentication failure from the Apple TV. A bug (a library
            # mismatch, say) shows up as a Python error underneath: say so, not "wrong PIN".
            cause = err.__cause__ or err.__context__
            if isinstance(cause, (TypeError, AttributeError, ValueError, ImportError)):
                log("pairing failed inside the helper:", type(cause).__name__, cause)
                raise Fail("error", f"pairing failed inside the box ({type(cause).__name__}: {cause}); this isn't the PIN")
            raise Fail("pin", f"that PIN didn't work ({err})")
        if not handler.has_paired:
            raise Fail("pin", "that PIN didn't work")
        creds = handler.service.credentials
        self.pairings.pop(ident, None)
        await handler.close()
        self.conns.pop(ident, None)
        return {"credentials": creds}

    async def device(self, req):
        ident = req["identifier"]
        # While a video plays, its connection (Companion and AirPlay) serves the remote too.
        video = self.videos.get(ident)
        if video:
            return video["atv"]
        entry = self.conns.get(ident)
        if entry:
            entry[1] = time.monotonic()
            return entry[0]
        if not req.get("credentials"):
            raise Fail("auth", "not paired")
        conf = await self.find(req["address"], ident)
        conf.set_credentials(Protocol.Companion, req["credentials"])
        try:
            atv = await pyatv.connect(conf, self.loop, protocol=Protocol.Companion)
        except exceptions.AuthenticationError as err:
            raise Fail("auth", f"the Apple TV refused the box's pairing ({err})")
        atv.listener = Lost(self, ident)
        self.conns[ident] = [atv, time.monotonic()]
        return atv

    async def with_device(self, req, fn):
        async with self.lock(req["identifier"]):
            try:
                return await fn(await self.device(req))
            except (exceptions.ConnectionLostError, exceptions.ConnectionFailedError, ConnectionError, OSError):
                # A dropped connection: one fresh try.
                self.drop(req["identifier"])
                return await fn(await self.device(req))

    def drop(self, ident):
        entry = self.conns.pop(ident, None)
        if entry:
            try:
                entry[0].close()
            except Exception:  # noqa: BLE001 - closing a dead connection
                pass

    async def key(self, req):
        method = KEYS.get(req.get("key"))
        if not method:
            raise Fail("unsupported", f"no {req.get('key')!r} key")
        return await self.with_device(req, lambda atv: getattr(atv.remote_control, method)())

    async def power(self, req):
        on = bool(req.get("on"))
        return await self.with_device(req, lambda atv: atv.power.turn_on() if on else atv.power.turn_off())

    async def state(self, req):
        async def get(atv):
            try:
                ps = atv.power.power_state
            except exceptions.NotSupportedError:
                return {"power": "unknown"}
            return {"power": "on" if ps == PowerState.On else "off" if ps == PowerState.Off else "unknown"}

        return await self.with_device(req, get)

    async def apps(self, req):
        async def get(atv):
            return [{"id": a.identifier, "name": a.name} for a in await atv.apps.app_list()]

        return await self.with_device(req, get)

    async def now(self, req):
        # Box 0.20.0: the app in front. None when tvOS doesn't say (home screen, or no metadata).
        async def get(atv):
            try:
                app = atv.metadata.app
            except Exception:
                return {"unknown": True}
            return {"id": app.identifier, "name": app.name} if app and app.identifier else None

        return await self.with_device(req, get)

    async def launch(self, req):
        app = str(req.get("app", ""))
        return await self.with_device(req, lambda atv: atv.apps.launch_app(app))

    async def text(self, req):
        text = str(req.get("text", ""))[:100]
        return await self.with_device(req, lambda atv: atv.keyboard.text_append(text))

    # ---- video (box 0.27.0)

    async def video_open(self, req):
        ident = self.dev_key(req)
        await self.video_close(ident)
        conf = await self.find(req["address"], req.get("identifier"))
        if req.get("credentials"):
            conf.set_credentials(Protocol.Companion, req["credentials"])
        if req.get("airplay"):
            conf.set_credentials(Protocol.AirPlay, req["airplay"])
        # The Companion-only remote connection would compete with this one, which does both.
        self.drop(ident)
        try:
            atv = await pyatv.connect(conf, self.loop)
        except exceptions.AuthenticationError as err:
            log("video connect refused:", str(err)[:120])
            raise Fail("needs-pairing", f"the Apple TV wants the box paired for AirPlay video ({err})")
        v = {"atv": atv, "task": None, "error": None}
        self.videos[ident] = v
        return v

    async def video_close(self, ident):
        v = self.videos.pop(ident, None)
        if not v:
            return
        if v["task"] and not v["task"].done():
            v["task"].cancel()
        try:
            v["atv"].close()
        except Exception:  # noqa: BLE001 - closing a dead connection
            pass

    async def video_play(self, req):
        ident = self.dev_key(req)
        url = str(req.get("url", ""))
        if not url.startswith(("http://", "https://")):
            raise Fail("unsupported", "only http and https video links")
        start = float(req.get("startAt") or 0)
        async with self.lock(ident):
            v = await self.video_open(req)

            async def run():
                try:
                    if start:
                        await v["atv"].stream.play_url(url, position=start)
                    else:
                        await v["atv"].stream.play_url(url)
                except asyncio.CancelledError:
                    raise
                except exceptions.AuthenticationError as err:
                    # pyatv 0.18 raises AuthenticationError("status code: N") for ANY 4xx/5xx
                    # answer to /play (its own TODO). Only 401/403/470 are about pairing; the
                    # rest mean the Apple TV turned down this video (format, link, server).
                    msg = str(err)
                    safe = msg[:120] if "://" not in msg else type(err).__name__
                    code = msg[len("status code: "):] if msg.startswith("status code: ") else ""
                    if code and code not in ("401", "403", "470"):
                        v["error"] = f"refused the video, AirPlay status {code}"
                    else:
                        v["error"] = "needs-pairing"
                        v["detail"] = safe
                    log("video play refused:", safe)
                except Exception as err:  # noqa: BLE001 - reported through video_status
                    # Never the URL: the error's type, and its text only when it holds no link.
                    msg = str(err)
                    v["error"] = type(err).__name__ + ("" if "://" in msg or not msg else f": {msg[:160]}")
                    log("video playback ended with", type(err).__name__)

            v["task"] = asyncio.ensure_future(run())
            # Give the Apple TV a moment to refuse (a format it can't play, pairing) before answering.
            await asyncio.sleep(2.5)
            if v["task"].done() and v["error"]:
                err = v["error"]
                await self.video_close(ident)
                if err == "needs-pairing":
                    detail = v.get("detail")
                    raise Fail("needs-pairing", "the Apple TV wants the box paired for AirPlay video" + (f" ({detail})" if detail else ""))
                raise Fail("error", f"the Apple TV couldn't play it ({err})")
        return {"ok": True}

    async def video_status(self, req):
        v = self.videos.get(self.dev_key(req))
        if not v:
            return {"state": "stopped"}
        out = {}
        try:
            p = await v["atv"].metadata.playing()
            if p.position is not None:
                out["position"] = int(p.position)
            if p.total_time:
                out["duration"] = int(p.total_time)
            if p.device_state in (DeviceState.Playing, DeviceState.Loading, DeviceState.Seeking):
                out["state"] = "playing"
            elif p.device_state == DeviceState.Paused:
                out["state"] = "paused"
        except Exception:  # noqa: BLE001 - no metadata over this connection: go by the playback task
            pass
        running = v["task"] is not None and not v["task"].done()
        if not running:
            out["state"] = "error" if v["error"] else "stopped"
            if v["error"]:
                out["message"] = "the Apple TV stopped with an error (" + v["error"] + ")"
        elif "state" not in out:
            out["state"] = "playing"
        return out

    async def video_control(self, req):
        ident = self.dev_key(req)
        action = req.get("action")
        v = self.videos.get(ident)
        if action == "stop":
            if v:
                try:
                    await v["atv"].remote_control.stop()
                except Exception:  # noqa: BLE001 - closing the AirPlay session stops it anyway
                    pass
                await self.video_close(ident)
            elif req.get("identifier"):
                # No session here (the helper restarted, or an older bug lost it): still tell the
                # Apple TV to stop, so "stop" never leaves a movie playing.
                try:
                    await self.with_device(req, lambda atv: atv.remote_control.stop())
                except Exception as ex:  # noqa: BLE001 - nothing was playing is fine too
                    log("video stop without a session:", type(ex).__name__)
            return {"ok": True}
        if not v or v["task"] is None or v["task"].done():
            raise Fail("error", "nothing is playing")
        rc = v["atv"].remote_control
        if action == "pause":
            await rc.pause()
        elif action == "resume":
            await rc.play()
        elif action == "seek":
            await rc.set_position(max(0, int(req.get("position") or 0)))
        else:
            raise Fail("unsupported", f"unknown action {action!r}")
        return {"ok": True}

    async def handle(self, req):
        op = req.get("op")
        fn = {
            "scan": self.scan,
            "pair_begin": self.pair_begin,
            "pair_finish": self.pair_finish,
            "key": self.key,
            "power": self.power,
            "state": self.state,
            "apps": self.apps,
            "now": self.now,
            "launch": self.launch,
            "text": self.text,
            "video_play": self.video_play,
            "video_status": self.video_status,
            "video_control": self.video_control,
        }.get(op)
        if not fn:
            raise Fail("unsupported", f"unknown op {op!r}")
        return await fn(req)

    async def reaper(self):
        while True:
            await asyncio.sleep(30)
            now = time.monotonic()
            for ident, (_atv, used) in list(self.conns.items()):
                if now - used > IDLE_SECONDS:
                    self.drop(ident)
            for ident, (handler, started) in list(self.pairings.items()):
                if now - started > PAIR_SECONDS:
                    self.pairings.pop(ident, None)
                    await handler.close()


def reply(msg):
    sys.stdout.write(json.dumps(msg) + "\n")
    sys.stdout.flush()


async def serve(helper, req):
    rid = req.get("id")
    try:
        result = await asyncio.wait_for(helper.handle(req), timeout=float(req.get("timeoutSec", 20)))
        reply({"id": rid, "ok": True, "result": result})
    except Fail as err:
        reply({"id": rid, "ok": False, "code": err.code, "error": str(err)})
    except exceptions.NotSupportedError as err:
        reply({"id": rid, "ok": False, "code": "unsupported", "error": str(err) or "the Apple TV doesn't support that"})
    except (asyncio.TimeoutError, exceptions.ConnectionFailedError, exceptions.ConnectionLostError, OSError) as err:
        reply({"id": rid, "ok": False, "code": "offline", "error": str(err) or "the Apple TV isn't answering"})
    except Exception as err:  # noqa: BLE001 - every request gets an answer
        log("op failed:", req.get("op"), type(err).__name__)
        reply({"id": rid, "ok": False, "code": "error", "error": f"{type(err).__name__}: {err}"})


async def main():
    helper = Helper()
    asyncio.ensure_future(helper.reaper())
    reader = asyncio.StreamReader(limit=1 << 20)
    await helper.loop.connect_read_pipe(lambda: asyncio.StreamReaderProtocol(reader), sys.stdin)
    reply({"id": 0, "ok": True, "result": {"ready": True, "pyatv": pyatv.const.__version__}})
    while True:
        line = await reader.readline()
        if not line:
            break
        try:
            req = json.loads(line)
        except ValueError:
            continue
        asyncio.ensure_future(serve(helper, req))


if __name__ == "__main__":
    asyncio.run(main())
