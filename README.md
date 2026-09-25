# Telemetry Platform

A web platform for replaying and analyzing vehicle telemetry in 3D, starting with
real Formula 1 race data. Pick a race, watch every car on track in a 3D replay,
follow any driver, and explore synchronized charts and metrics.

> **Status:** early development. The data pipeline is complete: it turns a full
> F1 race into a single replay file with every car on a shared clock. The backend
> API and 3D viewer are in progress.

## Features

**Available now**
- Load any F1 session available through [FastF1](https://github.com/theOehrly/Fast-F1)
  (detailed telemetry from 2018 onward)
- Merge each car's position and sensor data into one timeline
- Place every car on a single shared session clock
- Export a full race replay to Parquet with one command

**Planned**
- FastAPI backend serving replay data
- 3D replay viewer (Angular + three.js): all cars on track, driver cameras,
  playback controls, leaderboard
- Synchronized charts (speed, throttle, brake) and live metrics
- Race catalog, file uploads, and a rocket flight simulator on the same engine

## Tech stack

- **Data:** Python 3.12, FastF1, pandas, PyArrow (Parquet)
- **Backend (planned):** FastAPI
- **Frontend (planned):** Angular, three.js

## Project structure

```
telemetry_platform/
├── telemetry/          # Python package: data loading and processing
│   └── f1.py           # FastF1 pipeline: load, merge, standardize, export
├── scripts/
│   └── build_replay.py # CLI to build a replay file for a session
├── notebooks/          # Exploration and verification
├── docs/
│   └── data-format.md  # Replay data format specification
├── data/               # Cache and generated replays (not committed)
├── pyproject.toml
└── requirements.txt
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

pip install -r requirements.txt
pip install -e .
```

### Build a race replay

```bash
python scripts/build_replay.py 2024 Monza R
```

Arguments: `year`, `event`, and `session_type` (`R` race, `Q` qualifying,
`S` sprint, `FP1`–`FP3` practice). Use quotes for names with spaces:

```bash
python scripts/build_replay.py 2024 "Las Vegas" R
```

The first run downloads the session from FastF1 (this can take a few minutes);
later runs use the local cache in `data/cache/`. The replay is saved to
`data/replays/`, e.g. `monza_2024_r.parquet`.

## Data format

Replays use a long format: one row per car per sample, with time in seconds and
positions in meters. See [docs/data-format.md](docs/data-format.md) for the full
specification.

## Roadmap

1. ✅ Data pipeline: FastF1 → standardized race replay
2. ⏳ Backend API (FastAPI)
3. ⏳ 3D replay viewer (Angular + three.js)
4. ⏳ Deployment
5. Later: race catalog, uploads, rocket simulator

## Disclaimer

This is an unofficial, non-commercial fan project. It is not associated with or
endorsed by Formula 1 or any of its companies. Data is accessed through the
open-source FastF1 library.

## License

[MIT](LICENSE)