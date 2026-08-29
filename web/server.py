"""pi-proxy web UI backend.

Lightweight Flask app, meant to be served with waitress on a Raspberry Pi 3B.
Serves a single-page vanilla JS/CSS frontend and a small JSON API that wraps
nmcli (via network_manager.py) and /proc stats (via system_stats.py).
"""
from __future__ import annotations

import json
import logging
import os
import secrets
import tempfile
import time
from functools import wraps

from flask import Flask, jsonify, request, send_from_directory, session
from werkzeug.security import check_password_hash

import network_manager as nm
import system_stats

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
CONFIG_PATH = os.environ.get(
    "PI_PROXY_CONFIG", os.path.join(BASE_DIR, "..", "config", "config.json")
)

log = logging.getLogger("pi_proxy")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

app = Flask(__name__, static_folder="static", template_folder="templates")

# --- Config -----------------------------------------------------------------


def load_config() -> dict:
    with open(CONFIG_PATH, "r", encoding="utf-8") as f:
        cfg = json.load(f)
    required = ("ap_interface", "upstream_interface", "admin_password_hash", "secret_key")
    missing = [k for k in required if k not in cfg]
    if missing:
        raise RuntimeError(f"config.json missing required keys: {missing}")
    cfg.setdefault("dnsmasq_leases", "/var/lib/misc/dnsmasq.leases")
    return cfg


CONFIG = load_config()
app.secret_key = CONFIG["secret_key"]
app.config.update(
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE="Strict",
    PERMANENT_SESSION_LIFETIME=60 * 60 * 8,
)

# --- Basic login-attempt throttling (in-memory, single-process is fine here) -
_failed_attempts: dict[str, list[float]] = {}
_MAX_ATTEMPTS = 5
_WINDOW_SECONDS = 60


def _rate_limited(key: str) -> bool:
    now = time.monotonic()
    attempts = [t for t in _failed_attempts.get(key, []) if now - t < _WINDOW_SECONDS]
    _failed_attempts[key] = attempts
    return len(attempts) >= _MAX_ATTEMPTS


def _record_failure(key: str) -> None:
    _failed_attempts.setdefault(key, []).append(time.monotonic())


def login_required(view):
    @wraps(view)
    def wrapped(*args, **kwargs):
        if not session.get("authenticated"):
            return jsonify(error="authentication required"), 401
        return view(*args, **kwargs)

    return wrapped


def _api_error(exc: Exception, code: int = 400):
    log.warning("API error: %s", exc)
    return jsonify(error=str(exc)), code


# --- Static / SPA -------------------------------------------------------------


@app.route("/")
def index():
    return send_from_directory(os.path.join(BASE_DIR, "templates"), "index.html")


# --- Auth ----------------------------------------------------------------


@app.post("/api/login")
def login():
    remote = request.remote_addr or "unknown"
    if _rate_limited(remote):
        return jsonify(error="too many attempts, try again shortly"), 429
    data = request.get_json(silent=True) or {}
    password = data.get("password", "")
    if not isinstance(password, str) or not check_password_hash(
        CONFIG["admin_password_hash"], password
    ):
        _record_failure(remote)
        return jsonify(error="invalid password"), 401
    session.clear()
    session["authenticated"] = True
    session.permanent = True
    return jsonify(ok=True)


@app.post("/api/logout")
def logout():
    session.clear()
    return jsonify(ok=True)


@app.get("/api/session")
def session_status():
    return jsonify(authenticated=bool(session.get("authenticated")))


# --- Stats -----------------------------------------------------------------


@app.get("/api/stats")
@login_required
def stats():
    snapshot = system_stats.full_snapshot(
        CONFIG["ap_interface"], CONFIG["upstream_interface"], CONFIG["dnsmasq_leases"]
    )
    return jsonify(snapshot)


# --- WiFi (upstream) --------------------------------------------------------


@app.get("/api/wifi/scan")
@login_required
def wifi_scan():
    try:
        networks = nm.scan_wifi(CONFIG["upstream_interface"])
    except nm.NetworkManagerError as exc:
        return _api_error(exc, 502)
    return jsonify([n.__dict__ for n in networks])


@app.get("/api/wifi/status")
@login_required
def wifi_status():
    try:
        status = nm.wifi_status(CONFIG["upstream_interface"])
    except nm.NetworkManagerError as exc:
        return _api_error(exc, 502)
    return jsonify(status.__dict__)


@app.post("/api/wifi/connect")
@login_required
def wifi_connect():
    data = request.get_json(silent=True) or {}
    ssid = data.get("ssid")
    password = data.get("password") or None
    if not isinstance(ssid, str) or not ssid:
        return jsonify(error="ssid is required"), 400
    try:
        nm.connect_wifi(CONFIG["upstream_interface"], ssid, password)
    except nm.NetworkManagerError as exc:
        return _api_error(exc, 502)
    return jsonify(ok=True)


@app.post("/api/wifi/disconnect")
@login_required
def wifi_disconnect():
    try:
        nm.disconnect_wifi(CONFIG["upstream_interface"])
    except nm.NetworkManagerError as exc:
        return _api_error(exc, 502)
    return jsonify(ok=True)


# --- VPN ---------------------------------------------------------------------


@app.get("/api/vpn")
@login_required
def vpn_list():
    try:
        connections = nm.list_vpn_connections()
    except nm.NetworkManagerError as exc:
        return _api_error(exc, 502)
    return jsonify([c.__dict__ for c in connections])


@app.post("/api/vpn/<name>/activate")
@login_required
def vpn_activate(name):
    try:
        nm.vpn_activate(name)
    except nm.NetworkManagerError as exc:
        return _api_error(exc, 502)
    return jsonify(ok=True)


@app.post("/api/vpn/<name>/deactivate")
@login_required
def vpn_deactivate(name):
    try:
        nm.vpn_deactivate(name)
    except nm.NetworkManagerError as exc:
        return _api_error(exc, 502)
    return jsonify(ok=True)


@app.delete("/api/vpn/<name>")
@login_required
def vpn_delete(name):
    try:
        nm.vpn_delete(name)
    except nm.NetworkManagerError as exc:
        return _api_error(exc, 502)
    return jsonify(ok=True)


_MAX_VPN_UPLOAD_BYTES = 64 * 1024


@app.post("/api/vpn/import")
@login_required
def vpn_import():
    vpn_type = request.form.get("type", "")
    uploaded = request.files.get("file")
    if vpn_type not in ("openvpn", "wireguard"):
        return jsonify(error="type must be 'openvpn' or 'wireguard'"), 400
    if uploaded is None or uploaded.filename == "":
        return jsonify(error="file is required"), 400

    content = uploaded.read(_MAX_VPN_UPLOAD_BYTES + 1)
    if len(content) > _MAX_VPN_UPLOAD_BYTES:
        return jsonify(error="file too large"), 413

    tmp_path = None
    try:
        with tempfile.NamedTemporaryFile(delete=False, suffix=".conf") as tmp:
            tmp.write(content)
            tmp_path = tmp.name
        name = nm.vpn_import(vpn_type, tmp_path)
    except nm.NetworkManagerError as exc:
        return _api_error(exc, 502)
    finally:
        if tmp_path and os.path.exists(tmp_path):
            os.remove(tmp_path)
    return jsonify(ok=True, name=name)


# --- Upstream device configuration -------------------------------------------


@app.get("/api/upstream")
@login_required
def upstream_get():
    try:
        cfg = nm.get_upstream_config(CONFIG["upstream_interface"])
    except nm.NetworkManagerError as exc:
        return _api_error(exc, 502)
    return jsonify(cfg.__dict__)


@app.post("/api/upstream")
@login_required
def upstream_set():
    data = request.get_json(silent=True) or {}
    method = data.get("method")
    current = None
    try:
        current = nm.get_upstream_config(CONFIG["upstream_interface"])
        if current.connection is None:
            return jsonify(error="no active connection on upstream interface"), 409
        if method == "auto":
            nm.set_upstream_dhcp(current.connection)
        elif method == "manual":
            address = data.get("address", "")
            gateway = data.get("gateway", "")
            dns = data.get("dns", [])
            if not isinstance(dns, list):
                return jsonify(error="dns must be a list"), 400
            nm.set_upstream_static(current.connection, address, gateway, dns)
        else:
            return jsonify(error="method must be 'auto' or 'manual'"), 400
    except nm.NetworkManagerError as exc:
        return _api_error(exc, 502)
    return jsonify(ok=True)


if __name__ == "__main__":
    # Dev-only entry point. In production run via waitress, see config/pi-proxy.service.
    app.run(host="127.0.0.1", port=8080, debug=False)
