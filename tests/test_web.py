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
from achilles.mcp_server import _remove_connection
from achilles.pages import PageStore


@pytest.fixture(autouse=True)
def isolated_homes(monkeypatch, tmp_path):
    monkeypatch.setenv("ACHILLES_HOME", str(tmp_path / "achilles"))
    monkeypatch.setenv("ZETA_HOME", str(tmp_path / "zeta"))


def test_approval_mode_validation(monkeypatch) -> None:
    monkeypatch.delenv("ACHILLES_APPROVAL", raising=False)
    assert web.approval_mode() == "allow"
    monkeypatch.setenv("ACHILLES_APPROVAL", "ask")
    assert web.approval_mode() == "ask"
    monkeypatch.setenv("ACHILLES_APPROVAL", "invalid")
    with pytest.raises(ValueError, match="ACHILLES_APPROVAL must be allow or ask"):
        web.approval_mode()


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


def test_rollback_requires_page_bearer_and_same_origin(tmp_path):
    store = PageStore(tmp_path / "achilles")
    store.set_create_mode("home", True)
    bundle = {
        "format_version": 1,
        "kind": "data_operation",
        "name": "annotate_trace",
        "description": "annotate",
        "input_schema": {"type": "object"},
        "output_schema": {"type": "object"},
        "implementation": {
            "operation": "insert",
            "collection": "annotations",
            "data_schema": {"type": "object"},
        },
    }
    store.create_tool("home", bundle)
    store.create_tool("home", bundle)
    store.set_create_mode("home", True)
    other = store.create_page("/other", "other", {"blocks": [{"type": "text", "text": "x"}]})
    home_token = store.ensure_credential("home")
    other_token = store.ensure_credential(other[0]["id"])
    client = TestClient(web.create_app())
    path = "/api/pages/home/tools/annotate_trace/rollback"
    headers = {"authorization": f"Bearer {other_token}", "origin": "http://testserver"}
    assert client.post(path, headers=headers, json={"version": 1}).status_code == 403
    headers = {
        "authorization": f"Bearer {home_token}",
        "origin": "http://evil.test",
        "host": "testserver",
    }
    assert client.post(path, headers=headers, json={"version": 1}).status_code == 403
    assert store.page_tools("home")[0]["version"] == 2


def test_mcp_connection_cleanup_removes_sessions_safely() -> None:
    class Session:
        def __init__(self, connection):
            self._connection = connection

    connection = object()
    sessions = {"home": {Session(connection), Session(connection)}}
    _remove_connection(sessions, "home", connection)
    assert sessions == {}


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
                "port": 8765,
                "token": "legacy-secret",
                "controller_token": "controller-secret",
                "observer_token": "observer-secret",
                "pid": os.getpid(),
                "origins": ["http://127.0.0.1:5190"],
                "ws_auth": True,
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
                "port": 8765,
                "token": "legacy-secret",
                "controller_token": "controller-secret",
                "observer_token": "observer-secret",
                "pid": os.getpid(),
                "origins": ["http://127.0.0.1:5190"],
                "ws_auth": True,
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
    assert response.json()["url"] == "ws://127.0.0.1:8765"
    assert response.json()["controller_token"] == "controller-secret"


@pytest.mark.parametrize("port", [True, "8765", 0, 65536])
def test_discovery_rejects_invalid_port(monkeypatch, tmp_path: Path, port: object) -> None:
    discovery = tmp_path / "discovery.json"
    discovery.write_text(
        json.dumps(
            {
                "port": port,
                "token": "legacy-secret",
                "controller_token": "controller-secret",
                "observer_token": "observer-secret",
                "pid": os.getpid(),
                "origins": ["http://127.0.0.1:5190"],
                "ws_auth": True,
            }
        )
    )
    monkeypatch.setenv("ACHILLES_ZETA_DISCOVERY", str(discovery))
    response = TestClient(web.create_app(), client=("127.0.0.1", 1234)).get(
        "/api/zeta/discovery",
        headers={"origin": "http://127.0.0.1:5190", "host": "127.0.0.1:5190"},
    )
    assert response.status_code == 503
