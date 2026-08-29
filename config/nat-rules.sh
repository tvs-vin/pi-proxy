#!/bin/sh
# NAT/masquerade rules: forwards+shares upstream internet to AP clients.
# Run once (or wire into a systemd oneshot unit) after interfaces are named.
# Usage: nat-rules.sh <ap_interface> <upstream_interface>
set -e
AP_IF="${1:-wlan0}"
UP_IF="${2:-wlan1}"

nft add table inet pi_proxy_nat 2>/dev/null || true
nft add chain inet pi_proxy_nat postrouting '{ type nat hook postrouting priority 100 ; }' 2>/dev/null || true
nft add chain inet pi_proxy_nat forward '{ type filter hook forward priority 0 ; }' 2>/dev/null || true

nft flush chain inet pi_proxy_nat postrouting
nft flush chain inet pi_proxy_nat forward

nft add rule inet pi_proxy_nat postrouting oifname "$UP_IF" masquerade
nft add rule inet pi_proxy_nat forward iifname "$AP_IF" oifname "$UP_IF" accept
nft add rule inet pi_proxy_nat forward iifname "$UP_IF" oifname "$AP_IF" ct state related,established accept
