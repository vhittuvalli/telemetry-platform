# Replay Data Format

**Version:** 0.2
**Status:** Draft; applies to F1 session replays produced by `telemetry.f1.build_and_save`
(used by `scripts/build_replay.py` and the backend's `/builds` endpoint) and rocket flights
produced by `telemetry.rocket.replay.save_flight` (used by `scripts/simulate_rocket.py`)

This document defines the format of replay data used across the platform. The data
pipeline (`telemetry/f1.py`) produces it, the backend serves it, and the 3D viewer
consumes it. Any new data source (uploads, the rocket simulator) must produce this format.

## File format

- **Format:** Apache Parquet, Zstandard (`zstd`) compression
- **Location:** `data/replays/`
- **Naming:** `<event>_<year>_<session>.parquet`, where `<event>` is FastF1's
  `EventName` lowercased with accents removed and non-alphanumerics replaced by
  underscores (e.g. `italian_grand_prix_2024_r.parquet`). Older files named after
  the location (e.g. `monza_2024_r`) still work; the backend identifies sessions
  from each replay's `.meta.json`, not its filename.
- **Companion files:** `<id>.meta.json`, plus `<id>.laps.json` for F1. An F1 replay
  counts as built once all three files exist (the laps file is written last); a rocket
  replay once its parquet and metadata exist (the metadata is written last).
- **Domain:** the metadata's `domain` field, `"f1"` or `"rocket"`, says which scene and
  panels show the replay. Replays without one are F1.
- **Layout:** long format: one row per vehicle per sample
- **Sort order:** by `time`, then `vehicle_id`

## Time

- `time` is measured in **seconds** on a single clock shared by all vehicles.
- **0 = the official session start** (FastF1 `session.session_start_time`).
  Verify whether this corresponds to the formation lap or the race start before
  relying on it for race-start logic.
- Data is kept from 60 s before the start to 60 s after the last completed lap
  (the `padding_s` parameter of `build_race_replay`).
- Negative times are valid (the pre-start padding).

## Coordinate system

- Units: **meters**
- Axes: `x` and `y` are horizontal; **`z` is up** (elevation)
- The origin is fixed by F1's timing system and is not meaningful on its own; only
  relative positions matter.
- **Renderer note:** three.js uses Y-up. Convert once when loading: three.js
  `(x, y, z)` = data `(x, z, -y)`, or an equivalent mapping.

## Columns

| Column       | Type (pandas) | Unit    | Required | Nullable | Description |
|--------------|---------------|---------|----------|----------|-------------|
| `time`       | float64       | s       | yes      | no       | Time since session start (shared clock) |
| `vehicle_id` | string/object | –       | yes      | no       | Vehicle identifier; for F1, the driver code (e.g. `LEC`) |
| `x`          | float64       | m       | yes      | no       | Horizontal position |
| `y`          | float64       | m       | yes      | no       | Horizontal position |
| `z`          | float64       | m       | yes      | no       | Elevation (up) |
| `speed`      | float64       | km/h    | no       | yes      | Vehicle speed |
| `throttle`   | float64       | %       | no       | yes      | Throttle position, 0–100 |
| `brake`      | Int8          | 0/1     | no       | yes      | 1 when the brake is applied |
| `gear`       | Int8          | –       | no       | yes      | Current gear (0 = neutral) |
| `rpm`        | float64       | rev/min | no       | yes      | Engine speed |
| `drs`        | Int8          | –       | no       | yes      | Raw DRS status code from FastF1 |
| `on_track`   | bool          | –       | no       | no       | False when the car is off track (garage, retired) |

**Required** columns are the minimum for the 3D viewer to place a vehicle.
Optional columns power the dashboard, charts, and metrics.

## Rocket flights

Rocket replays (`domain: "rocket"`, ids `rocket_<name>_<motor>`) have a single vehicle,
`rocket`. Time 0 is motor ignition; the flight ends at landing. The origin is the launch
pad, with `x` east, `y` north and `z` up, so `z` is the altitude above the pad. Samples
are every 0.01 s in powered and coasting flight and every 0.05 s under a parachute.

The required columns and `speed` (km/h) are as above; rockets add:

| Column              | Type    | Unit | Description |
|---------------------|---------|------|-------------|
| `qw`, `qx`, `qy`, `qz` | float64 | –  | Orientation: unit quaternion rotating the rocket's body frame (+z out of the nose) into the world frame |
| `vertical_velocity` | float64 | m/s  | Up is positive |
| `acceleration`      | float64 | m/s² | Magnitude of the total acceleration |
| `mach`              | float64 | –    | Airspeed over the local speed of sound |
| `dynamic_pressure`  | float64 | Pa   | ½ρv² of the airflow; its peak is "max Q" |
| `angle_of_attack`   | float64 | °    | Angle between the rocket's axis and the airflow |
| `stability_margin`  | float64 | cal  | Distance from CG back to CP, in body diameters |
| `thrust`            | float64 | N    | Motor thrust |
| `mass`              | float64 | kg   | Rocket plus remaining propellant |

The metadata adds `rocket` (geometry: nose, body tubes, fins, motor and recovery, in
meters, positions measured from the nose tip), `launch` (rail, wind and site),
`summary` (apogee, max speed, Mach, acceleration and Q, landing point, flight time) and
`events`, each `{name, time, x, y, z}`. Event names: `ignition`, `liftoff`,
`rail_exit`, `burnout`, `apogee`, `ejection`, `deploy:<recovery device name>`, `landing`.

To place the rocket at time `t`, interpolate position linearly and orientation with a
quaternion slerp between the samples around `t`.

## Sampling and missing data

- Each vehicle is sampled independently at irregular intervals (a few samples per
  second). **Timestamps differ between vehicles**; never assume rows align.
- Position data is the backbone: each row is a position sample, matched to the
  nearest car-data sample within **500 ms**. Rows with no match within that window
  have missing (null) car-data values.
- A vehicle's rows stop when it retires or its data ends.
- Samples without a position fix (FastF1 reports them as `x = y = 0`, typically before a
  car first leaves the garage) are dropped, so a vehicle's rows may start after `time` 0.
- `z` in the pit lane is often held flat by FastF1 and can sit a few meters off the
  track's real height; renderers should place cars on their own road surface.

## Interpolation guidance (for consumers)

To get a vehicle's state at an arbitrary time `t`:

- **Continuous channels** (`x`, `y`, `z`, `speed`, `throttle`, `rpm`):
  linearly interpolate between the samples just before and just after `t`.
- **Discrete channels** (`gear`, `brake`, `drs`, `on_track`): use the most recent
  value at or before `t`.
- If `t` is outside a vehicle's time range, the vehicle has no state at `t`.

## Changelog

- **0.1:** Initial format for F1 race replays.
- **0.2:** `domain` in the metadata; rocket flights.