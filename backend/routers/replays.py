from functools import lru_cache
import os
import threading
import pandas as pd
from fastapi import APIRouter, HTTPException, Query
from telemetry.f1 import REPLAYS_DIR, load_replay
import json

#establish endpoint formatting
router = APIRouter(prefix="/replays", tags=["replays"])
#max window from start to end time (seconds)
MAX_WINDOW_S = 300
#replays held in memory; a race is roughly 40 MB of data plus pandas overhead, so lower this on small hosts
REPLAY_CACHE_SIZE = int(os.environ.get("REPLAY_CACHE_SIZE", 4))
#windows serialized at once; the viewer requests a whole session in parallel, which can exhaust a small host's memory
DATA_CONCURRENCY = int(os.environ.get("DATA_CONCURRENCY", 2))

_load_lock = threading.Lock()
_data_slots = threading.BoundedSemaphore(DATA_CONCURRENCY)


@lru_cache(maxsize=REPLAY_CACHE_SIZE)
def _load(replay_id: str) -> pd.DataFrame:
    path = REPLAYS_DIR / f"{replay_id}.parquet"
    #check if replay exists
    if not path.exists():
        raise HTTPException(status_code=404, detail=f"Replay '{replay_id}' not found")
    return load_replay(path)


def get_replay(replay_id: str) -> pd.DataFrame:
    """Load a replay once and keep it in memory. (utilize LRU cache)"""
    #lru_cache doesn't stop parallel misses from each loading the same file
    with _load_lock:
        return _load(replay_id)


def column_to_list(series: pd.Series) -> list:
    """Convert a column to a JSON-safe list, with missing values as None."""
    return series.astype(object).where(series.notna(), None).tolist()

def built_replays() -> list[dict]:
    """Every fully built replay, newest session first."""
    summaries = []
    for meta_path in REPLAYS_DIR.glob("*.meta.json"):
        replay_id = meta_path.name.removesuffix(".meta.json")
        if not (REPLAYS_DIR / f"{replay_id}.parquet").exists():
            continue
        meta = read_json(replay_id, ".meta.json")
        domain = meta.get("domain", "f1") #replays built before domains existed are F1
        #F1 builds write the laps file last, so its presence means the build finished
        if domain == "f1" and not (REPLAYS_DIR / f"{replay_id}.laps.json").exists():
            continue
        session = meta["session"]
        summaries.append({
            "id": replay_id,
            "domain": domain,
            "year": session["year"],
            "event": session["event"],
            "location": session["location"],
            "session": session["name"],
            "date": session["date"],
        })
    return sorted(summaries, key=lambda s: s["date"] or "", reverse=True)


@router.get("")
def list_replays():
    # list all replay sessions that are ready to watch
    return built_replays()

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
    #small tolerance: clients stepping in MAX_WINDOW_S chunks hit float rounding (e.g. 300.0000000000002)
    if end - start > MAX_WINDOW_S + 1e-6:
        raise HTTPException(status_code=400, detail=f"Window cannot exceed {MAX_WINDOW_S} seconds")

    replay = get_replay(replay_id)
    with _data_slots:
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