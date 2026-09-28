# One image for the whole site: FastAPI serves the API and the built Angular app.

# --- frontend build ---
FROM node:22-alpine AS frontend
WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npx ng build --configuration production

# --- runtime ---
FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    TELEMETRY_DATA_DIR=/data \
    FRONTEND_DIR=/app/frontend \
    PORT=8000 \
    # hand freed memory back to the OS; PyArrow's default pool holds on to it
    ARROW_DEFAULT_MEMORY_POOL=system \
    MALLOC_ARENA_MAX=2

WORKDIR /app
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY pyproject.toml ./
COPY telemetry/ telemetry/
COPY backend/ backend/
COPY scripts/ scripts/
COPY rockets/ rockets/
COPY --from=frontend /app/frontend/dist/frontend/browser/ frontend/

# FastF1 cache and built replays live here; mount a volume to keep them across deploys
RUN useradd --create-home app && mkdir -p /data && chown app /data
# Replays that ship with the image, so the site has something to show on hosts without persistent storage
COPY --chown=app seed/replays/ /data/replays/
USER app
VOLUME /data

EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
    CMD python -c "import os, urllib.request; urllib.request.urlopen(f'http://localhost:{os.environ[\"PORT\"]}/health')"

# Single worker: build jobs and replay caches are kept in process memory
CMD ["sh", "-c", "exec uvicorn backend.main:app --host 0.0.0.0 --port ${PORT} --workers 1 --proxy-headers --forwarded-allow-ips='*'"]
