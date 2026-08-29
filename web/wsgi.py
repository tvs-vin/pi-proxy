"""Production entry point: serves server:app with waitress.

waitress is pure-Python and lightweight, which matters on a 1GB Pi 3B -
no worker processes to fork, single-threaded-friendly, low memory overhead.
"""
from waitress import serve

from server import app

if __name__ == "__main__":
    # 4 threads is plenty for a handful of admin sessions on a Pi 3B.
    serve(app, host="127.0.0.1", port=8080, threads=4)
