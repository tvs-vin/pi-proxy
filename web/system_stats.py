"""Zero-dependency system statistics (CPU, RAM, network, AP clients).

Reads directly from /proc so the process avoids the extra memory and startup
cost of a library like psutil - important on a 1GB Raspberry Pi 3B.
"""
from __future__ import annotations

import time
from dataclasses import dataclass, field

_prev_cpu_totals: tuple[int, int] | None = None
_prev_net: dict[str, tuple[float, int, int]] = {}


def _read_cpu_times() -> tuple[int, int]:
    with open("/proc/stat", "r", encoding="ascii") as f:
        line = f.readline()
    parts = line.split()
    values = [int(v) for v in parts[1:]]
    idle = values[3] + values[4]  # idle + iowait
    total = sum(values)
    return idle, total


def cpu_percent() -> float:
    global _prev_cpu_totals
    idle, total = _read_cpu_times()
    if _prev_cpu_totals is None:
        _prev_cpu_totals = (idle, total)
        return 0.0
    prev_idle, prev_total = _prev_cpu_totals
    _prev_cpu_totals = (idle, total)
    delta_total = total - prev_total
    delta_idle = idle - prev_idle
    if delta_total <= 0:
        return 0.0
    return round((1 - delta_idle / delta_total) * 100, 1)


def memory_info() -> dict:
    info = {}
    with open("/proc/meminfo", "r", encoding="ascii") as f:
        for line in f:
            key, _, rest = line.partition(":")
            if key in ("MemTotal", "MemAvailable"):
                info[key] = int(rest.strip().split()[0])  # kB
    total = info.get("MemTotal", 0)
    available = info.get("MemAvailable", 0)
    used = max(total - available, 0)
    percent = round((used / total) * 100, 1) if total else 0.0
    return {
        "total_mb": round(total / 1024, 1),
        "used_mb": round(used / 1024, 1),
        "percent": percent,
    }


def uptime_seconds() -> float:
    with open("/proc/uptime", "r", encoding="ascii") as f:
        return float(f.readline().split()[0])


def load_average() -> list[float]:
    with open("/proc/loadavg", "r", encoding="ascii") as f:
        parts = f.readline().split()
    return [float(p) for p in parts[:3]]


def _read_iface_bytes(iface: str) -> tuple[int, int] | None:
    try:
        with open("/proc/net/dev", "r", encoding="ascii") as f:
            for line in f:
                if ":" not in line:
                    continue
                name, _, rest = line.partition(":")
                if name.strip() != iface:
                    continue
                cols = rest.split()
                rx_bytes = int(cols[0])
                tx_bytes = int(cols[8])
                return rx_bytes, tx_bytes
    except FileNotFoundError:
        return None
    return None


def net_throughput(iface: str) -> dict:
    """Returns bytes/sec for rx and tx since the previous call for this iface."""
    now = time.monotonic()
    current = _read_iface_bytes(iface)
    if current is None:
        return {"rx_bps": 0, "tx_bps": 0}
    rx_bytes, tx_bytes = current
    prev = _prev_net.get(iface)
    _prev_net[iface] = (now, rx_bytes, tx_bytes)
    if prev is None:
        return {"rx_bps": 0, "tx_bps": 0}
    prev_time, prev_rx, prev_tx = prev
    elapsed = now - prev_time
    if elapsed <= 0:
        return {"rx_bps": 0, "tx_bps": 0}
    rx_bps = max(rx_bytes - prev_rx, 0) / elapsed
    tx_bps = max(tx_bytes - prev_tx, 0) / elapsed
    return {"rx_bps": round(rx_bps), "tx_bps": round(tx_bps)}


@dataclass
class ApClient:
    mac: str
    ip: str
    hostname: str


def ap_clients(leases_path: str) -> list[ApClient]:
    clients: list[ApClient] = []
    try:
        with open(leases_path, "r", encoding="ascii", errors="replace") as f:
            for line in f:
                cols = line.split()
                if len(cols) < 4:
                    continue
                _expiry, mac, ip, hostname = cols[0], cols[1], cols[2], cols[3]
                clients.append(ApClient(mac=mac, ip=ip, hostname=hostname if hostname != "*" else ""))
    except FileNotFoundError:
        return []
    return clients


def full_snapshot(ap_iface: str, upstream_iface: str, leases_path: str) -> dict:
    return {
        "cpu_percent": cpu_percent(),
        "memory": memory_info(),
        "uptime_seconds": round(uptime_seconds()),
        "load_average": load_average(),
        "ap_net": net_throughput(ap_iface),
        "upstream_net": net_throughput(upstream_iface),
        "clients": [c.__dict__ for c in ap_clients(leases_path)],
    }
