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

Send each packet as one datagram to the server's `udp_port`, and keep it under about
**1,200 bytes** so it isn't fragmented (a few samples per packet). The server replies
only when it rejects a packet, with `{"error": "…"}`.

Web hosts such as Render accept only HTTP, so UDP can't reach them directly. Run the
relay next to your sender; it listens for UDP and forwards over a WebSocket:

```bash
python scripts/telemetry_relay.py --site https://telemetry-platform.onrender.com   # listens on UDP 9870
```

Then send your UDP packets to the relay's machine, port 9870.

### Over a WebSocket

Connect to `wss://<site>/live/ingest` and send each packet as a text message. Same
format; errors come back as `{"error": "…"}` messages.

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
- At most 20 live sessions at once per server.

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
    sock.sendto(json.dumps(packet).encode(), ("127.0.0.1", 9870))
    time.sleep(0.02)
```
