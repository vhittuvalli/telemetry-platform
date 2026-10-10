# Self-hosting with public UDP

Render and similar web hosts only pass HTTP, so live telemetry over UDP can't reach them;
senders there need `scripts/telemetry_relay.py` or a WebSocket. To let **anyone** send UDP
straight to the site (a flight computer's ground station, a game, a microcontroller), run
it on a machine with a public IP. This setup runs the whole site there: the app, HTTPS
through Caddy, and UDP on port 9870.

The free option is an **Oracle Cloud Always Free** VM. It costs nothing, but signing up asks
for a card to verify your identity. Any other VPS works the same way from step 3.

## 1. Create the VM

1. Sign up at [cloud.oracle.com](https://cloud.oracle.com) and pick a home region (Always
   Free resources only exist there).
2. **Compute → Instances → Create instance**:
   - Image: **Ubuntu 24.04**
   - Shape: **Ampere VM.Standard.A1.Flex**, 2 OCPUs and 12 GB (free up to 4 OCPUs / 24 GB).
     If it says "out of capacity", try another availability domain or try again later.
   - Add your SSH public key, and keep "Assign a public IPv4 address" on.
3. Note the instance's public IP.

Always Free accounts can have idle VMs reclaimed. Upgrading the account to Pay As You Go
stops that, and it stays free as long as you only use Always Free resources.

## 2. Open the ports

**Networking → Virtual cloud networks →** your VCN **→ Security Lists → Default → Add
Ingress Rules**, source `0.0.0.0/0`:

| Protocol | Destination port | For                |
|----------|------------------|--------------------|
| TCP      | 80               | HTTPS certificates |
| TCP      | 443              | the site           |
| UDP      | 9870             | live telemetry     |

(The VM's own firewall is opened by the setup script.)

## 3. Install and start

```bash
ssh ubuntu@<public-ip>
git clone https://github.com/<you>/telemetry_platform.git && cd telemetry_platform
bash deploy/setup-vm.sh
```

The script installs Docker, opens ports 80, 443 and 9870/udp in the VM's firewall, and starts
the site at `https://<ip-with-dashes>.sslip.io`. [sslip.io](https://sslip.io) is a free DNS
name that points at the IP, so you don't need to buy a domain. To use your own domain, point
its DNS at the VM and run `DOMAIN=telemetry.example.com bash deploy/setup-vm.sh`. The first
build takes several minutes.

To update later: `git pull && bash deploy/setup-vm.sh`.

## 4. Send

```bash
python scripts/stream_rocket.py rockets/chute_release.json --site https://<ip-with-dashes>.sslip.io
```

With no `--udp` flag, the streamer sends UDP to the site's own port 9870. Any other sender
registers a session with `POST /live/sessions` and sends datagrams to `<site host>:9870`
(docs/live-protocol.md).

## Security

Anyone can start a session and send packets, so the server limits what one sender can do:

| Limit | Default | Setting |
|-------|---------|---------|
| Open live sessions per IP | 3 | `LIVE_MAX_SESSIONS_PER_IP` |
| Sessions started per IP | 6 at once, then one every 2 minutes | |
| Live sessions on the server | 20 | |
| Demo streams on the server | 3 | `LIVE_MAX_DEMOS` |
| Packets per second per IP (UDP and WebSocket) | 500, bursts of 1,000 | `LIVE_PACKETS_PER_IP` |
| Packets per second, whole server | 5,000 | `LIVE_PACKETS_TOTAL` |
| UDP datagram / WebSocket message | 8 KB / 64 KB | |
| HTTP request body (session metadata: 256 KB) | 1 MB | |
| Viewers per session | 100 | `LIVE_MAX_WATCHERS` |
| Live recordings kept on disk (oldest deleted) | 100 | `LIVE_RECORDINGS_KEPT` |

- **No reflection attacks.** A UDP source address can be forged. The server replies only to
  rejected packets, never with more bytes than the packet it got, and to at most a few per
  second per address. So it can't be used to flood someone else.
- **Session keys** are 128-bit random secrets compared in constant time. Codes are public
  (they're how viewers find a session); keys are what authorize sending.
- **Client IPs can be trusted.** Only Caddy can reach the app's HTTP port (it isn't
  published), so the forwarded client IP used for rate limits can't be faked through headers.
- **Containers** run as a non-root user with no Linux capabilities, `no-new-privileges`
  and memory and process limits. Caddy adds HSTS and other security headers.
- **UDP is not encrypted.** Anyone on the network path can read packets, including the
  session key. That's fine for telemetry, but it isn't a secure channel. Senders that need
  privacy should use the WebSocket over `wss://`.
