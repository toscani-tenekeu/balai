#!/usr/bin/env bash
# Installs or upgrades Balai on a Debian or Ubuntu server.
#
#   sudo bash install.sh
#
# Optional settings, given as environment variables:
#   BALAI_DIR   where to install            (default /opt/balai)
#   BALAI_HOST  address to listen on        (default 0.0.0.0)
#   BALAI_PORT  port to listen on           (default 7070)
#   BALAI_URL   public address, if you put Balai behind a domain name
set -euo pipefail

REPO="https://github.com/toscani-tenekeu/balai.git"
DIR="${BALAI_DIR:-/opt/balai}"
HOST="${BALAI_HOST:-0.0.0.0}"
PORT="${BALAI_PORT:-7070}"
URL="${BALAI_URL:-}"

say() { printf '\n==> %s\n' "$1"; }
die() { printf 'Error: %s\n' "$1" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "run this script as root (sudo bash install.sh)."
command -v apt-get >/dev/null || die "Balai supports Debian, Ubuntu and their derivatives only."
command -v systemctl >/dev/null || die "systemd is required."

say "Installing required packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get install -y -q git curl unzip ca-certificates

if ! command -v bun >/dev/null; then
  say "Installing Bun"
  curl -fsSL https://bun.sh/install | BUN_INSTALL=/usr/local bash
fi
BUN="$(command -v bun)"

if [ -d "$DIR/.git" ]; then
  say "Updating $DIR"
  git -C "$DIR" pull --ff-only
else
  say "Downloading Balai to $DIR"
  git clone "$REPO" "$DIR"
fi

say "Building the interface"
cd "$DIR"
"$BUN" run build

say "Setting up the service"
cat > /etc/systemd/system/balai.service <<UNIT
[Unit]
Description=Balai server care panel
After=network.target

[Service]
Type=simple
WorkingDirectory=$DIR
ExecStart=$BUN server/index.ts
Environment=BALAI_HOST=$HOST
Environment=BALAI_PORT=$PORT
Environment=BALAI_URL=$URL
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable --quiet balai
systemctl restart balai

for _ in $(seq 1 20); do
  [ -f "$DIR/data/first-run.txt" ] && break
  systemctl is-active --quiet balai || true
  sleep 0.5
done

echo
if [ -f "$DIR/data/first-run.txt" ]; then
  cat "$DIR/data/first-run.txt"
else
  echo "Balai is running on port $PORT. Sign in with your existing password."
fi
