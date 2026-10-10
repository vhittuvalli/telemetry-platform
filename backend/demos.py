"""Demo streams: the server streams a simulated rocket flight or a stretch of a built F1 race into a
live session itself, so a visitor can watch live telemetry without sending any."""

import asyncio

from backend import live
from backend.limits import env_int
from telemetry import live_client
from telemetry.live_sources import LiveStream

MAX_DEMOS = env_int("LIVE_MAX_DEMOS", 3)   # streaming at once, server-wide
F1_SPAN_S = 10 * 60                        # of race time per F1 demo
TICK_S = 0.1                               # samples go in batches this often (wall time)

_running: set[asyncio.Task] = set()


class Busy(live.Throttled):
    """As many demos are streaming as the server runs at once."""


def check_capacity() -> None:
    if len(_running) >= MAX_DEMOS:
        raise Busy("The server is already streaming as many demos as it can; watch one of them, or try again soon")


def start(stream: LiveStream, owner: str, speed: float) -> live.LiveSession:
    """Open a live session for `stream` and send it in the background, paced `speed` times real time."""
    check_capacity()
    session = live.create(stream.domain, stream.meta, owner=owner, demo=True)
    task = asyncio.create_task(_send(session, stream, speed))
    _running.add(task)
    task.add_done_callback(_running.discard)
    return session


async def _send(session: live.LiveSession, stream: LiveStream, speed: float) -> None:
    loop = asyncio.get_running_loop()
    base = {"v": live.PROTOCOL_VERSION, "session": session.code, "key": session.key}
    begun = loop.time()
    seq = 0
    try:
        for offset, samples, events, laps in live_client.schedule(stream.samples, stream.events, stream.laps,
                                                                  step=TICK_S * speed):
            await asyncio.sleep(max(0.0, begun + offset / speed - loop.time()))
            # In process, so one packet a tick: no datagram size to keep under
            live.ingest({**base, "seq": seq, "samples": samples, "events": events, "laps": laps})
            seq += 1
        live.ingest({**base, "seq": seq, "end": True})
    except live.LiveError:
        pass  # the session expired or was ended; nothing left to send to


async def stop_all() -> None:
    for task in list(_running):
        task.cancel()
    await asyncio.gather(*_running, return_exceptions=True)
