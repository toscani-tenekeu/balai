#!/usr/bin/env bash
# Installs or upgrades Balai on a Linux server.
#
#   sudo bash install.sh
#
# Works on Debian, Ubuntu, Linux Mint, RHEL, Rocky, AlmaLinux, CentOS Stream,
# Fedora, Oracle Linux, Amazon Linux, openSUSE, Arch, Manjaro and Alpine,
# on x86-64 and ARM64.
#
# Optional settings, given as environment variables:
#   BALAI_DIR   where to install            (default /opt/balai)
#   BALAI_HOST  address to listen on        (default 0.0.0.0)
#   BALAI_PORT  port to listen on           (default 7070)
#   BALAI_URL   public address, if you put Balai behind a domain name
#   BALAI_REPO  where to download Balai from (a git URL or a local copy)
set -euo pipefail

REPO="${BALAI_REPO:-https://github.com/toscani-tenekeu/balai.git}"
DIR="${BALAI_DIR:-/opt/balai}"
HOST="${BALAI_HOST:-0.0.0.0}"
PORT="${BALAI_PORT:-7070}"
URL="${BALAI_URL:-}"

say() { printf '\n==> %s\n' "$1"; }
die() { printf 'Error: %s\n' "$1" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "run this script as root (sudo bash install.sh)."
[ "$(uname -s)" = "Linux" ] || die "Balai runs on Linux only."
case "$(uname -m)" in
  x86_64 | amd64 | aarch64 | arm64) ;;
  *) die "Balai needs a 64-bit x86 or ARM processor; this one is $(uname -m)." ;;
esac

# ---- Packages -------------------------------------------------------------------
# Required: git and curl to download, and the system tools Balai reads from:
# GNU df and du, ps (procps) and ss (iproute2). The extras are optional and only
# add checks: checkupdates and paccache on Arch, needs-restarting on Red Hat.

install_packages() {
  if command -v apt-get >/dev/null; then
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -q
    apt-get install -y -q git curl ca-certificates unzip procps iproute2
  elif command -v dnf >/dev/null || command -v yum >/dev/null; then
    local pm
    pm="$(command -v dnf || command -v yum)"
    # Many images ship curl-minimal, which conflicts with the full curl package; either works.
    command -v curl >/dev/null || "$pm" install -y -q curl
    "$pm" install -y -q git ca-certificates unzip procps-ng iproute findutils which
    "$pm" install -y -q dnf-utils >/dev/null 2>&1 || "$pm" install -y -q yum-utils >/dev/null 2>&1 || true
  elif command -v zypper >/dev/null; then
    zypper --non-interactive --quiet refresh
    zypper --non-interactive --quiet install git curl ca-certificates unzip procps iproute2 which
  elif command -v pacman >/dev/null; then
    # Arch does not support partial upgrades, so the package database is synced with a full upgrade.
    pacman -Syu --noconfirm --needed git curl ca-certificates unzip procps-ng iproute2 which
    pacman -S --noconfirm --needed pacman-contrib fakeroot >/dev/null 2>&1 || true
  elif command -v apk >/dev/null; then
    # GNU coreutils and procps instead of BusyBox's, and the C++ runtime Bun needs on musl.
    apk add --no-cache bash git curl ca-certificates unzip coreutils procps iproute2 libstdc++ libgcc
  else
    die "no supported package manager found (apt, dnf, yum, zypper, pacman or apk)."
  fi
}

say "Installing required packages"
install_packages

# ---- Bun ----------------------------------------------------------------------------

BUN="$(command -v bun || true)"
if [ -z "$BUN" ] && [ -x /usr/local/bin/bun ]; then BUN=/usr/local/bin/bun; fi
if [ -z "$BUN" ]; then
  say "Installing Bun"
  curl -fsSL https://bun.sh/install | BUN_INSTALL=/usr/local bash
  BUN=/usr/local/bin/bun
fi
"$BUN" --version >/dev/null || die "Bun does not run on this system. It needs Linux 5.1 or newer (this one is $(uname -r))."

# ---- Balai --------------------------------------------------------------------------

if [ -d "$DIR/.git" ]; then
  say "Updating $DIR"
  git -C "$DIR" pull --ff-only
else
  say "Downloading Balai to $DIR"
  git clone --depth 50 "$REPO" "$DIR"
fi

say "Building the interface"
cd "$DIR"
"$BUN" run build

# ---- Service ---------------------------------------------------------------------------

if [ -d /run/systemd/system ] && command -v systemctl >/dev/null; then
  say "Setting up the systemd service"
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
  MANAGER=systemd
elif command -v rc-service >/dev/null && [ -d /etc/init.d ]; then
  say "Setting up the OpenRC service"
  cat > /etc/init.d/balai <<RC
#!/sbin/openrc-run
name="Balai"
description="Balai server care panel"
command="$BUN"
command_args="server/index.ts"
command_background=true
directory="$DIR"
pidfile="/run/balai.pid"
output_log="/var/log/balai.log"
error_log="/var/log/balai.log"
export BALAI_HOST="$HOST" BALAI_PORT="$PORT" BALAI_URL="$URL"
supervisor=supervise-daemon
respawn_delay=2

depend() {
  need net
}
RC
  chmod +x /etc/init.d/balai
  rc-update add balai default >/dev/null
  # A service that is still "starting" makes both commands fail; the wait below checks that it came up.
  rc-service balai restart >/dev/null 2>&1 || rc-service balai start >/dev/null 2>&1 || true
  MANAGER=openrc
else
  MANAGER=none
fi

if [ "$MANAGER" = none ]; then
  cat <<NOTE

No service manager was found (systemd or OpenRC), so Balai was not set to
start on its own. Start it with:

  cd $DIR && BALAI_HOST=$HOST BALAI_PORT=$PORT BALAI_URL=$URL $BUN server/index.ts

NOTE
  exit 0
fi

for _ in $(seq 1 30); do
  [ -f "$DIR/data/first-run.txt" ] && break
  sleep 0.5
done

echo
if [ -f "$DIR/data/first-run.txt" ]; then
  cat "$DIR/data/first-run.txt"
else
  echo "Balai is running on port $PORT. Sign in with your existing password."
fi

if [ "$HOST" != "127.0.0.1" ] && command -v firewall-cmd >/dev/null && firewall-cmd --state >/dev/null 2>&1; then
  echo "firewalld is active. To reach Balai from outside, open the port:"
  echo "  firewall-cmd --permanent --add-port=$PORT/tcp && firewall-cmd --reload"
fi
