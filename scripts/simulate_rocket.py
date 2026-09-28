"""Simulate a rocket flight and save it as a replay.

    python scripts/simulate_rocket.py rockets/chute_release.json
    python scripts/simulate_rocket.py rockets/chute_release.json --wind 6 --wind-from 270 --angle 5

Launch conditions come from the definition's `launch` section; flags override them.
"""

import argparse
import sys
from dataclasses import replace
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from telemetry.rocket.flight import load_launch, simulate  # noqa: E402
from telemetry.rocket.replay import save_flight  # noqa: E402
from telemetry.rocket.rocket import load_rocket  # noqa: E402

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("rocket", type=Path, help="rocket definition (JSON)")
    parser.add_argument("--wind", type=float, help="wind speed, m/s")
    parser.add_argument("--wind-from", type=float, help="compass direction the wind blows from, degrees")
    parser.add_argument("--angle", type=float, help="rail angle from vertical, degrees")
    parser.add_argument("--heading", type=float, help="compass direction the rail tilts toward, degrees")
    parser.add_argument("--site", help="launch site name")
    args = parser.parse_args()

    rocket = load_rocket(args.rocket)
    launch = load_launch(args.rocket)
    overrides = {"wind_speed": args.wind, "wind_from": args.wind_from, "angle": args.angle,
                 "heading": args.heading, "site_name": args.site}
    launch = replace(launch, **{k: v for k, v in overrides.items() if v is not None})

    flight = simulate(rocket, launch)
    replay_id = save_flight(rocket, launch, flight)
    s = flight.summary()
    print(f"{rocket.name} on {rocket.motor.designation}: apogee {s['apogee']:.0f} m at {s['apogee_time']:.1f} s, "
          f"max {s['max_speed']:.0f} m/s (Mach {s['max_mach']:.2f}), lands {s['flight_time']:.0f} s after launch")
    print(f"Saved replay '{replay_id}'")
