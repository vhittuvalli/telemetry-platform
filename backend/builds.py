"""Background replay builds. Jobs live in memory, so they reset when the server restarts."""

import threading
import traceback
import uuid
from concurrent.futures import ThreadPoolExecutor

from telemetry.f1 import build_and_save

#one build at a time: FastF1 downloads are heavy and share one cache
_executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="replay-build")
_lock = threading.Lock()
_jobs: dict[str, dict] = {}


def _update(job_id, **fields):
    with _lock:
        _jobs[job_id].update(fields)


def _run(job_id, year, round_number, session_code):
    _update(job_id, status="running", message="Starting")
    try:
        replay_id = build_and_save(
            year, round_number, session_code,
            progress=lambda msg: _update(job_id, message=msg),
        )
        _update(job_id, status="done", message="Ready", replay_id=replay_id)
    except Exception as err:
        traceback.print_exc()
        _update(job_id, status="failed", message=str(err) or type(err).__name__)


def start_build(year: int, round_number: int, session_code: str, replay_id: str) -> dict:
    """Queue a build, or return the existing job if this session is already queued/running."""
    with _lock:
        for job in _jobs.values():
            if job["replay_id"] == replay_id and job["status"] in ("queued", "running"):
                return dict(job)
        job_id = uuid.uuid4().hex[:12]
        job = {
            "id": job_id,
            "replay_id": replay_id,
            "year": year,
            "round": round_number,
            "session": session_code,
            "status": "queued",
            "message": "Waiting for other builds",
        }
        _jobs[job_id] = job
    _executor.submit(_run, job_id, year, round_number, session_code)
    return dict(job)


def get_build(job_id: str) -> dict | None:
    with _lock:
        job = _jobs.get(job_id)
        return dict(job) if job else None


def active_builds() -> dict[str, dict]:
    """Queued or running jobs, keyed by replay id."""
    with _lock:
        return {
            job["replay_id"]: dict(job)
            for job in _jobs.values()
            if job["status"] in ("queued", "running")
        }
