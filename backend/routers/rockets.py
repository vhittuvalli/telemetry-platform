"""Rocket designs and motors, and flights simulated on request with chosen motor and launch conditions."""

import hashlib
import json
import os
import threading
from dataclasses import replace

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from backend import simulations
from telemetry.rocket import catalog, dispersion
from telemetry.rocket.flight import load_launch, simulate
from telemetry.rocket.replay import flight_frame, flight_metadata
from telemetry.rocket.rocket import load_rocket

router = APIRouter(prefix="/rockets", tags=["rockets"])

#Monte Carlo flies hundreds of rockets; off wherever replay builds are off (small hosts)
MONTE_CARLO_ENABLED = os.environ.get(
    "ALLOW_MONTE_CARLO", os.environ.get("ALLOW_BUILDS", "true")).lower() not in ("0", "false", "no")
MAX_RUNS = 500
MONTE_CARLO_WORKERS = int(os.environ.get("MONTE_CARLO_WORKERS", os.cpu_count() or 1))

#one simulation at a time keeps memory and CPU bounded
_busy = threading.Lock()


@router.get("")
def list_rockets():
    return catalog.rockets()


@router.get("/motors")
def list_motors():
    return catalog.motors()


@router.get("/config")
def rocket_config():
    return {"monte_carlo": MONTE_CARLO_ENABLED, "max_runs": MAX_RUNS}


class SimulationRequest(BaseModel):
    rocket: str
    motor: str | None = None               # .eng file in rockets/motors; default: the design's own
    ejection_delay: float | None = Field(None, ge=0, le=30)
    wind_speed: float = Field(0, ge=0, le=20)       # m/s
    wind_from: float = Field(0, ge=0, lt=360)       # compass degrees
    angle: float = Field(0, ge=0, le=20)            # rail tilt from vertical, degrees
    heading: float = Field(0, ge=0, lt=360)         # compass degrees the rail tilts toward
    monte_carlo: int = Field(0, ge=0, le=MAX_RUNS)  # varied runs for a landing zone


@router.post("/simulate")
def simulate_flight(req: SimulationRequest):
    """Fly a design with the chosen motor and conditions; returns a replay id the /replays endpoints serve."""
    if req.monte_carlo and not MONTE_CARLO_ENABLED:
        raise HTTPException(status_code=403, detail="Monte Carlo runs are turned off on this server")

    flight_id = "sim_" + hashlib.sha1(json.dumps(req.model_dump(), sort_keys=True).encode()).hexdigest()[:12]
    if simulations.get(flight_id):
        return {"replay_id": flight_id}

    try:
        path = catalog.rocket_path(req.rocket)
        rocket = load_rocket(path)
        if req.motor:
            delay = req.ejection_delay if req.ejection_delay is not None else rocket.ejection_delay
            rocket = catalog.with_motor(rocket, req.motor, delay)
        elif req.ejection_delay is not None:
            rocket = replace(rocket, ejection_delay=req.ejection_delay)
    except FileNotFoundError as err:
        raise HTTPException(status_code=404, detail=str(err))
    except ValueError as err:
        raise HTTPException(status_code=422, detail=str(err))

    launch = replace(load_launch(path), wind_speed=req.wind_speed, wind_from=req.wind_from,
                     angle=req.angle, heading=req.heading, site_name="Custom launch")

    with _busy:
        try:
            flight = simulate(rocket, launch)
        except ValueError as err:  # e.g. the motor can't lift the rocket
            raise HTTPException(status_code=422, detail=str(err))
        spread = (dispersion.run(rocket, launch, runs=req.monte_carlo, workers=MONTE_CARLO_WORKERS)
                  if req.monte_carlo else None)

    meta = flight_metadata(rocket, launch, flight, rocket_id=req.rocket,
                           name=f"{rocket.motor.designation} flight · custom")
    meta["custom"] = req.model_dump()
    if spread:
        meta["dispersion"] = {k: v for k, v in spread.items() if k not in ("landings", "apogees")}
    simulations.put(flight_id, flight_frame(flight), meta, spread)
    return {"replay_id": flight_id}
