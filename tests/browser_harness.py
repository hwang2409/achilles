from __future__ import annotations

import os
import subprocess
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from support.process import start_ready, stop

with tempfile.TemporaryDirectory() as directory:
    tmp = Path(directory)
    sock = tmp / "notify.sock"
    record = tmp / "record.json"
    db = tmp / "db"
    notify, _ = start_ready(
        [
            sys.executable,
            "fixtures/notify/server.py",
            "--socket",
            str(sock),
            "--record",
            str(record),
        ]
    )
    web = None
    try:
        subprocess.run(
            [
                "uv",
                "run",
                "achilles",
                "run",
                "--once",
                "--manifest",
                "fixtures/one-trace/achilles.toml",
                "--fixture",
                "fixtures/one-trace/trace.json",
                "--db",
                str(db),
                "--notify-socket",
                str(sock),
            ],
            check=True,
        )
        web, ready = start_ready(
            [
                "uv",
                "run",
                "achilles",
                "serve",
                "--db",
                str(db),
                "--web-root",
                "apps/web/dist",
                "--port",
                "0",
            ]
        )
        env = {
            **os.environ,
            "ACHILLES_URL": f"http://127.0.0.1:{ready['port']}",
            "SCREENSHOT": os.environ.get("SCREENSHOT", ""),
        }
        subprocess.run(["bun", "run", "apps/web/tests/dashboard.browser.ts"], check=True, env=env)
    finally:
        if web is not None:
            stop(web)
        stop(notify)
