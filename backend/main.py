from fastapi import FastAPI

from backend.routers import replays
"""don't store replay endpoints here use a 
router so its easier to compile in main.py"""

from fastapi.middleware.cors import CORSMiddleware

app = FastAPI(title="Telemetry Platform API")
app.include_router(replays.router)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:4200"], #allow angular access
    allow_methods=["GET"],
    allow_headers=["*"],
)

#health endpoint can be stored here because it is unrelated to anything else
@app.get("/health")
def health():
    return {"status": "ok"}