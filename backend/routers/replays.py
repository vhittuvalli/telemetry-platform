from functools import lru_cache
import pandas as pd
from fastapi import APIRouter, HTTPException, Query
from telemetry.f1 import REPLAYS_DIR, load_replay
import json

#establish endpoint formatting
router = APIRouter(prefix="/replays", tags=["replays"])
#max window from start to end time (seconds)
MAX_WINDOW_S = 300

@lru_cache(maxsize=4)
def get_replay(replay_id: str) -> pd.DataFrame:
    """Load a replay once and keep it in memory. (utilize LRU cache)"""
    path = REPLAYS_DIR / f"{replay_id}.parquet"
    #check if replay exists
    if not path.exists():
        raise HTTPException(status_code=404, detail=f"Replay '{replay_id}' not found")
    return load_replay(path)


def column_to_list(series: pd.Series) -> list:
    """Convert a column to a JSON-safe list, with missing values as None."""
    return series.astype(object).where(series.notna(), None).tolist()

@router.get("")
def list_replays():
    # list all possible replay sessions that can be used
    files = sorted(REPLAYS_DIR.glob("*.parquet"))
    return [{"id": path.stem} for path in files]

@router.get("/{replay_id}/data")
def get_replay_data(
    replay_id: str,
    start: float = Query(0, description="Window start, in seconds"),
    end: float = Query(60, description="Window end, in seconds"),
):
    """Return every vehicle's telemetry between start and end, grouped by vehicle."""
    #make sure start is before end and window isn't too big
    if end <= start:
        raise HTTPException(status_code=400, detail="'end' must be greater than 'start'")
    if end - start > MAX_WINDOW_S:
        raise HTTPException(status_code=400, detail=f"Window cannot exceed {MAX_WINDOW_S} seconds")

    replay = get_replay(replay_id)
    window = replay[(replay["time"] >= start) & (replay["time"] < end)]

    #group by driver
    vehicles = {}
    for vehicle_id, rows in window.groupby("vehicle_id"):
        vehicles[vehicle_id] = {
            col: column_to_list(rows[col]) for col in rows.columns if col != "vehicle_id"
        }

    return {"replay_id": replay_id, "start": start, "end": end, "vehicles": vehicles}

def replay_file(replay_id: str, suffix: str):
    """Path to one of a replay's files, or a 404 if it doesn't exist."""
    path = REPLAYS_DIR / f"{replay_id}{suffix}"
    if not path.exists():
        raise HTTPException(status_code=404, detail=f"No {suffix} file for replay '{replay_id}'")
    return path


@lru_cache(maxsize=8)
def read_json(replay_id: str, suffix: str):
    """Load a replay's JSON file once and keep it in memory."""
    return json.loads(replay_file(replay_id, suffix).read_text())


@router.get("/{replay_id}/meta")
def get_replay_meta(replay_id: str):
    """Session info, drivers, time range, and track outline."""
    return read_json(replay_id, ".meta.json")


@router.get("/{replay_id}/laps")
def get_replay_laps(replay_id: str, driver: str | None = None):
    """Lap-by-lap data for every driver, optionally filtered to one driver."""
    laps = read_json(replay_id, ".laps.json")
    if driver is not None:
        laps = [lap for lap in laps if lap["driver"] == driver]
    return laps