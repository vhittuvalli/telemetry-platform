from fastapi import APIRouter

from telemetry.f1 import REPLAYS_DIR

#establish endpoint formatting
router = APIRouter(prefix="/replays", tags=["replays"])


@router.get("")
def list_replays():
    # list all possible replay sessions that can be used
    files = sorted(REPLAYS_DIR.glob("*.parquet"))
    return [{"id": path.stem} for path in files]