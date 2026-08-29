#!/bin/sh
# Installs all OS packages and Python dependencies needed to run pi-proxy on
# a Raspberry Pi 3B (Raspberry Pi OS / Debian). Idempotent - safe to re-run.
#
# Usage: sudo ./install.sh
#
# What it does:
#   1. apt-get installs NetworkManager, hostapd, dnsmasq, nftables, python3.
#   2. Disables dhcpcd if present (conflicts with NetworkManager managing wlan1).
#   3. Copies web/ into /opt/pi-proxy/web and creates a Python venv there.
#   4. Installs the systemd unit (without starting it - config isn't set up yet).
#
# It does NOT write hostapd/dnsmasq/config.json - see docs/README.md for the
# remaining manual steps (radio settings, admin password, interface names).
set -e

if [ "$(id -u)" -ne 0 ]; then
  echo "This script must be run as root (sudo ./install.sh)" >&2
  exit 1
fi

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
INSTALL_DIR="/opt/pi-proxy"
CONFIG_DIR="/etc/pi-proxy"

echo "==> Installing OS packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y \
  python3 \
  python3-venv \
  network-manager \
  hostapd \
  dnsmasq \
  nftables \
  rsync

echo "==> Ensuring NetworkManager owns network interfaces"
if systemctl is-enabled --quiet dhcpcd 2>/dev/null; then
  echo "    Disabling dhcpcd (conflicts with NetworkManager)"
  systemctl disable --now dhcpcd
fi
systemctl unmask NetworkManager
systemctl enable --now NetworkManager

echo "==> hostapd/dnsmasq will be started later, once configured"
systemctl unmask hostapd dnsmasq 2>/dev/null || true
systemctl disable hostapd dnsmasq 2>/dev/null || true

echo "==> Installing web app to $INSTALL_DIR"
mkdir -p "$INSTALL_DIR" "$CONFIG_DIR"
rsync -a --delete "$REPO_DIR/web/" "$INSTALL_DIR/web/" \
  --exclude venv --exclude __pycache__ --exclude '*.pyc'

echo "==> Creating Python virtual environment"
python3 -m venv "$INSTALL_DIR/web/venv"
"$INSTALL_DIR/web/venv/bin/pip" install --upgrade pip -q
"$INSTALL_DIR/web/venv/bin/pip" install -q -r "$INSTALL_DIR/web/requirements.txt"

echo "==> Installing systemd unit (not starting - config.json not set up yet)"
cp "$REPO_DIR/config/pi-proxy.service" /etc/systemd/system/pi-proxy.service
systemctl daemon-reload

cat <<'EOF'

==> Done. Remaining manual steps:
  1. Copy and edit config templates:
       config/hostapd.conf.example      -> /etc/hostapd/hostapd.conf
       config/dnsmasq.conf.example      -> /etc/dnsmasq.d/pi-proxy.conf
       config/99-pi-proxy-forwarding.conf -> /etc/sysctl.d/
     then: sudo sysctl --system
  2. Set up NAT: sudo config/nat-rules.sh <ap_interface> <upstream_interface>
  3. Generate the admin password/config:
       sudo python3 config/setup_config.py --output /etc/pi-proxy/config.json
  4. Start everything:
       sudo systemctl enable --now pi-proxy hostapd dnsmasq
See docs/README.md for full details.
EOF
