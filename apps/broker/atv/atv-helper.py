#!/usr/bin/env python3
"""Apple TV control for the Bar Games broker, over Apple's Companion protocol (pyatv).

The broker starts this once and talks JSON lines over stdin/stdout:
  request  {"id": 1, "op": "key", "identifier": "...", "address": "192.0.2.10", "credentials": "...", "key": "up"}
  response {"id": 1, "ok": true, "result": ...}   or   {"id": 1, "ok": false, "code": "auth|offline|pin|unsupported|error", "error": "..."}

Ops: scan, pair_begin, pair_finish, key, power, state, apps, launch, text.
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
from pyatv.const import OperatingSystem, PowerState, Protocol
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
        ident = req["identifier"]
        old = self.pairings.pop(ident, None)
        if old:
            await old[0].close()
        conf = await self.find(req["address"], ident)
        handler = await pyatv.pair(conf, Protocol.Companion, self.loop, name=req.get("name") or "Bar Games box")
        await handler.begin()
        self.pairings[ident] = [handler, time.monotonic()]
        return {"pin": bool(handler.device_provides_pin)}

    async def pair_finish(self, req):
        ident = req["identifier"]
        entry = self.pairings.get(ident)
        if not entry:
            raise Fail("error", "start pairing first: the Apple TV shows a new PIN")
        handler = entry[0]
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

    async def launch(self, req):
        app = str(req.get("app", ""))
        return await self.with_device(req, lambda atv: atv.apps.launch_app(app))

    async def text(self, req):
        text = str(req.get("text", ""))[:100]
        return await self.with_device(req, lambda atv: atv.keyboard.text_append(text))

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
            "launch": self.launch,
            "text": self.text,
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
