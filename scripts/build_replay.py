"""Build a replay file from FastF1 data.
Combines the f1 functions into one runnable script to convert FastF1
data to interpetable file. Replays can also be built from the viewer's race picker.

Usage:
    python scripts/build_replay.py 2024 Monza R
"""

import argparse

from telemetry.f1 import REPLAYS_DIR, build_and_save, load_replay


def main():
    parser = argparse.ArgumentParser(description="Build a replay file from FastF1 data.")
    parser.add_argument("year", type=int, help="Season, e.g. 2024")
    parser.add_argument("event", help='Event name or round, e.g. "Monza", "Las Vegas" or 16')
    parser.add_argument("session_type", help="Session: R, Q, S, SQ, SS, FP1, FP2, FP3")
    args = parser.parse_args()

    #fastf1 treats a number as a round and anything else as a (fuzzy) event name
    event = int(args.event) if args.event.isdigit() else args.event
    stem = build_and_save(args.year, event, args.session_type.upper())

    path = REPLAYS_DIR / f"{stem}.parquet"
    replay = load_replay(path)
    size_mb = path.stat().st_size / 1_000_000
    print(
        f"Built replay: {replay['vehicle_id'].nunique()} drivers, {len(replay):,} rows, "
        f"{replay['time'].min():.1f}s to {replay['time'].max():.1f}s"
    )
    print(f"Saved {stem}.parquet ({size_mb:.1f} MB), {stem}.meta.json and {stem}.laps.json")


if __name__ == "__main__":
    main()
