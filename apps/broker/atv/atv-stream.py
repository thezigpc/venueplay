#!/usr/bin/env python3
"""Plays audio on a TV or speaker over AirPlay for the Bar Games broker (pyatv).

  atv-stream.py '{"host": "192.0.2.10", "title": "...", "artist": "...", "album": "..."}'

Reads a WAV stream (16-bit stereo, 44.1 kHz) on stdin and streams it until stdin ends or
the receiver drops it. One process per playing session: the broker stops it with SIGTERM.
Problems go to stderr as one JSON line, {"error": "<plain words for the venue>"}, and the
exit code is 1. Nothing here is stored.
"""

import asyncio
import json
import signal
import sys

import pyatv
from pyatv import exceptions
from pyatv.const import Protocol
from pyatv.interface import MediaMetadata


def fail(message, code=1):
    print(json.dumps({"error": message}), file=sys.stderr, flush=True)
    sys.exit(code)


async def main():
    try:
        req = json.loads(sys.argv[1])
        host = str(req["host"])
    except (IndexError, KeyError, ValueError):
        fail("bad request")
    loop = asyncio.get_running_loop()

    found = await pyatv.scan(loop, hosts=[host], timeout=5)
    conf = next((c for c in found if c.get_service(Protocol.RAOP) is not None), None)
    if conf is None:
        fail("The TV didn't answer over AirPlay. Check it's on and AirPlay is turned on.")

    try:
        atv = await pyatv.connect(conf, loop)
    except exceptions.AuthenticationError:
        fail("The TV wants the box paired for AirPlay audio. Set its AirPlay access to allow everyone on the network.")
    except Exception as err:  # noqa: BLE001 (any connection problem is reported the same way)
        fail(f"Couldn't connect to the TV over AirPlay ({type(err).__name__}).")

    reader = asyncio.StreamReader(limit=1 << 20)
    await loop.connect_read_pipe(lambda: asyncio.StreamReaderProtocol(reader), sys.stdin.buffer)
    stop = asyncio.Event()
    loop.add_signal_handler(signal.SIGTERM, stop.set)

    meta = MediaMetadata(title=req.get("title") or None, artist=req.get("artist") or None, album=req.get("album") or None)
    play = asyncio.ensure_future(atv.stream.stream_file(reader, metadata=meta))
    waiter = asyncio.ensure_future(stop.wait())
    try:
        done, _ = await asyncio.wait({play, waiter}, return_when=asyncio.FIRST_COMPLETED)
        if play in done:
            err = play.exception()
            if isinstance(err, exceptions.AuthenticationError):
                fail("The TV wants the box paired for AirPlay audio. Set its AirPlay access to allow everyone on the network.")
            if err is not None:
                fail(f"The TV stopped taking audio ({type(err).__name__}).")
        else:
            play.cancel()
    finally:
        atv.close()


if __name__ == "__main__":
    asyncio.run(main())
