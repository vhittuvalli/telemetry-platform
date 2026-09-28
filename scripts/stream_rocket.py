"""Stream a rocket flight to the platform live, the way a flight computer sends telemetry.

    # simulate and stream over UDP to a server on this machine
    python scripts/stream_rocket.py rockets/dual_parachute_deployment.json

    # another motor, some wind and a tilted rail
    python scripts/stream_rocket.py rockets/chute_release.json --motor aerotech_g80t.eng --wind 6 --wind-from 270 --angle 5

    # to a remote site: run scripts/telemetry_relay.py --site <url> first, then
    python scripts/stream_rocket.py rockets/chute_release.json --site https://telemetry-platform.onrender.com

    # or skip UDP and send over a WebSocket straight to the site
    python scripts/stream_rocket.py rockets/chute_release.json --site https://... --websocket

    # re-stream a saved flight instead of simulating
    python scripts/stream_rocket.py --replay data/replays/rocket_chute_release_g40w

Samples go out paced in real time (or --speed times faster), a few per packet; the
flight events (burnout, apogee, ...) go out as they happen. See docs/live-protocol.md.
"""

import argparse
import json
import sys
from dataclasses import replace
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from telemetry import live_client  # noqa: E402


def load_flight(args) -> tuple[list[dict], list[dict], dict]:
    """(samples, events, registration meta) from a simulation or a saved replay."""
    import pandas as pd
    if args.replay:
        stem = Path(args.replay)
        stem = stem.with_name(stem.name.removesuffix(".parquet").removesuffix(".meta.json"))
        frame = pd.read_parquet(f"{stem}.parquet")
        meta = json.loads(Path(f"{stem}.meta.json").read_text())
        events = meta.get("events", [])
    else:
        from telemetry.rocket import catalog
        from telemetry.rocket.flight import load_launch, simulate
        from telemetry.rocket.replay import flight_frame, flight_metadata
        from telemetry.rocket.rocket import load_rocket
        rocket, launch = load_rocket(args.rocket), load_launch(args.rocket)
        if args.motor:
            delay = args.delay if args.delay is not None else rocket.ejection_delay
            rocket = catalog.with_motor(rocket, args.motor, delay)
        elif args.delay is not None:
            rocket = replace(rocket, ejection_delay=args.delay)
        overrides = {"wind_speed": args.wind, "wind_from": args.wind_from, "angle": args.angle,
                     "heading": args.heading}
        launch = replace(launch, **{k: v for k, v in overrides.items() if v is not None})
        flight = simulate(rocket, launch)
        frame = flight_frame(flight)
        meta = flight_metadata(rocket, launch, flight, rocket_id=Path(args.rocket).stem)
        events = meta["events"]
        s = meta["summary"]
        print(f"{rocket.name} on {rocket.motor.designation}: apogee {s['apogee']:.0f} m, "
              f"lands after {s['flight_time']:.0f} s")
    frame = frame.drop(columns=["vehicle_id"]).round(4)
    # What's known before launch; results (summary, events) arrive during the flight
    registration = {k: v for k, v in meta.items() if k in ("session", "rocket", "launch")}
    registration["session"] = {**registration.get("session", {}), "location": args.site_name or
                               registration.get("launch", {}).get("site_name", "Live launch")}
    return frame.to_dict("records"), [e for e in events if e["name"] != "ignition"], registration


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("rocket", nargs="?", help="rocket definition (JSON) to simulate and stream")
    parser.add_argument("--replay", help="stream a saved rocket replay instead (path without extension)")
    parser.add_argument("--motor", help="another motor from rockets/motors that fits the mount, e.g. estes_c6.eng")
    parser.add_argument("--delay", type=float, help="ejection delay, s after burnout")
    parser.add_argument("--wind", type=float, help="wind speed, m/s")
    parser.add_argument("--wind-from", type=float, help="compass direction the wind blows from, degrees")
    parser.add_argument("--angle", type=float, help="rail angle from vertical, degrees")
    parser.add_argument("--heading", type=float, help="compass direction the rail tilts toward, degrees")
    parser.add_argument("--site", default="http://localhost:8000", help="the platform's address")
    parser.add_argument("--udp", default="127.0.0.1:9870",
                        help="where to send UDP: the server itself, or a relay (default %(default)s)")
    parser.add_argument("--websocket", action="store_true", help="send over a WebSocket to --site instead of UDP")
    parser.add_argument("--speed", type=float, default=1.0, help="playback speed (1 = real time)")
    parser.add_argument("--site-name", help="launch site name to show viewers")
    args = parser.parse_args()
    if not args.rocket and not args.replay:
        parser.error("give a rocket definition or --replay")

    samples, events, meta = load_flight(args)
    live_client.stream(args.site.rstrip("/"), "rocket", meta, samples, events, udp=args.udp,
                       websocket=args.websocket, speed=args.speed)


if __name__ == "__main__":
    main()
