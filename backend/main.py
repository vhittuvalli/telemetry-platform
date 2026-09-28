import os
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI

from backend.routers import catalog, live, replays, rockets
"""don't store replay endpoints here use a
router so its easier to compile in main.py"""

from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.staticfiles import StaticFiles

#comma separated; only needed when the frontend is served from a different origin (e.g. ng serve)
CORS_ORIGINS = os.environ.get("CORS_ORIGINS", "http://localhost:4200").split(",")
#built Angular app; served at / when present so one container runs the whole site
FRONTEND_DIR = Path(os.environ.get("FRONTEND_DIR", Path(__file__).resolve().parent.parent / "frontend/dist/frontend/browser"))

@asynccontextmanager
async def lifespan(app: FastAPI):
    udp = await live.start_udp()
    yield
    if udp:
        udp.close()


app = FastAPI(title="Telemetry Platform API", lifespan=lifespan)
app.include_router(replays.router)
app.include_router(catalog.catalog_router)
app.include_router(catalog.builds_router)
app.include_router(rockets.router)
app.include_router(live.router)
app.add_middleware(GZipMiddleware, minimum_size=1000) #compress API responses

app.add_middleware(
    CORSMiddleware,
    allow_origins=[origin.strip() for origin in CORS_ORIGINS if origin.strip()], #allow angular access
    allow_methods=["GET", "POST"], #POST starts replay builds
    allow_headers=["*"],
)

#health endpoint can be stored here because it is unrelated to anything else
@app.get("/health")
def health():
    return {"status": "ok"}


#mounted last so the API routes above take priority
if FRONTEND_DIR.is_dir():
    app.mount("/", StaticFiles(directory=FRONTEND_DIR, html=True), name="frontend")
