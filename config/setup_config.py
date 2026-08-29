"""One-shot helper to generate /etc/pi-proxy/config.json.

Usage:
    python3 setup_config.py --ap-interface wlan0 --upstream-interface wlan1

Prompts for the admin password (not echoed), hashes it, and writes a fresh
config.json with a random session secret key next to this script unless
--output is given.
"""
from __future__ import annotations

import argparse
import getpass
import json
import os
import secrets
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "web"))

from werkzeug.security import generate_password_hash  # noqa: E402


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--ap-interface", default="wlan0")
    parser.add_argument("--upstream-interface", default="wlan1")
    parser.add_argument("--dnsmasq-leases", default="/var/lib/misc/dnsmasq.leases")
    parser.add_argument(
        "--output", default=os.path.join(os.path.dirname(__file__), "config.json")
    )
    args = parser.parse_args()

    password = getpass.getpass("Set admin password: ")
    confirm = getpass.getpass("Confirm password: ")
    if password != confirm:
        raise SystemExit("Passwords do not match")
    if len(password) < 8:
        raise SystemExit("Password must be at least 8 characters")

    config = {
        "ap_interface": args.ap_interface,
        "upstream_interface": args.upstream_interface,
        "dnsmasq_leases": args.dnsmasq_leases,
        "admin_password_hash": generate_password_hash(password),
        "secret_key": secrets.token_hex(32),
    }

    with open(args.output, "w", encoding="utf-8") as f:
        json.dump(config, f, indent=2)
    os.chmod(args.output, 0o600)
    print(f"Wrote {args.output}")


if __name__ == "__main__":
    main()
