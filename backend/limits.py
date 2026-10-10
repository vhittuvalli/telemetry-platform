"""Rate and size limits that keep a public server usable when anyone can send to it."""

import os
import time


def env_int(name: str, default: int) -> int:
    value = os.environ.get(name, "")
    return int(value) if value.strip() else default


class RateLimiter:
    """A token bucket per key (usually a client IP): `rate` per second, bursts up to `burst`."""

    def __init__(self, rate: float, burst: float, max_keys: int = 10_000):
        self.rate, self.burst, self.max_keys = rate, burst, max_keys
        self.buckets: dict[str, tuple[float, float]] = {}  # key -> (tokens, when)

    def allow(self, key: str = "", cost: float = 1.0) -> bool:
        now = time.monotonic()
        tokens, then = self.buckets.get(key, (self.burst, now))
        tokens = min(self.burst, tokens + (now - then) * self.rate)
        allowed = tokens >= cost
        self.buckets[key] = (tokens - cost if allowed else tokens, now)
        if len(self.buckets) > self.max_keys:
            self._forget_full(now)
        return allowed

    def _forget_full(self, now: float) -> None:
        # A bucket that has refilled is the same as a new one, so it needn't be kept
        full = [k for k, (tokens, then) in self.buckets.items()
                if tokens + (now - then) * self.rate >= self.burst]
        for k in full:
            del self.buckets[k]
        if len(self.buckets) > self.max_keys:  # still flooded with distinct senders: start over
            self.buckets.clear()


class BodySizeLimit:
    """ASGI middleware: refuse HTTP request bodies over `max_bytes` (413)."""

    def __init__(self, app, max_bytes: int):
        self.app, self.max_bytes = app, max_bytes

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        length = dict(scope["headers"]).get(b"content-length")
        if length is not None and length.isdigit() and int(length) > self.max_bytes:
            return await self._too_large(send)

        received = 0

        async def limited_receive():
            nonlocal received
            message = await receive()
            if message["type"] == "http.request":
                received += len(message.get("body", b""))
                if received > self.max_bytes:
                    raise _TooLarge()
            return message

        try:
            await self.app(scope, limited_receive, send)
        except _TooLarge:
            await self._too_large(send)

    @staticmethod
    async def _too_large(send):
        body = b'{"detail":"Request body too large"}'
        await send({"type": "http.response.start", "status": 413,
                    "headers": [(b"content-type", b"application/json"), (b"content-length", str(len(body)).encode())]})
        await send({"type": "http.response.body", "body": body})


class _TooLarge(Exception):
    pass
