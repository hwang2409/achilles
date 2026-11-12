import json
import socket
import subprocess
import sys
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parents[1]))
from support.process import start_ready, stop


def call(path: Path, request: dict) -> dict:
    with socket.socket(socket.AF_UNIX) as client:
        client.connect(str(path))
        client.sendall((json.dumps(request) + "\n").encode())
        return json.loads(client.recv(4096))


def test_fixture_pipeline_twice(tmp_path: Path) -> None:
    sock = Path("/tmp") / f"achilles-{uuid.uuid4().hex}.sock"
    record = tmp_path / "record.json"
    proc, _ = start_ready(
        [
            sys.executable,
            "fixtures/notify/server.py",
            "--socket",
            str(sock),
            "--record",
            str(record),
        ]
    )
    try:
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
        assert first["existing"] is False and second["existing"] is True
        assert (
            len(
                json.loads(
                    subprocess.run(
                        ["achilles", "verdict", "list", "--db", str(tmp_path / "db"), "--json"],
                        check=True,
                        capture_output=True,
                        text=True,
                    ).stdout
                )
            )
            == 1
        )
        record_data = json.loads(record.read_text())
        assert record_data["notifications"] == 1 and record_data["requests"] == 1
    finally:
        stop(proc)


def test_notifier_duplicate_key(tmp_path: Path) -> None:
    sock = Path("/tmp") / f"achilles-{uuid.uuid4().hex}.sock"
    record = tmp_path / "record.json"
    proc, _ = start_ready(
        [
            sys.executable,
            "fixtures/notify/server.py",
            "--socket",
            str(sock),
            "--record",
            str(record),
        ]
    )
    try:
        request = {
            "version": 1,
            "key": "verdict:test",
            "text": "fixture failure",
            "not_after": 1794450000,
            "priority": "normal",
        }
        assert call(sock, request)["outcome"] == "sent"
        assert call(sock, request)["outcome"] == "duplicate"
        record_data = json.loads(record.read_text())
        assert record_data["notifications"] == 1 and record_data["requests"] == 2
    finally:
        stop(proc)
