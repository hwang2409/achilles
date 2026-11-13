import json
import os
import socket
import sqlite3
import threading
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from pathlib import Path

import pytest
import uvicorn
from starlette.testclient import TestClient

import achilles.web as web


@pytest.fixture(autouse=True)
def isolated_homes(monkeypatch, tmp_path):
    monkeypatch.setenv("ACHILLES_HOME", str(tmp_path / "achilles"))
    monkeypatch.setenv("ZETA_HOME", str(tmp_path / "zeta"))


def test_session_mapping_is_atomic_and_private(monkeypatch, tmp_path: Path) -> None:
    home = tmp_path / "achilles"
    home.mkdir(mode=0o755)
    monkeypatch.setenv("ACHILLES_HOME", str(home))
    client = TestClient(web.create_app())
    assert (
        client.put("/api/pages/home/session", json={"session_id": "session-a"}).status_code == 200
    )

    def save(value: str):
        with TestClient(web.create_app()) as active:
            return active.put(
                "/api/pages/home/session",
                json={"expected_session_id": "session-a", "session_id": value},
            )

    with ThreadPoolExecutor(max_workers=2) as pool:
        responses = list(pool.map(save, ("session-b", "session-c")))
    assert [response.status_code for response in responses].count(200) == 1
    assert [response.status_code for response in responses].count(409) == 1
    assert home.stat().st_mode & 0o777 == 0o700
    assert (home / "achilles.sqlite3").stat().st_mode & 0o777 == 0o600
    with sqlite3.connect(home / "achilles.sqlite3") as db:
        assert db.execute("PRAGMA user_version").fetchone()[0] == 3
    for sidecar in (home / "achilles.sqlite3-wal", home / "achilles.sqlite3-shm"):
        if sidecar.exists():
            assert sidecar.stat().st_mode & 0o777 == 0o600


@contextmanager
def running_http_app(app):
    server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=0, log_level="error"))
    thread = threading.Thread(target=server.run)
    thread.start()
    try:
        while not server.started:
            pass
        port = server.servers[0].sockets[0].getsockname()[1]
        yield port
    finally:
        server.should_exit = True
        thread.join(timeout=10)
        assert not thread.is_alive()


def raw_get(port: int, path: str) -> tuple[int, str]:
    with socket.create_connection(("127.0.0.1", port), timeout=5) as connection:
        request = f"GET {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n"
        connection.sendall(request.encode())
        response = b""
        while chunk := connection.recv(65536):
            response += chunk
    head, body = response.split(b"\r\n\r\n", 1)
    return int(head.splitlines()[0].split()[1]), body.decode()


def test_static_paths_are_contained(monkeypatch, tmp_path: Path) -> None:
    root = tmp_path / "dist"
    (root / "assets").mkdir(parents=True)
    (root / "assets" / "ok.js").write_text("inside")
    (tmp_path / "secret.txt").write_text("outside")
    (root / "assets" / "link.txt").symlink_to(tmp_path / "secret.txt")
    monkeypatch.setattr(web, "_static_root", lambda: root)
    paths = (
        "/assets/../../../../pyproject.toml",
        "/assets/%2e%2e/secret.txt",
        "/assets/%2fetc/passwd",
        "/assets/../dist-secret/secret.txt",
        "/assets/link.txt",
    )
    with running_http_app(web.create_app()) as port:
        for path in paths:
            status, body = raw_get(port, path)
            assert status != 200, path
            assert "outside" not in body
        assert raw_get(port, "/assets/ok.js") == (200, "inside")


@pytest.mark.parametrize(
    "headers, peer",
    [
        ({"origin": "http://127.0.0.1:5190", "host": "127.0.0.1:5190"}, "10.0.0.2"),
        ({"origin": "http://127.0.0.1:5190", "host": "example.com"}, "127.0.0.1"),
        ({"origin": "http://evil.test", "host": "127.0.0.1:5190"}, "127.0.0.1"),
        (
            {
                "origin": "http://127.0.0.1:5190",
                "host": "127.0.0.1:5190",
                "sec-fetch-site": "cross-site",
            },
            "127.0.0.1",
        ),
    ],
)
def test_discovery_requires_same_origin_loopback(
    monkeypatch, tmp_path: Path, headers: dict[str, str], peer: str
) -> None:
    discovery = tmp_path / "discovery.json"
    discovery.write_text(
        json.dumps(
            {
                "url": "ws://127.0.0.1:8765",
                "pid": os.getpid(),
                "origins": ["http://127.0.0.1:5190"],
                "controller_token": "controller-secret",
                "observer_token": "observer-secret",
            }
        )
    )
    monkeypatch.setenv("ACHILLES_ZETA_DISCOVERY", str(discovery))
    client = TestClient(web.create_app(), client=(peer, 1234))
    response = client.get("/api/zeta/discovery", headers=headers)
    assert response.status_code == 403
    assert "secret" not in response.text


def test_discovery_allows_browser_same_origin(monkeypatch, tmp_path: Path) -> None:
    discovery = tmp_path / "discovery.json"
    discovery.write_text(
        json.dumps(
            {
                "url": "ws://127.0.0.1:8765",
                "pid": os.getpid(),
                "origins": ["http://127.0.0.1:5190"],
                "controller_token": "controller-secret",
                "observer_token": "observer-secret",
            }
        )
    )
    monkeypatch.setenv("ACHILLES_ZETA_DISCOVERY", str(discovery))
    response = TestClient(web.create_app(), client=("127.0.0.1", 1234)).get(
        "/api/zeta/discovery",
        headers={
            "origin": "http://127.0.0.1:5190",
            "host": "127.0.0.1:5190",
            "sec-fetch-site": "same-origin",
        },
    )
    assert response.status_code == 200
    assert response.json()["controller_token"] == "controller-secret"
