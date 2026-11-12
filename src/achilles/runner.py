from __future__ import annotations

import json
import socket
from pathlib import Path

from .config import load_manifest
from .trace import load_fixture
from .verdicts import complete, list_verdicts, prepare


def run_once(manifest_path: Path, fixture_path: Path, db_path: Path, socket_path: Path) -> dict:
    prepared, notify = prepare(db_path, load_manifest(manifest_path), load_fixture(fixture_path))
    if notify:
        with socket.socket(socket.AF_UNIX) as s:
            s.connect(str(socket_path))
            s.sendall((json.dumps(prepared["request"]) + "\n").encode())
            response = json.loads(s.recv(65536))
            complete(db_path, prepared["verdict_id"], response["outcome"], response)
    rows = list_verdicts(db_path)
    return {
        "runs": 1,
        "verdicts": len(rows),
        "notifications": sum(1 for x in rows if x["delivery_outcome"] in {"sent", "duplicate"}),
        "existing": not notify,
    }
