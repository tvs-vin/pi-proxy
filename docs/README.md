# pi-proxy
### Hello World 2026 hackathon project
<p style="float: left; margin: 0 15px 15px 0;">
  <img src="images/logo.png" alt="Logo" width="150">
</p>

This project is made by 
 - * Brad Gaw (tvs-vin)
 - * Hugo Nunez Matute
 - * Nate Anderson
 - * 

 Goal of the project

 Using a raspberry pi 3B as our machine, the end user would connect many devices to a network hosted on the raspberry pi. Then, a single user could connect to the webUI and chose a network to have the pi-proxy connect to, and then route all traffic through.

## Architecture

- **AP side** (`wlan0` by default): `hostapd` + `dnsmasq` broadcast a WiFi network and hand out DHCP leases to client devices.
- **Upstream side** (`wlan1` or `eth0` by default): managed by **NetworkManager**, connects to whatever WiFi network (or VPN) the admin picks in the webUI.
- **Routing**: the kernel forwards packets between the two interfaces (`net.ipv4.ip_forward=1`) and `nftables` masquerades AP traffic out the upstream interface, so connected devices get internet through the Pi.
- **Web UI** ([web/](../web)): a single-page vanilla HTML/CSS/JS frontend (no build step, no CDNs — it must work even before the Pi has internet) talking to a small Flask JSON API, served in production by `waitress` (pure Python, low memory, no worker forking) so it stays light on a 1GB Pi 3B. All network changes are made through `nmcli` with allow-listed, argument-list subprocess calls (never `shell=True`).

## Features

- Dashboard: live CPU/RAM/uptime/load average and AP↔upstream throughput (polled every 3s, paused when the tab is hidden), plus a table of devices currently connected to the AP.
- WiFi: scan and connect the upstream interface to a network (open or secured).
- VPN: list, activate/deactivate, and import NetworkManager VPN connections (WireGuard or OpenVPN).
- Upstream device: switch between DHCP and a static IP/gateway/DNS configuration.
- Password-protected (hashed) session login with basic brute-force throttling.

## Setup (on the Raspberry Pi)

1. Clone this repo onto the Pi, then run the installer (installs OS packages, sets up NetworkManager, copies the web app to `/opt/pi-proxy`, creates its venv, and installs the systemd unit):
   ```sh
   sudo config/install.sh
   ```
2. Configure the AP radio and DHCP, using the templates in [config/](../config) as a starting point:
   - Copy `config/hostapd.conf.example` → `/etc/hostapd/hostapd.conf` (set your own `ssid`/`wpa_passphrase`).
   - Copy `config/dnsmasq.conf.example` → `/etc/dnsmasq.d/pi-proxy.conf`.
   - Copy `config/99-pi-proxy-forwarding.conf` → `/etc/sysctl.d/` and run `sudo sysctl --system`.
   - Run `sudo config/nat-rules.sh <ap_interface> <upstream_interface>` (or wire it into a oneshot systemd unit) to set up NAT.
3. Generate the admin password/config (uses the venv created by `install.sh`, since it needs `werkzeug`):
   ```sh
   sudo /opt/pi-proxy/web/venv/bin/python config/setup_config.py --ap-interface wlan0 --upstream-interface wlan1 --output /etc/pi-proxy/config.json
   ```
4. Start everything:
   ```sh
   sudo systemctl enable --now pi-proxy hostapd dnsmasq
   ```
5. Connect to the Pi's AP and browse to its AP-side address (e.g. `http://192.168.50.1:8080`) to sign in with the admin password chosen during setup.

Re-running `config/install.sh` after pulling changes is safe - it refreshes `/opt/pi-proxy/web` and its venv without touching your existing `/etc/pi-proxy/config.json` or systemd state.

## Local development

```sh
cd web
python3 -m venv venv && venv/bin/pip install -r requirements.txt
python3 ../config/setup_config.py --output ../config/config.json
PI_PROXY_CONFIG=../config/config.json venv/bin/python server.py
```

Note: WiFi/VPN/upstream endpoints require `nmcli` (NetworkManager) to be present on the host; stats endpoints work anywhere with a `/proc` filesystem (Linux only).
