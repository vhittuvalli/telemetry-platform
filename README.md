# Telemetry Platform

A web platform for replaying and analyzing vehicle telemetry in 3D. It shows two
kinds of sessions on one engine: real Formula 1 races, and rocket flights from a
built-in flight simulator.

> **Status:** active development. F1 replays, the rocket simulator, the 3D viewer
> for both, and Monte Carlo landing zones work today. Live telemetry over UDP is
> planned.

## Features

**F1**
- Load any F1 session available through [FastF1](https://github.com/theOehrly/Fast-F1)
  (detailed telemetry from 2018 onward), on demand from the viewer or the CLI
- Every car on track in 3D with a pit lane, starting grid and start lights
- Leaderboard, driver dashboard, and chase and onboard cameras

**Rockets**
- 6-DOF flight simulator (thrust curves, drag, stability, weathercocking, wind,
  launch rail, parachutes), validated against OpenRocket
- Launch scene: pad and rail, a model built from the rocket's real geometry,
  exhaust, parachutes, trajectory, altitude marks and flight events
- Flight dashboard and time-synced altitude, speed and acceleration charts
- Monte Carlo landing zones: hundreds of varied flights, with 50% and 95% ellipses
- Re-simulate from the viewer with another motor, wind or rail angle

## Tech stack

- **Data and simulation:** Python 3.12, FastF1, pandas, PyArrow (Parquet)
- **Backend:** FastAPI
- **Frontend:** Angular, three.js

## Project structure

```
telemetry_platform/
├── telemetry/            # Python package
│   ├── f1.py             # FastF1 pipeline: load, merge, standardize, export
│   └── rocket/           # Flight simulator, Monte Carlo, replay export
├── backend/              # FastAPI app (replays, F1 catalog and builds, rockets)
├── frontend/             # Angular + three.js viewer
│   └── src/app/
│       ├── engine/       # Shared renderer, camera and scene-module interface
│       ├── f1/           # F1 scene: track, cars, pit lane, grid
│       └── rocket/       # Rocket scene: launch site, model, trajectory
├── rockets/              # Rocket designs (JSON) and motors (.eng)
│   └── validation/       # OpenRocket's flights of the same designs
├── scripts/              # CLIs: build F1 replays, simulate and validate rockets
├── tests/                # Simulator, dispersion and API tests
├── seed/replays/         # Replays baked into the deploy image
├── docs/data-format.md   # Replay data format specification
└── data/                 # Cache and generated replays (not committed)
```

## Getting started

### Requirements
- **Python 3.12** (3.14 is not yet supported by the pandas/PyArrow versions FastF1 needs)

### Setup

```bash
git clone https://github.com/vhittuvalli/telemetry_platform.git
cd telemetry_platform

python3.12 -m venv .venv
source .venv/bin/activate

pip install -r requirements-dev.txt   # runtime deps + Jupyter for the notebooks
pip install -e .
```

`requirements.txt` holds only what the server needs; `requirements-dev.txt` adds
the notebook tooling on top.

### Build a replay

The easiest way is from the viewer: click the session name at the top of the
screen to open the race picker. It lists every season, event and session
FastF1 has telemetry for (2018 onward). Click a session that isn't built yet
and the backend downloads and processes it in the background (a few minutes;
one build at a time). Built sessions show ▶ and open straight away.

You can also build from the command line:

```bash
python scripts/build_replay.py 2024 Monza R
```

Arguments: `year`, `event` (name or round number), and `session_type` (`R` race,
`Q` qualifying, `S` sprint, `SQ`/`SS` sprint qualifying/shootout, `FP1`–`FP3`
practice). Use quotes for names with spaces:

```bash
python scripts/build_replay.py 2024 "Las Vegas" R
```

The first run downloads the session from FastF1 (this can take a few minutes);
later runs use the local cache in `data/cache/`. The replay is saved to
`data/replays/` as three files named after the official event name, e.g.
`italian_grand_prix_2024_r.parquet`, `.meta.json` and `.laps.json`.

## Deployment

The `Dockerfile` builds a single image: the Angular app is compiled and served by
FastAPI alongside the API, so there is one service on one port and no CORS setup.
Replays in `seed/replays/` are baked into the image, so a fresh deploy has
sessions to watch before anything is built.

### Render (free)

`render.yaml` is a Render Blueprint. In the Render dashboard choose
**New → Blueprint**, pick this repo, and apply. Every push to `main` redeploys.

The free plan has 512 MB of RAM, sleeps after 15 minutes idle (the next visit
takes about a minute to wake it), and has no persistent disk. On-demand builds
don't fit in that memory, so the blueprint sets `ALLOW_BUILDS=false` and the
race picker only lists the seeded replays. To publish a new session, build it
locally, copy its three files into `seed/replays/`, and push.

### Anywhere else

```bash
docker build -t telemetry-platform .
docker run -p 8000:8000 -v telemetry-data:/data telemetry-platform
```

Then open http://localhost:8000. Mount a persistent volume at `/data`: it holds
the FastF1 cache and built replays, which are slow to recreate.

| Variable             | Default                  | Purpose                                              |
|----------------------|--------------------------|------------------------------------------------------|
| `PORT`               | `8000`                   | Port uvicorn listens on (most hosts set this)        |
| `TELEMETRY_DATA_DIR` | `/data`                  | FastF1 cache and replay files                        |
| `ALLOW_BUILDS`       | `true`                   | `false` hides the FastF1 catalog and rejects builds  |
| `REPLAY_CACHE_SIZE`  | `4`                      | Replays kept in memory (use 2 on a 512 MB host)      |
| `ALLOW_MONTE_CARLO`  | same as `ALLOW_BUILDS`   | `false` turns off Monte Carlo runs on request         |
| `MONTE_CARLO_WORKERS`| CPU count                | Processes for Monte Carlo runs                       |
| `CORS_ORIGINS`       | `http://localhost:4200`  | Comma-separated origins, only if the frontend is hosted separately |

Notes:
- Run **one** instance with one worker. Build jobs and replay caches live in
  process memory, so they aren't shared across workers or replicas.
- `GET /health` is the health check endpoint.
- With builds on, anyone who can reach the site can start one (`POST /builds`),
  which downloads from FastF1 and uses a lot of CPU and memory. Builds run one
  at a time, but the queue has no limit.

## Rocket flights

Rocket designs live in `rockets/` as JSON (geometry, masses, motor, parachutes and
default launch conditions), with motor thrust curves in `rockets/motors/` in the
standard RASP `.eng` format. Simulate one and save it as a replay:

```bash
python scripts/simulate_rocket.py rockets/dual_parachute_deployment.json
python scripts/simulate_rocket.py rockets/chute_release.json --wind 6 --wind-from 270 --angle 5
python scripts/simulate_rocket.py rockets/chute_release.json --monte-carlo 500   # landing zone
```

From the viewer, **Change launch…** on a rocket flight re-simulates it with another
motor (any that fits the motor mount), wind or rail angle. Those flights are kept in
the server's memory, not saved.

### Validation against OpenRocket

The simulator follows the methods OpenRocket documents (Barrowman stability, skin
friction, pressure and base drag). `rockets/validation/` holds OpenRocket 23.09's own
flights of four of its example designs (Estes A8 up to AeroTech H669N); the tests
check we agree with them:

| Design (motor)                   | Apogee, ours vs OpenRocket | Max speed |
|----------------------------------|----------------------------|-----------|
| A simple model rocket (A8)       | 50.4 m vs 50.6 m (−0.3%)   | −0.0%     |
| Presets (D12)                    | 304 m vs 309 m (−1.5%)     | −0.2%     |
| Chute release (G40W)             | 307 m vs 307 m (−0.2%)     | −0.1%     |
| Dual parachute deployment (H669N)| 596 m vs 592 m (+0.6%)     | +0.1%     |

Compare any OpenRocket design yourself (needs Java, `requirements-dev.txt` and the
[OpenRocket 23.09 jar](https://github.com/openrocket/openrocket/releases/tag/release-23.09)):

```bash
python scripts/openrocket_export.py my_rocket.ork --jar OpenRocket-23.09.jar
python scripts/validate_rocket.py rockets/my_rocket.json
```

Limits: subsonic only (the panel warns above Mach 0.8); single stage and one motor;
trapezoidal fins, no transitions, tube or freeform fins (the exporter warns when a
design has parts it can't model aerodynamically); no roll.

## Tests

```bash
pip install -r requirements-dev.txt
python -m pytest tests
```

## Data format

Replays use a long format: one row per car per sample, with time in seconds and
positions in meters. See [docs/data-format.md](docs/data-format.md) for the full
specification.

## Roadmap

1. ✅ Data pipeline: FastF1 → standardized race replay
2. ✅ Backend API (FastAPI)
3. ✅ 3D replay viewer (Angular + three.js)
4. ✅ Deployment (Docker, Render)
5. ✅ Rocket simulator, launch scene, Monte Carlo landing zones, re-simulation
6. Next: live telemetry over UDP, then uploads

## Disclaimer

This is an unofficial, non-commercial fan project. It is not associated with or
endorsed by Formula 1 or any of its companies. Data is accessed through the
open-source FastF1 library.

## License

[MIT](LICENSE)