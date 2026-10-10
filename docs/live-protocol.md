# Live Telemetry Protocol

**Version:** 1
**Status:** Draft; rocket and F1 sessions

Anything that can send UDP or open a WebSocket (a flight computer's ground station, a
simulator, a phone, a game) can stream to the platform. Viewers watch live in the 3D
viewer, and when the stream ends it is saved as a replay.

## 1. Start a session

`POST /live/sessions` with the session's domain and what's known before launch:

```json
{
  "domain": "rocket",
  "meta": {
    "session": { "event": "My rocket", "location": "Launch site" },
    "rocket": { "...": "geometry, as in a rocket replay's metadata (docs/data-format.md)" },
    "launch": { "rail_length": 1.5, "angle": 0, "heading": 0, "wind_speed": 3, "wind_from": 270 }
  }
}
```

`meta.rocket` is required: the viewer builds the 3D model from it (length, diameter,
launch CG, nose, body tubes, fins, motor, recovery). The easiest way to produce it is
`telemetry.rocket.replay.flight_metadata()`, as `scripts/stream_rocket.py` does.

If your rocket doesn't need to look like itself, skip the geometry: name one of the site's
designs (`GET /rockets` lists them) and the server fills in `meta.rocket` and `meta.launch`:

```json
{ "domain": "rocket", "rocket": "chute_release", "meta": { "session": { "event": "My rocket" } } }
```

The site's **Go live** panel starts a session this way and shows its code and key.

For an F1 session, `domain` is `"f1"` and `meta` carries the field and the track, as in
an F1 replay's metadata:

```json
{
  "domain": "f1",
  "meta": {
    "session": { "year": 2024, "event": "Italian Grand Prix", "location": "Monza", "name": "Race" },
    "drivers": [ { "code": "LEC", "number": "16", "name": "Charles Leclerc", "team": "Ferrari",
                   "color": "#e8002d", "grid_position": 4, "status": null } ],
    "track_outline": [ [x, y, z], "... a few hundred points around one lap, in meters" ]
  }
}
```

The response:

```json
{ "code": "K7Q4MX", "key": "3fZ…", "udp_port": 9870, "protocol_version": 1 }
```

`udp_port` is the port to send UDP to on the site's own host, or `null` when the server
can't take UDP (e.g. on Render); send over a WebSocket then.

Share the **code**: viewers watch at `https://<site>/?live=K7Q4MX`, or type it into
the session picker. Keep the **key** secret: every packet must carry it.

## 2. Send packets

Each packet is one JSON object:

```json
{
  "v": 1,
  "session": "K7Q4MX",
  "key": "3fZ…",
  "seq": 42,
  "samples": [
    { "time": 1.23, "x": 0.4, "y": -0.1, "z": 85.2, "speed": 402.1,
      "qw": 0.999, "qx": 0.01, "qy": 0.0, "qz": 0.0, "vertical_velocity": 111.6,
      "acceleration": 21.3, "mach": 0.33, "dynamic_pressure": 7400, "thrust": 0, "mass": 1.52 }
  ],
  "events": [ { "name": "burnout", "time": 0.33, "x": 0, "y": 0, "z": 24 } ],
  "end": false
}
```

- **Samples** use the rocket channels from `docs/data-format.md` (units there: meters,
  seconds, `speed` in km/h, the rest SI). `time`, `x`, `y`, `z` are required; other
  channels default to 0 (and `qw` to 1, pointing straight up). Unknown channels are ignored.
- **F1 samples** carry a `vehicle_id` (the driver's code, which must be in `meta.drivers`)
  and the F1 channels: `speed`, `throttle`, `brake`, `gear`, `rpm`, `drs`, `on_track` (1/0).
- **Laps** (F1): send each lap when it's completed, in the replay's laps format:
  `{"driver": "LEC", "lap": 12, "lap_time": 84.1, "lap_end": 1043.6, "position": 2,
  "compound": "HARD", "tyre_life": 9, "stint": 2, "pit_in": null, "pit_out": null}`.
  They drive the leaderboard. Send them in a packet's `laps` list.
- **Events** mark moments in a rocket flight: `liftoff`, `rail_exit`, `burnout`, `apogee`,
  `ejection`, `deploy:<parachute name>`, `landing`.
- **`seq`** counts packets from 0. The server drops duplicates and counts gaps as lost
  packets. Late packets are fine: samples are slotted in by time.
- **`"end": true`** closes the session and saves the recording.

### Over UDP

Send each packet as one datagram to the site's host at `udp_port` (e.g.
`telemetry.example.com:9870`), and keep it under about **1,200 bytes** so it isn't
fragmented (a few samples per packet; datagrams over 8 KB are dropped). The server replies
only when it rejects a packet, with `{"error": "…"}`, and only when that reply is no bigger
than your packet. Pad a test packet if you want to see errors while debugging.

UDP is not encrypted: the key travels in the clear. If that matters, use the WebSocket
over `wss://`.

Web hosts such as Render accept only HTTP, so UDP can't reach them directly (`udp_port` is
`null`). Run the relay next to your sender; it listens for UDP and forwards over a WebSocket:

```bash
telemetry-live relay --site https://telemetry-platform.onrender.com              # listens on UDP 9870
python scripts/telemetry_relay.py --site https://telemetry-platform.onrender.com # the same, from a checkout
```

Then send your UDP packets to the relay's machine, port 9870.

### Over a WebSocket

Connect to `wss://<site>/live/ingest` and send each packet as a text message (up to
64 KB). Same format; errors come back as `{"error": "…"}` messages.

### With `telemetry-live`

`pip install "git+https://github.com/vhittuvalli/telemetry-platform"` (Python 3.10+) installs a
sender that does the packets for you. Give it samples, one JSON object per line (or a CSV with a
header row); a line with an `event` key is a flight event:

```bash
ground_station | telemetry-live send - --rocket chute_release --site https://<site>   # live, as lines arrive
telemetry-live send flight.csv --rocket chute_release --site https://<site>          # a recording, paced by time
telemetry-live send - --session K7Q4MX --key 3fZ… --site https://<site>              # a session from Go live
```

## Demo streams

`POST /live/demo` with `{"rocket": "<design>"}` (a simulated flight) or `{"replay": "<built F1
replay>"}` (its first 10 minutes), and `"speed"` from 1 to 20, has the server stream it into a new
live session itself. The response has the `code` to watch; the session lists with `"demo": true`.
A server runs 3 demos at once (`LIVE_MAX_DEMOS`); they count toward the starting address's sessions.

## Watching (for viewers other than the web app)

`wss://<site>/live/sessions/<code>/watch` sends a `snapshot` of the session so far
(`meta`, `events`, `laps`), one `vehicle` message per vehicle with its columns, then `data` messages
with new `samples`, `events` and `laps` about ten times a second, and an `end` message with
the recording's `replay_id`.

## Limits

- Sessions end after 10 minutes without packets. A rocket session keeps 60,000 samples
  (ten minutes at 100 Hz); an F1 session keeps 450,000 (a full race; Monza 2024 is 360,000).
- Live F1 views show the track, cars and leaderboard; the pit lane and starting grid are
  worked out from a whole session, so they appear in the recording, not live.
- At most 20 live sessions at once per server, and 3 open at once from one IP address.
  Starting a session is limited to 6 at once per address, then one every 2 minutes (HTTP 429).
- 500 packets a second per sender address (bursts of 1,000); packets over the limit are dropped.
- 100 viewers per session. A server keeps its 100 newest live recordings.
- These are defaults; a server's operator can change them (docs/self-hosting.md).

## A minimal sender

```python
import json, math, socket, time, urllib.request

site = "http://localhost:8000"
meta = {"session": {"event": "Hand-thrown"}, "rocket": {...}, "launch": {}}  # rocket geometry here
req = urllib.request.Request(f"{site}/live/sessions", json.dumps({"domain": "rocket", "meta": meta}).encode(),
                             {"content-type": "application/json"})
s = json.loads(urllib.request.urlopen(req).read())
print("watch at", f"{site}/?live={s['code']}")

sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
for seq in range(500):
    t = seq * 0.02
    sample = {"time": t, "x": 0, "y": 0, "z": 50 * math.sin(t / 3)}
    packet = {"v": 1, "session": s["code"], "key": s["key"], "seq": seq, "samples": [sample], "end": seq == 499}
    sock.sendto(json.dumps(packet).encode(), ("localhost", s["udp_port"]))  # the site's host
    time.sleep(0.02)
```
