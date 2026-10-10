"""telemetry-live: stream your own telemetry to the platform, from a file or as it happens.

    pip install "git+https://github.com/vhittuvalli/telemetry-platform"

    # which rocket designs the site can draw your flight as
    telemetry-live designs --site https://<site>

    # replay a recorded flight (CSV with a header row, or one JSON object per line), paced by its time column
    telemetry-live send flight.csv --rocket chute_release --site https://<site>

    # live: a flight computer's ground station writes one sample per line; each goes out as it arrives
    ground_station | telemetry-live send - --rocket chute_release --site https://<site>

    # to a session started on the site (Go live), with the code and key it showed
    ground_station | telemetry-live send - --session K7Q4MX --key 3fZ... --site https://<site>

    # forward UDP from a device on this network to a site that only takes HTTP (e.g. Render)
    telemetry-live relay --site https://<site>

Samples need `time`, `x`, `y`, `z` (s and m, z up); the other channels are in
docs/live-protocol.md. A JSON line with an `event` key is a flight event, e.g.
{"event": "apogee", "time": 9.8, "z": 306}. Needs only Python 3.10+ (and `websockets`
for sites without UDP).
"""

import argparse
import csv
import json
import sys
import urllib.request

from telemetry import live_client, live_relay


def parse_line(line: str, header: list[str] | None) -> dict | None:
    """One sample or event from a JSON line, or a CSV row under `header`; None for a blank line."""
    line = line.strip()
    if not line:
        return None
    if header is None:
        return json.loads(line)
    row = next(csv.reader([line]))
    return {k: _value(v) for k, v in zip(header, row) if v != ""}


def _value(text: str):
    try:
        return float(text)
    except ValueError:
        return text  # e.g. a vehicle id


def read_lines(lines):
    """(samples and events) from lines of JSON objects, or of CSV under a header row."""
    header, json_lines = None, None  # the first line that isn't blank decides which
    for line in lines:
        if json_lines is None and line.strip():
            json_lines = line.lstrip().startswith("{")
            if not json_lines:
                header = [h.strip() for h in next(csv.reader([line]))]  # a CSV file's first row
                continue
        try:
            item = parse_line(line, header)
        except ValueError:
            print(f"skipped a line that isn't JSON or CSV: {line.strip()[:80]}", file=sys.stderr)
            continue
        if item is None:
            continue
        if not isinstance(item, dict) or "time" not in item:
            print(f"skipped a line without a time: {line.strip()[:80]}", file=sys.stderr)
            continue
        yield item


def as_event(item: dict) -> dict:
    return {"name": str(item["event"]), "time": item["time"], **{k: item.get(k, 0.0) for k in ("x", "y", "z")}}


def send_file(args, meta: dict) -> None:
    with open(args.file) as f:
        items = list(read_lines(f))
    samples = [i for i in items if "event" not in i]
    events = [as_event(i) for i in items if "event" in i]
    if not samples:
        sys.exit(f"{args.file} has no samples")
    live_client.stream(args.site, args.domain, meta, samples, events, udp=args.udp, websocket=args.websocket,
                       speed=args.speed, rocket=args.rocket, session=args.joined)


def send_live(args, meta: dict) -> None:
    """Each line from stdin goes out the moment it arrives; the stream ends at end of input (or Ctrl-C)."""
    session = args.joined
    if session is None:
        try:
            session = live_client.register(args.site, args.domain, meta, rocket=args.rocket)
        except live_client.LiveRefused as err:
            sys.exit(str(err))
    print(f"Live session {session['code']}: watch at {args.site}/?live={session['code']}", file=sys.stderr)
    out = live_client.sender(args.site, args.udp, args.websocket, session.get("udp_port"))
    base = {"v": 1, "session": session["code"], "key": session["key"]}
    seq = 0
    try:
        for item in read_lines(sys.stdin):
            if "event" in item:
                packet = {**base, "seq": seq, "events": [as_event(item)]}
                print(f"  T{item['time']:+8.2f} s  {item['event']}", file=sys.stderr)
            else:
                packet = {**base, "seq": seq, "samples": [item]}
            out.send(packet)
            seq += 1
    except KeyboardInterrupt:
        pass
    finally:
        out.send({**base, "seq": seq, "end": True})
        out.close()
    print(f"Done: sent {seq} packets; the stream is saved as a replay.", file=sys.stderr)


def send(args) -> None:
    meta = {}
    if args.meta:
        with open(args.meta) as f:
            meta = json.load(f)
    if args.name:
        meta["session"] = {**meta.get("session", {}), "event": args.name}
    args.joined = None
    if args.session:
        if not args.key:
            sys.exit("--session needs the session's --key too")
        try:
            args.joined = live_client.join(args.site, args.session, args.key)
        except live_client.LiveRefused as err:
            sys.exit(str(err))
    elif args.domain == "rocket" and not args.rocket and "rocket" not in meta:
        sys.exit("Give --rocket (a design from `telemetry-live designs`) or --meta with the rocket's geometry")
    if args.file == "-":
        send_live(args, meta)
    else:
        send_file(args, meta)


def designs(args) -> None:
    with urllib.request.urlopen(f"{args.site}/rockets", timeout=120) as r:
        for d in json.loads(r.read()):
            print(f"{d['id']:<32} {d['name']} ({d['motor']['designation']}, {d['length']:.2f} m)")


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(prog="telemetry-live", description=__doc__.splitlines()[0])
    commands = parser.add_subparsers(dest="command", required=True)

    p = commands.add_parser("send", help="stream samples from a file, or from stdin as they arrive")
    p.add_argument("file", help="CSV or JSON-lines file of samples; - reads stdin live")
    p.add_argument("--site", required=True, help="the platform's address")
    p.add_argument("--domain", default="rocket", choices=("rocket", "f1"))
    p.add_argument("--rocket", help="draw the flight as this design on the site (see `designs`)")
    p.add_argument("--meta", help="JSON file with the session's meta instead (docs/live-protocol.md)")
    p.add_argument("--name", help="what to call the session for viewers")
    p.add_argument("--session", help="send to a session already started (e.g. from the site's Go live panel)")
    p.add_argument("--key", help="that session's key")
    p.add_argument("--udp", help="send UDP to host:port (default: the site's own UDP port if it has one)")
    p.add_argument("--websocket", action="store_true", help="send over a WebSocket instead of UDP")
    p.add_argument("--speed", type=float, default=1.0, help="playback speed for a file (1 = real time)")
    p.set_defaults(run=send)

    p = commands.add_parser("designs", help="list the rocket designs a site can draw")
    p.add_argument("--site", required=True, help="the platform's address")
    p.set_defaults(run=designs)

    p = commands.add_parser("relay", help="forward UDP from this machine to a site over a WebSocket")
    live_relay.add_arguments(p)
    p.set_defaults(run=live_relay.run)

    args = parser.parse_args(argv)
    args.site = args.site.rstrip("/")
    args.run(args)


if __name__ == "__main__":
    main()
