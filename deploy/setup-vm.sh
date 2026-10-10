#!/usr/bin/env bash
# One-time setup on a fresh Ubuntu VM (Oracle Cloud Always Free, or any VPS), then start the site.
#
#   git clone <this repo> telemetry_platform && cd telemetry_platform
#   bash deploy/setup-vm.sh
#
# Safe to run again: it only adds what's missing, then rebuilds and restarts.
set -euo pipefail
cd "$(dirname "$0")"

if ! command -v docker >/dev/null; then
  curl -fsSL https://get.docker.com | sudo sh
  sudo usermod -aG docker "$USER"
fi

# Oracle's Ubuntu images drop everything but SSH in iptables, even with the cloud firewall open
if sudo iptables -L INPUT -n | grep -q "REJECT"; then
  for rule in "-p tcp --dport 80" "-p tcp --dport 443" "-p udp --dport 9870"; do
    sudo iptables -C INPUT $rule -j ACCEPT 2>/dev/null || sudo iptables -I INPUT 5 $rule -j ACCEPT
  done
  sudo apt-get install -y iptables-persistent >/dev/null && sudo netfilter-persistent save
fi

if [ -z "${DOMAIN:-}" ]; then
  ip=$(curl -fsS https://api.ipify.org)
  DOMAIN="${ip//./-}.sslip.io"   # resolves to this machine's IP; no domain to buy
fi
echo "DOMAIN=$DOMAIN" > .env
sudo docker compose up -d --build
echo "Site: https://$DOMAIN   Live UDP: $DOMAIN:9870"
