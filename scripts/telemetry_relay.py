"""Forward live telemetry from UDP on this machine to a remote platform over a WebSocket.

Web hosts like Render only accept HTTP, so a UDP sender (a flight computer's radio
receiver, the simulator, a game) can't reach them directly. Run this next to the
sender; point the sender at this machine's UDP port and packets reach the site.

    python scripts/telemetry_relay.py --site https://telemetry-platform.onrender.com
    python scripts/stream_rocket.py rockets/chute_release.json --site https://telemetry-platform.onrender.com

Packets are forwarded as-is (they already carry their session code and key).
"""

import argparse
import asyncio
import functools
import json

print = functools.partial(print, flush=True)  # status lines show up immediately, even when piped


class Relay(asyncio.DatagramProtocol):
    def __init__(self, queue: asyncio.Queue):
        self.queue = queue
        self.transport = None

    def connection_made(self, transport):
        self.transport = transport

    def datagram_received(self, data, addr):
        try:
            self.queue.put_nowait((data.decode("utf-8"), addr))
        except (asyncio.QueueFull, UnicodeDecodeError):
            pass  # like UDP itself: drop what can't be carried


async def forward(site: str, queue: asyncio.Queue, relay: Relay) -> None:
    import websockets
    url = site.replace("https://", "wss://").replace("http://", "ws://").rstrip("/") + "/live/ingest"
    forwarded = 0
    while True:
        try:
            async with websockets.connect(url, open_timeout=120, max_queue=None) as ws:
                print(f"Connected to {url}")

                async def replies():
                    async for reply in ws:  # errors from the server go back to the sender
                        if relay.last_addr:
                            relay.transport.sendto(reply.encode() if isinstance(reply, str) else reply, relay.last_addr)
                        if "error" in json.loads(reply):
                            print("server:", reply)

                listener = asyncio.create_task(replies())
                try:
                    while True:
                        text, addr = await queue.get()
                        relay.last_addr = addr
                        await ws.send(text)
                        forwarded += 1
                        if forwarded % 500 == 0:
                            print(f"  forwarded {forwarded} packets")
                finally:
                    listener.cancel()
        except (OSError, websockets.ConnectionClosed, asyncio.TimeoutError) as err:
            print(f"Connection lost ({err}); reconnecting in 2 s")
            await asyncio.sleep(2)


async def main(site: str, port: int) -> None:
    queue: asyncio.Queue = asyncio.Queue(maxsize=5000)
    loop = asyncio.get_running_loop()
    transport, relay = await loop.create_datagram_endpoint(lambda: Relay(queue), local_addr=("0.0.0.0", port))
    relay.last_addr = None
    print(f"Relaying UDP on port {port} to {site}")
    try:
        await forward(site, queue, relay)
    finally:
        transport.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--site", required=True, help="the platform's address, e.g. https://telemetry-platform.onrender.com")
    parser.add_argument("--port", type=int, default=9870, help="UDP port to listen on (default %(default)s)")
    args = parser.parse_args()
    try:
        asyncio.run(main(args.site, args.port))
    except KeyboardInterrupt:
        pass
