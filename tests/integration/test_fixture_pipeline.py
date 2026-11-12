import json
import socket
import subprocess
import sys
import time
import uuid
from pathlib import Path


def call(path: Path, request: dict) -> dict:
    with socket.socket(socket.AF_UNIX) as client:
        client.connect(str(path))
        client.sendall((json.dumps(request) + "\n").encode())
        return json.loads(client.recv(4096))


def test_fixture_pipeline_twice(tmp_path: Path) -> None:
    sock = Path("/tmp") / f"achilles-{uuid.uuid4().hex}.sock"
    record = tmp_path / "record.json"
    proc = subprocess.Popen(
        [
            sys.executable,
            "fixtures/notify/server.py",
            "--socket",
            str(sock),
            "--record",
            str(record),
        ],
        stdout=subprocess.PIPE,
        text=True,
    )
    try:
        assert proc.stdout is not None
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            line = proc.stdout.readline()
            if line:
                break
        args = [
            "achilles",
            "run",
            "--once",
            "--manifest",
            "fixtures/one-trace/achilles.toml",
            "--fixture",
            "fixtures/one-trace/trace.json",
            "--db",
            str(tmp_path / "db"),
            "--notify-socket",
            str(sock),
        ]
        first = json.loads(subprocess.run(args, check=True, capture_output=True, text=True).stdout)
        second = json.loads(subprocess.run(args, check=True, capture_output=True, text=True).stdout)
        assert first["runs"] == second["runs"] == 1
        assert first["verdicts"] == second["verdicts"] == 1
        assert first["notifications"] == second["notifications"] == 1
        assert json.loads(record.read_text())["notifications"] == 1
    finally:
        proc.terminate()
        proc.wait(timeout=5)


def test_notifier_duplicate_key(tmp_path: Path) -> None:
    sock = Path("/tmp") / f"achilles-{uuid.uuid4().hex}.sock"
    record = tmp_path / "record.json"
    proc = subprocess.Popen(
        [
            sys.executable,
            "fixtures/notify/server.py",
            "--socket",
            str(sock),
            "--record",
            str(record),
        ],
        stdout=subprocess.PIPE,
        text=True,
    )
    try:
        assert proc.stdout is not None
        proc.stdout.readline()
        request = {
            "version": 1,
            "key": "verdict:test",
            "text": "fixture failure",
            "not_after": 1794450000,
            "priority": "normal",
        }
        assert call(sock, request)["outcome"] == "sent"
        assert call(sock, request)["outcome"] == "duplicate"
        assert json.loads(record.read_text())["notifications"] == 1
    finally:
        proc.terminate()
        proc.wait(timeout=5)
