"""What FastF1 can offer (seasons, events, sessions) and on-demand replay builds."""

import os
import time
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from backend import builds
from backend.routers.replays import built_replays
from telemetry.f1 import FIRST_TELEMETRY_YEAR, get_schedule, replay_id

catalog_router = APIRouter(prefix="/catalog", tags=["catalog"])
builds_router = APIRouter(prefix="/builds", tags=["builds"])

#schedules rarely change, but the current season's can (postponements), so refresh occasionally
SCHEDULE_TTL_S = 6 * 3600
#live timing data usually lands within an hour of a session ending; leave room for long races
DATA_DELAY = timedelta(hours=4)

#builds download and process whole sessions; turn them off on small hosts that can't afford the memory
BUILDS_ENABLED = os.environ.get("ALLOW_BUILDS", "true").lower() not in ("0", "false", "no")

_schedules: dict[int, tuple[float, list[dict]]] = {}


def utc_now() -> datetime:
    """Naive UTC, to compare with FastF1's naive *DateUtc values."""
    return datetime.now(timezone.utc).replace(tzinfo=None)


def seasons() -> list[int]:
    return list(range(utc_now().year, FIRST_TELEMETRY_YEAR - 1, -1))


def schedule(year: int) -> list[dict]:
    """The season's events from FastF1, cached in memory."""
    if year not in seasons():
        raise HTTPException(
            status_code=404,
            detail=f"FastF1 has telemetry for {FIRST_TELEMETRY_YEAR}–{seasons()[0]} only",
        )
    cached = _schedules.get(year)
    if cached and time.time() - cached[0] < SCHEDULE_TTL_S:
        return cached[1]
    try:
        events = get_schedule(year)
    except Exception as err:
        raise HTTPException(status_code=502, detail=f"Could not load the {year} schedule from FastF1: {err}")
    _schedules[year] = (time.time(), events)
    return events


def session_status(year: int, event: dict, session: dict, built: dict, active: dict) -> tuple[str, str]:
    """(status, replay id) for one session: built, building, available or upcoming."""
    built_id = built.get((year, event["name"], session["name"]))
    if built_id:
        return "built", built_id
    rid = replay_id(year, event["name"], session["code"])
    if rid in active:
        return "building", rid
    start = session["date_utc"]
    if start is None or datetime.fromisoformat(start) + DATA_DELAY > utc_now():
        return "upcoming", rid
    return "available", rid


@catalog_router.get("/seasons")
def list_seasons():
    return seasons()


@catalog_router.get("/{year}")
def get_season(year: int):
    """Every event in a season with each session's build status."""
    built = {(r["year"], r["event"], r["session"]): r["id"] for r in built_replays()}
    active = builds.active_builds()

    events = []
    for event in schedule(year):
        sessions = []
        for session in event["sessions"]:
            status, rid = session_status(year, event, session, built, active)
            sessions.append({
                **session,
                "status": status,
                "replay_id": rid,
                "build_id": active[rid]["id"] if status == "building" else None,
            })
        events.append({**event, "sessions": sessions})
    return events


class BuildRequest(BaseModel):
    year: int
    round: int
    session: str  # session code, e.g. "R" or "FP1"


@builds_router.get("/config")
def build_config():
    return {"enabled": BUILDS_ENABLED}


@builds_router.post("", status_code=202)
def start_build(req: BuildRequest):
    """Download a session from FastF1 and build its replay in the background."""
    if not BUILDS_ENABLED:
        raise HTTPException(status_code=403, detail="Replay builds are turned off on this server")
    event = next((e for e in schedule(req.year) if e["round"] == req.round), None)
    if event is None:
        raise HTTPException(status_code=404, detail=f"No round {req.round} in {req.year}")
    session = next((s for s in event["sessions"] if s["code"] == req.session.upper()), None)
    if session is None:
        raise HTTPException(status_code=404, detail=f"{event['name']} has no '{req.session}' session")

    built = {(r["year"], r["event"], r["session"]): r["id"] for r in built_replays()}
    status, rid = session_status(req.year, event, session, built, builds.active_builds())
    if status == "built":
        raise HTTPException(status_code=409, detail=f"Replay '{rid}' is already built")
    if status == "upcoming":
        raise HTTPException(status_code=409, detail="This session's data isn't available yet")

    return builds.start_build(req.year, req.round, session["code"], rid)


@builds_router.get("/{build_id}")
def get_build(build_id: str):
    job = builds.get_build(build_id)
    if job is None:
        raise HTTPException(status_code=404, detail=f"Build '{build_id}' not found")
    return job
