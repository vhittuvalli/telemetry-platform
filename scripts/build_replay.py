"""Build a race replay file from FastF1 data.
Combines the f1 functions into one runnable script to convert FastF1
data to interpetable file.

Usage:
    python scripts/build_replay.py 2024 Monza R
"""

import argparse

from telemetry.f1 import REPLAYS_DIR, build_race_replay, load_session, save_replay


def replay_filename(year, event, session_type):
    """Build a filename like 'monza_2024_r.parquet'."""
    slug = event.lower().replace(" ", "_")
    return f"{slug}_{year}_{session_type.lower()}.parquet"


def main():
    parser = argparse.ArgumentParser(description="Build a race replay file from FastF1 data.")
    parser.add_argument("year", type=int, help="Season, e.g. 2024")
    parser.add_argument("event", help='Event name, e.g. "Monza" or "Las Vegas"')
    parser.add_argument("session_type", help="Session: R, Q, S, FP1, FP2, FP3")
    args = parser.parse_args()

    print(f"Loading {args.year} {args.event} {args.session_type}...")
    session = load_session(args.year, args.event, args.session_type)

    print("Building replay...")
    replay = build_race_replay(session)

    path = save_replay(replay, REPLAYS_DIR / replay_filename(args.year, args.event, args.session_type))

    size_mb = path.stat().st_size / 1_000_000
    print(
        f"Built replay: {replay['vehicle_id'].nunique()} drivers, {len(replay):,} rows, "
        f"{replay['time'].min():.1f}s to {replay['time'].max():.1f}s"
    )
    print(f"Saved to {path} ({size_mb:.1f} MB)")


if __name__ == "__main__":
    main()