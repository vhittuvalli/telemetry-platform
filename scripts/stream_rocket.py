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
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from telemetry import live_client, live_sources  # noqa: E402


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
    parser.add_argument("--udp", help="where to send UDP, host:port (default: the site's own UDP port, "
                                      "or a WebSocket if it has none; give a relay's address to use one)")
    parser.add_argument("--websocket", action="store_true", help="send over a WebSocket to --site instead of UDP")
    parser.add_argument("--speed", type=float, default=1.0, help="playback speed (1 = real time)")
    parser.add_argument("--site-name", help="launch site name to show viewers")
    args = parser.parse_args()
    if not args.rocket and not args.replay:
        parser.error("give a rocket definition or --replay")

    if args.replay:
        flight = live_sources.rocket_replay(args.replay, site_name=args.site_name)
    else:
        flight = live_sources.rocket_flight(args.rocket, motor=args.motor, delay=args.delay, wind=args.wind,
                                            wind_from=args.wind_from, angle=args.angle, heading=args.heading,
                                            site_name=args.site_name)
        s = flight.summary
        print(f"{flight.meta['rocket']['name']} on {flight.meta['rocket']['motor']['designation']}: "
              f"apogee {s['apogee']:.0f} m, lands after {s['flight_time']:.0f} s")
    live_client.stream(args.site.rstrip("/"), "rocket", flight.meta, flight.samples, flight.events,
                       udp=args.udp, websocket=args.websocket, speed=args.speed)


if __name__ == "__main__":
    main()
