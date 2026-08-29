"""Thin, defensive wrapper around ``nmcli`` for the pi-proxy web UI.

All calls use argument lists (never ``shell=True``) so user-supplied values
can never be interpreted by a shell. Every public function validates its
inputs before touching the system.
"""
from __future__ import annotations

import re
import subprocess
from dataclasses import dataclass, field

NMCLI = "nmcli"
TIMEOUT = 20

# Conservative allow-lists to keep untrusted input away from subprocess args.
_SSID_RE = re.compile(r"^.{1,32}$")
_CONN_NAME_RE = re.compile(r"^[\w .:\-]{1,64}$")
_IFACE_RE = re.compile(r"^[a-zA-Z0-9_.\-]{1,15}$")
_CIDR_RE = re.compile(r"^\d{1,3}(\.\d{1,3}){3}/\d{1,2}$")
_IP_RE = re.compile(r"^\d{1,3}(\.\d{1,3}){3}$")


class NetworkManagerError(RuntimeError):
    """Raised when an nmcli invocation fails or input is invalid."""


def _run(args: list[str]) -> str:
    try:
        result = subprocess.run(
            [NMCLI, *args],
            capture_output=True,
            text=True,
            timeout=TIMEOUT,
            check=False,
        )
    except subprocess.TimeoutExpired as exc:
        raise NetworkManagerError("nmcli timed out") from exc
    except FileNotFoundError as exc:
        raise NetworkManagerError("nmcli is not installed") from exc
    if result.returncode != 0:
        raise NetworkManagerError(result.stderr.strip() or "nmcli command failed")
    return result.stdout


def _validate_iface(iface: str) -> str:
    if not _IFACE_RE.match(iface):
        raise NetworkManagerError("invalid interface name")
    return iface


def _validate_ssid(ssid: str) -> str:
    if not _SSID_RE.match(ssid):
        raise NetworkManagerError("invalid SSID")
    return ssid


def _validate_conn_name(name: str) -> str:
    if not _CONN_NAME_RE.match(name):
        raise NetworkManagerError("invalid connection name")
    return name


def _unescape(field_value: str) -> str:
    """Undo nmcli's terse-mode backslash escaping of ':' and '\\'."""
    return field_value.replace("\\:", ":").replace("\\\\", "\\")


def _split_terse_line(line: str) -> list[str]:
    """Split an nmcli -t line on unescaped ':' characters."""
    parts: list[str] = []
    current = []
    escape = False
    for ch in line:
        if escape:
            current.append(ch)
            escape = False
        elif ch == "\\":
            current.append(ch)
            escape = True
        elif ch == ":":
            parts.append(_unescape("".join(current)))
            current = []
        else:
            current.append(ch)
    parts.append(_unescape("".join(current)))
    return parts


@dataclass
class WifiNetwork:
    ssid: str
    signal: int
    security: str
    in_use: bool


@dataclass
class WifiStatus:
    connected: bool
    ssid: str | None = None
    ip4: str | None = None


def scan_wifi(iface: str) -> list[WifiNetwork]:
    _validate_iface(iface)
    _run(["device", "wifi", "rescan", "ifname", iface])
    out = _run(
        ["-t", "-f", "SSID,SIGNAL,SECURITY,IN-USE", "device", "wifi", "list", "ifname", iface]
    )
    seen: dict[str, WifiNetwork] = {}
    for line in out.splitlines():
        if not line.strip():
            continue
        cols = _split_terse_line(line)
        if len(cols) < 4:
            continue
        ssid, signal, security, in_use = cols[0], cols[1], cols[2], cols[3]
        if not ssid:
            continue
        try:
            signal_i = int(signal)
        except ValueError:
            signal_i = 0
        net = WifiNetwork(ssid=ssid, signal=signal_i, security=security or "open", in_use=in_use == "*")
        # Keep the strongest signal entry when an SSID is seen on multiple BSSIDs.
        existing = seen.get(ssid)
        if existing is None or net.signal > existing.signal:
            seen[ssid] = net
    return sorted(seen.values(), key=lambda n: n.signal, reverse=True)


def wifi_status(iface: str) -> WifiStatus:
    _validate_iface(iface)
    out = _run(["-t", "-f", "DEVICE,STATE,CONNECTION", "device", "status"])
    for line in out.splitlines():
        cols = _split_terse_line(line)
        if len(cols) < 3 or cols[0] != iface:
            continue
        if cols[1] != "connected":
            return WifiStatus(connected=False)
        ip4 = None
        ip_out = _run(["-t", "-f", "IP4.ADDRESS", "device", "show", iface])
        for ip_line in ip_out.splitlines():
            if ip_line.startswith("IP4.ADDRESS"):
                ip4 = _split_terse_line(ip_line)[-1].split("/")[0]
                break
        return WifiStatus(connected=True, ssid=cols[2] or None, ip4=ip4)
    return WifiStatus(connected=False)


def connect_wifi(iface: str, ssid: str, password: str | None) -> None:
    _validate_iface(iface)
    _validate_ssid(ssid)
    if password is not None and len(password) > 128:
        raise NetworkManagerError("password too long")
    args = ["device", "wifi", "connect", ssid, "ifname", iface]
    if password:
        args += ["password", password]
    _run(args)


def disconnect_wifi(iface: str) -> None:
    _validate_iface(iface)
    _run(["device", "disconnect", iface])


@dataclass
class VpnConnection:
    name: str
    type: str
    active: bool


def list_vpn_connections() -> list[VpnConnection]:
    out = _run(["-t", "-f", "NAME,TYPE,ACTIVE", "connection", "show"])
    connections = []
    for line in out.splitlines():
        cols = _split_terse_line(line)
        if len(cols) < 3:
            continue
        name, ctype, active = cols
        if "vpn" not in ctype and "wireguard" not in ctype:
            continue
        connections.append(VpnConnection(name=name, type=ctype, active=active == "yes"))
    return connections


def vpn_activate(name: str) -> None:
    _validate_conn_name(name)
    _run(["connection", "up", name])


def vpn_deactivate(name: str) -> None:
    _validate_conn_name(name)
    _run(["connection", "down", name])


def vpn_delete(name: str) -> None:
    _validate_conn_name(name)
    _run(["connection", "delete", name])


def vpn_import(vpn_type: str, file_path: str) -> str:
    if vpn_type not in ("openvpn", "wireguard"):
        raise NetworkManagerError("unsupported VPN type")
    out = _run(["connection", "import", "type", vpn_type, "file", file_path])
    match = re.search(r"'([^']+)'", out)
    return match.group(1) if match else vpn_type


@dataclass
class UpstreamConfig:
    connection: str | None
    method: str
    address: str | None
    gateway: str | None
    dns: list[str] = field(default_factory=list)


def get_upstream_config(iface: str) -> UpstreamConfig:
    _validate_iface(iface)
    status_out = _run(["-t", "-f", "DEVICE,CONNECTION", "device", "status"])
    conn_name = None
    for line in status_out.splitlines():
        cols = _split_terse_line(line)
        if len(cols) >= 2 and cols[0] == iface and cols[1] not in ("", "--"):
            conn_name = cols[1]
            break
    if conn_name is None:
        return UpstreamConfig(connection=None, method="auto", address=None, gateway=None, dns=[])

    fields = "ipv4.method,ipv4.addresses,ipv4.gateway,ipv4.dns"
    out = _run(["-t", "-f", fields, "connection", "show", conn_name])
    values = {"method": "auto", "address": None, "gateway": None, "dns": []}
    for line in out.splitlines():
        if ":" not in line:
            continue
        key, _, value = line.partition(":")
        value = _unescape(value)
        if key == "ipv4.method":
            values["method"] = value or "auto"
        elif key == "ipv4.addresses":
            values["address"] = value or None
        elif key == "ipv4.gateway":
            values["gateway"] = value or None
        elif key == "ipv4.dns":
            values["dns"] = [d for d in value.split(",") if d]
    return UpstreamConfig(connection=conn_name, **values)


def set_upstream_dhcp(connection: str) -> None:
    _validate_conn_name(connection)
    _run(["connection", "modify", connection, "ipv4.method", "auto"])
    _run(["connection", "up", connection])


def set_upstream_static(
    connection: str, address_cidr: str, gateway: str, dns: list[str]
) -> None:
    _validate_conn_name(connection)
    if not _CIDR_RE.match(address_cidr):
        raise NetworkManagerError("invalid address (expected CIDR, e.g. 192.168.1.50/24)")
    if not _IP_RE.match(gateway):
        raise NetworkManagerError("invalid gateway")
    for d in dns:
        if not _IP_RE.match(d):
            raise NetworkManagerError("invalid DNS server")
    dns_value = " ".join(dns)
    _run(
        [
            "connection",
            "modify",
            connection,
            "ipv4.method",
            "manual",
            "ipv4.addresses",
            address_cidr,
            "ipv4.gateway",
            gateway,
            "ipv4.dns",
            dns_value,
        ]
    )
    _run(["connection", "up", connection])
