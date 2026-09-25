from fastapi import FastAPI

from backend.routers import replays
"""don't store replay endpoints here use a 
router so its easier to compile in main.py"""

app = FastAPI(title="Telemetry Platform API")
app.include_router(replays.router)

#health endpoint can be stored here because it is unrelated to anything else
@app.get("/health")
def health():
    return {"status": "ok"}