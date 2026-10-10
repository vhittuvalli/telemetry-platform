"""Stream an F1 session to the platform live: every car's telemetry and each lap as it's completed.

    # re-stream a saved race over UDP to a server on this machine, 10x faster than real time
    python scripts/stream_f1.py data/replays/monza_2024_r --speed 10

    # just a slice: from the formation lap to 10 minutes in
    python scripts/stream_f1.py data/replays/monza_2024_r --from -60 --to 600

    # to a remote site: through scripts/telemetry_relay.py (UDP), or straight over a WebSocket
    python scripts/stream_f1.py data/replays/monza_2024_r --site https://telemetry-platform.onrender.com --websocket

Build a replay first if you don't have one (scripts/build_replay.py, or the race picker).
A server keeps up to 450,000 samples per live F1 session, enough for a full race.
"""

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from telemetry import live_client, live_sources  # noqa: E402


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("replay", help="a saved F1 replay (path without extension)")
    parser.add_argument("--from", dest="start", type=float, help="session time to start from, s (0 = session start)")
    parser.add_argument("--to", dest="end", type=float, help="session time to stop at, s")
    parser.add_argument("--site", default="http://localhost:8000", help="the platform's address")
    parser.add_argument("--udp", help="where to send UDP, host:port (default: the site's own UDP port, "
                                      "or a WebSocket if it has none; give a relay's address to use one)")
    parser.add_argument("--websocket", action="store_true", help="send over a WebSocket to --site instead of UDP")
    parser.add_argument("--speed", type=float, default=1.0, help="playback speed (1 = real time)")
    args = parser.parse_args()

    race = live_sources.f1_replay(args.replay, args.start, args.end)
    cars = len({s["vehicle_id"] for s in race.samples})
    session = race.meta["session"]
    print(f"{session['year']} {session['event']} · {session['name']}: "
          f"{len(race.samples):,} samples from {cars} cars, {len(race.laps)} laps")
    live_client.stream(args.site.rstrip("/"), "f1", race.meta, race.samples, laps=race.laps, udp=args.udp,
                       websocket=args.websocket, speed=args.speed)


if __name__ == "__main__":
    main()
