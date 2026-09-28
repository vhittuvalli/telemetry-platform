"""Stream an F1 session to the platform live: every car's telemetry and each lap as it's completed.

    # re-stream a saved race over UDP to a server on this machine, 10x faster than real time
    python scripts/stream_f1.py data/replays/monza_2024_r --speed 10

    # just a slice: from the formation lap to 10 minutes in
    python scripts/stream_f1.py data/replays/monza_2024_r --from -60 --to 600

    # to a remote site: through scripts/telemetry_relay.py (UDP), or straight over a WebSocket
    python scripts/stream_f1.py data/replays/monza_2024_r --site https://telemetry-platform.onrender.com --websocket

Build a replay first if you don't have one (scripts/build_replay.py, or the race picker).
A server keeps up to 300,000 samples per live F1 session, about an hour of a full grid.
"""

import argparse
import json
import math
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from telemetry import live_client  # noqa: E402


def load_session(path: str, start: float | None, end: float | None) -> tuple[list[dict], list[dict], dict]:
    """(samples, laps, registration meta) from a saved F1 replay."""
    import pandas as pd
    stem = Path(path)
    stem = stem.with_name(stem.name.removesuffix(".parquet").removesuffix(".meta.json"))
    frame = pd.read_parquet(f"{stem}.parquet")
    meta = json.loads(Path(f"{stem}.meta.json").read_text())
    laps = json.loads(Path(f"{stem}.laps.json").read_text())

    if start is not None:
        frame = frame[frame["time"] >= start]
    if end is not None:
        frame = frame[frame["time"] <= end]
        laps = [l for l in laps if l.get("lap_end") is not None and l["lap_end"] <= end]
    if start is not None:
        laps = [l for l in laps if l.get("lap_end") is None or l["lap_end"] >= start]

    frame = frame.assign(on_track=frame["on_track"].astype(int)).round(3)
    # Leave out missing values: the server fills in defaults
    samples = [{k: v for k, v in row.items() if not (isinstance(v, float) and math.isnan(v)) and v is not pd.NA}
               for row in frame.to_dict("records")]
    for s in samples:
        for k in ("brake", "gear", "drs"):
            if k in s:
                s[k] = int(s[k])
    registration = {"session": meta["session"], "drivers": meta["drivers"], "track_outline": meta["track_outline"]}
    return samples, laps, registration


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("replay", help="a saved F1 replay (path without extension)")
    parser.add_argument("--from", dest="start", type=float, help="session time to start from, s (0 = session start)")
    parser.add_argument("--to", dest="end", type=float, help="session time to stop at, s")
    parser.add_argument("--site", default="http://localhost:8000", help="the platform's address")
    parser.add_argument("--udp", default="127.0.0.1:9870",
                        help="where to send UDP: the server itself, or a relay (default %(default)s)")
    parser.add_argument("--websocket", action="store_true", help="send over a WebSocket to --site instead of UDP")
    parser.add_argument("--speed", type=float, default=1.0, help="playback speed (1 = real time)")
    args = parser.parse_args()

    samples, laps, meta = load_session(args.replay, args.start, args.end)
    cars = len({s["vehicle_id"] for s in samples})
    print(f"{meta['session']['year']} {meta['session']['event']} · {meta['session']['name']}: "
          f"{len(samples):,} samples from {cars} cars, {len(laps)} laps")
    live_client.stream(args.site.rstrip("/"), "f1", meta, samples, laps=laps, udp=args.udp,
                       websocket=args.websocket, speed=args.speed)


if __name__ == "__main__":
    main()
