import json
import os
import re
import signal
import socket
import sqlite3
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from pathlib import Path

import pytest
import uvicorn
from starlette.testclient import TestClient

import achilles.mcp_server as mcp_server
import achilles.render_page as render_page_module
import achilles.web as web
from achilles.mcp_server import _remove_connection
from achilles.pages import PageStore
from achilles.tools import bundle_digest, validate_bundle


@pytest.fixture(autouse=True)
def isolated_homes(monkeypatch, tmp_path):
    monkeypatch.setenv("ACHILLES_HOME", str(tmp_path / "achilles"))
    monkeypatch.setenv("ZETA_HOME", str(tmp_path / "zeta"))


def test_page_tool_catalog_and_invoke_share_executor_and_auth(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.setenv("ACHILLES_HOME", str(tmp_path / "achilles"))
    store = PageStore(tmp_path / "achilles")
    store.set_create_mode("home", True)
    bundle = {
        "format_version": 1,
        "kind": "data_operation",
        "name": "add_note",
        "description": "add a note",
        "input_schema": {
            "type": "object",
            "properties": {"text": {"type": "string"}},
            "required": ["text"],
            "additionalProperties": False,
        },
        "implementation": {
            "operation": "insert",
            "collection": "notes",
            "data_schema": {
                "type": "object",
                "properties": {"text": {"type": "string"}},
                "required": ["text"],
                "additionalProperties": False,
            },
        },
    }
    store.create_tool("home", bundle)
    with store.transaction() as db:
        db.execute(
            "INSERT INTO page(id,route,title,created_at,updated_at) VALUES(?,?,?,?,?)",
            ("other", "/other", "other", "2025-01-01", "2025-01-01"),
        )
    token = store.ensure_credential("home")
    other_token = store.ensure_credential("other")
    client = TestClient(
        web.create_app(),
        client=("127.0.0.1", 1234),
        headers={"host": "127.0.0.1:5190", "origin": "http://127.0.0.1:5190"},
    )
    headers = {"authorization": f"Bearer {token}"}
    catalog = client.get("/api/pages/home/tools", headers=headers)
    assert catalog.status_code == 200
    assert catalog.json()["tools"][0]["input_schema"] == bundle["input_schema"]
    assert "implementation" not in catalog.text and "credential" not in catalog.text
    invalid = client.post(
        "/api/pages/home/tools/add_note/invoke",
        headers=headers,
        json={"arguments": {"text": 7}, "version": 1},
    )
    assert invalid.status_code == 400
    assert "/text" in invalid.text and "7" not in invalid.text
    missing_version = client.post(
        "/api/pages/home/tools/add_note/invoke",
        headers=headers,
        json={"arguments": {"text": "no write"}},
    )
    assert missing_version.status_code == 400
    created = client.post(
        "/api/pages/home/tools/add_note/invoke",
        headers=headers,
        json={"arguments": {"text": "ok"}, "version": 1},
    )
    assert created.status_code == 200
    assert client.get("/api/pages/home/records/notes", headers=headers).json()[0]["text"] == "ok"
    stale = client.post(
        "/api/pages/home/tools/add_note/invoke",
        headers=headers,
        json={"arguments": {"text": "no write"}, "version": 2},
    )
    assert stale.status_code == 409
    assert (
        client.post(
            "/api/pages/home/tools/missing/invoke",
            headers=headers,
            json={"arguments": {}, "version": 1},
        ).status_code
        == 404
    )
    assert client.get("/api/pages/home/tools").status_code == 403
    other_headers = {"authorization": f"Bearer {other_token}"}
    assert client.get("/api/pages/home/tools", headers=other_headers).status_code == 403
    assert (
        client.post(
            "/api/pages/home/tools/add_note/invoke",
            headers=other_headers,
            json={"arguments": {"text": "hidden"}, "version": 1},
        ).status_code
        == 403
    )
    cross_origin = {**headers, "origin": "https://synthetic.example"}
    assert client.get("/api/pages/home/tools", headers=cross_origin).status_code == 403
    assert (
        client.post(
            "/api/pages/home/tools/add_note/invoke",
            headers=cross_origin,
            json={"arguments": {"text": "hidden"}, "version": 1},
        ).status_code
        == 403
    )
    with store.transaction() as db:
        audit = db.execute(
            "SELECT version_digest FROM audit WHERE action='invoke:add_note'"
        ).fetchone()
    assert audit["version_digest"] == bundle_digest(validate_bundle(bundle))


def test_stale_revision_is_structured_in_browser_and_mcp(monkeypatch, tmp_path: Path) -> None:
    root = tmp_path / "achilles"
    monkeypatch.setenv("ACHILLES_HOME", str(root))
    store = PageStore(root)
    store.set_create_mode("home", True)
    schema = {
        "type": "object",
        "properties": {"text": {"type": "string"}},
        "required": ["text"],
        "additionalProperties": False,
    }
    bundle = {
        "format_version": 1,
        "kind": "data_operation",
        "name": "update_note",
        "description": "update a note",
        "input_schema": {
            "type": "object",
            "properties": {
                "record_id": {"type": "string"},
                "revision": {"type": "integer"},
                "text": {"type": "string"},
            },
            "required": ["record_id", "revision", "text"],
            "additionalProperties": False,
        },
        "implementation": {
            "operation": "update",
            "collection": "notes",
            "data_schema": schema,
        },
    }
    store.create_tool("home", bundle)
    with store.transaction() as db:
        db.execute(
            "INSERT INTO page_record(page_id,collection,record_id,version,revision,document,"
            "created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)",
            ("home", "notes", "note-1", 1, 1, '{"text":"first"}', "now", "now"),
        )
    token = store.ensure_credential("home")
    browser_headers = {
        "host": "127.0.0.1:5190",
        "origin": "http://127.0.0.1:5190",
        "authorization": f"Bearer {token}",
    }
    mcp_headers = {
        "host": "127.0.0.1:5190",
        "authorization": f"Bearer {token}",
        "accept": "application/json, text/event-stream",
        "content-type": "application/json",
    }
    arguments = {"record_id": "note-1", "revision": 1, "text": "second"}
    with TestClient(web.create_app(), client=("127.0.0.1", 1234)) as client:
        catalog = client.get("/api/pages/home/tools", headers=browser_headers).json()
        browser = client.post(
            "/api/pages/home/tools/update_note/invoke",
            headers=browser_headers,
            json={"arguments": arguments, "version": 1},
        )
        stale_browser = client.post(
            "/api/pages/home/tools/update_note/invoke",
            headers=browser_headers,
            json={"arguments": arguments, "version": 1},
        )
        initialized = client.post(
            "/mcp/",
            headers=mcp_headers,
            json={
                "jsonrpc": "2.0",
                "id": 1,
                "method": "initialize",
                "params": {
                    "protocolVersion": "2025-03-26",
                    "capabilities": {},
                    "clientInfo": {"name": "test", "version": "1"},
                },
            },
        )
        mcp_headers["mcp-session-id"] = initialized.headers["mcp-session-id"]
        client.post(
            "/mcp/",
            headers=mcp_headers,
            json={"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}},
        )
        agent = client.post(
            "/mcp/",
            headers=mcp_headers,
            json={
                "jsonrpc": "2.0",
                "id": 4,
                "method": "tools/call",
                "params": {
                    "name": "update_note",
                    "arguments": {"record_id": "note-1", "revision": 2, "text": "third"},
                },
            },
        ).json()["result"]
        stale_mcp = client.post(
            "/mcp/",
            headers=mcp_headers,
            json={
                "jsonrpc": "2.0",
                "id": 3,
                "method": "tools/call",
                "params": {"name": "update_note", "arguments": arguments},
            },
        ).json()["result"]
        stale_mcp_error = json.loads(stale_mcp["content"][0]["text"])
        current = stale_mcp_error["current"]
        retry = client.post(
            "/mcp/",
            headers=mcp_headers,
            json={
                "jsonrpc": "2.0",
                "id": 5,
                "method": "tools/call",
                "params": {
                    "name": "update_note",
                    # the retry rebuilds its change from the live record, not the stale arguments
                    "arguments": {
                        "record_id": current["record_id"],
                        "revision": current["revision"],
                        "text": current["text"] + " and second",
                    },
                },
            },
        ).json()["result"]
    expected_base = {
        "code": "conflict",
        "path": "/revision",
        "expected": "current record revision",
        "hint": "the record changed; compare current with your change and retry with "
        "current.revision only if your change still applies",
    }
    assert catalog["tools"][0]["input_schema"]["required"] == [
        "record_id",
        "revision",
        "text",
    ]
    assert browser.status_code == 200 and browser.json()["revision"] == 2
    assert stale_browser.status_code == 409
    # the conflict carries the live record, so a caller can retry without a separate read
    assert stale_browser.json()["error"] == {
        **expected_base,
        "current": {"text": "second", "record_id": "note-1", "revision": 2},
    }
    assert stale_mcp["isError"] is True
    # the conflict shows the other writer's value, so the agent sees what changed
    assert stale_mcp_error == {
        **expected_base,
        "current": {"text": "third", "record_id": "note-1", "revision": 3},
    }
    assert not agent.get("isError")
    assert not retry.get("isError")
    retried = json.loads(retry["content"][0]["text"])
    assert (retried["text"], retried["revision"]) == ("third and second", 4)
    # each write is audited with who made it and which record; conflicts write no audit row.
    with store.transaction() as db:
        rows = db.execute(
            "SELECT actor, record_id FROM audit WHERE action='invoke:update_note' ORDER BY id"
        ).fetchall()
    assert [tuple(row) for row in rows] == [
        ("form", "note-1"),
        ("agent", "note-1"),
        ("agent", "note-1"),
    ]


def test_browser_and_mcp_share_value_blind_validation_errors(monkeypatch, tmp_path: Path) -> None:
    root = tmp_path / "achilles"
    monkeypatch.setenv("ACHILLES_HOME", str(root))
    store = PageStore(root)
    store.set_create_mode("home", True)
    bundle = {
        "format_version": 1,
        "kind": "data_operation",
        "name": "add_note",
        "description": "add a note",
        "input_schema": {
            "type": "object",
            "properties": {"text": {"type": "string"}},
            "required": ["text"],
            "additionalProperties": False,
        },
        "implementation": {
            "operation": "insert",
            "collection": "notes",
            "data_schema": {
                "type": "object",
                "properties": {"text": {"type": "string"}},
                "required": ["text"],
                "additionalProperties": False,
            },
        },
    }
    store.create_tool("home", bundle)
    token = store.ensure_credential("home")
    browser_headers = {
        "host": "127.0.0.1:5190",
        "origin": "http://127.0.0.1:5190",
        "authorization": f"Bearer {token}",
    }
    mcp_headers = {
        "host": "127.0.0.1:5190",
        "authorization": f"Bearer {token}",
        "accept": "application/json, text/event-stream",
        "content-type": "application/json",
    }
    with TestClient(web.create_app(), client=("127.0.0.1", 1234)) as client:
        browser = client.post(
            "/api/pages/home/tools/add_note/invoke",
            headers=browser_headers,
            json={"arguments": {"text": 7}, "version": 1},
        )
        initialized = client.post(
            "/mcp/",
            headers=mcp_headers,
            json={
                "jsonrpc": "2.0",
                "id": 1,
                "method": "initialize",
                "params": {
                    "protocolVersion": "2025-03-26",
                    "capabilities": {},
                    "clientInfo": {"name": "test", "version": "1"},
                },
            },
        )
        mcp_headers["mcp-session-id"] = initialized.headers["mcp-session-id"]
        client.post(
            "/mcp/",
            headers=mcp_headers,
            json={"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}},
        )
        called = client.post(
            "/mcp/",
            headers=mcp_headers,
            json={
                "jsonrpc": "2.0",
                "id": 3,
                "method": "tools/call",
                "params": {"name": "add_note", "arguments": {"text": 7}},
            },
        ).json()["result"]
        malformed = client.post(
            "/api/pages/home/tools/add_note/invoke",
            headers={**browser_headers, "content-type": "application/json"},
            content="{",
        )
    expected = {"code": "invalid_input", "path": "/text", "expected": "type: string"}
    assert browser.status_code == 400
    assert browser.json()["error"] == expected
    assert called["isError"] is True
    assert json.loads(called["content"][0]["text"]) == expected
    assert "7" not in called["content"][0]["text"]
    assert malformed.status_code == 400
    assert malformed.json()["error"] == {
        "code": "invalid_input",
        "path": "",
        "expected": "valid JSON object",
    }


def test_list_tool_filters_by_record_id_through_mcp(monkeypatch, tmp_path: Path) -> None:
    root = tmp_path / "achilles"
    monkeypatch.setenv("ACHILLES_HOME", str(root))
    store = PageStore(root)
    store.set_create_mode("home", True)
    bundle = {
        "format_version": 1,
        "kind": "data_operation",
        "name": "list_tasks",
        "description": "list tasks",
        "input_schema": {"type": "object", "additionalProperties": False},
        "implementation": {
            "operation": "list",
            "collection": "tasks",
            "data_schema": {
                "type": "object",
                "properties": {"title": {"type": "string"}},
                "additionalProperties": True,
            },
        },
    }
    store.create_tool("home", bundle)
    with store.transaction() as db:
        db.executemany(
            "INSERT INTO page_record(page_id,collection,record_id,version,revision,document,"
            "created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)",
            [
                ("home", "tasks", "task-1", 1, 1, '{"title":"first"}', "now", "now"),
                ("home", "tasks", "task-2", 1, 1, '{"title":"second"}', "now", "now"),
            ],
        )
    token = store.ensure_credential("home")
    mcp_headers = {
        "host": "127.0.0.1:5190",
        "authorization": f"Bearer {token}",
        "accept": "application/json, text/event-stream",
        "content-type": "application/json",
    }

    def call(client, request_id, name, arguments):
        return client.post(
            "/mcp/",
            headers=mcp_headers,
            json={
                "jsonrpc": "2.0",
                "id": request_id,
                "method": "tools/call",
                "params": {"name": name, "arguments": arguments},
            },
        ).json()["result"]

    with TestClient(web.create_app(), client=("127.0.0.1", 1234)) as client:
        initialized = client.post(
            "/mcp/",
            headers=mcp_headers,
            json={
                "jsonrpc": "2.0",
                "id": 1,
                "method": "initialize",
                "params": {
                    "protocolVersion": "2025-03-26",
                    "capabilities": {},
                    "clientInfo": {"name": "test", "version": "1"},
                },
            },
        )
        mcp_headers["mcp-session-id"] = initialized.headers["mcp-session-id"]
        client.post(
            "/mcp/",
            headers=mcp_headers,
            json={"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}},
        )
        by_id = call(client, 3, "list_tasks", {"where": {"field": "record_id", "equals": "task-2"}})
        unknown_id = call(
            client, 4, "list_tasks", {"where": {"field": "record_id", "equals": "task-9"}}
        )
        unknown_field = call(
            client, 5, "list_tasks", {"where": {"field": "name", "equals": "task-2"}}
        )
    assert not by_id.get("isError")
    found = json.loads(by_id["content"][0]["text"])
    assert [record["record_id"] for record in found] == ["task-2"]
    assert found[0]["title"] == "second"
    assert not unknown_id.get("isError")
    assert json.loads(unknown_id["content"][0]["text"]) == []
    assert unknown_field["isError"] is True
    error = json.loads(unknown_field["content"][0]["text"])
    assert error["path"] == "/where/field"
    assert "record_id" in error["hint"]
    assert "title" in error["hint"]


def test_inspect_page_description_states_page_and_create_mode(monkeypatch, tmp_path: Path) -> None:
    root = tmp_path / "achilles"
    monkeypatch.setenv("ACHILLES_HOME", str(root))
    store = PageStore(root)
    token = store.ensure_credential("home")
    mcp_headers = {
        "host": "127.0.0.1:5190",
        "authorization": f"Bearer {token}",
        "accept": "application/json, text/event-stream",
        "content-type": "application/json",
    }

    def inspect_description(client):
        listed = client.post(
            "/mcp/",
            headers=mcp_headers,
            json={"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}},
        ).json()["result"]["tools"]
        return next(tool for tool in listed if tool["name"] == "inspect_page")["description"]

    with TestClient(web.create_app(), client=("127.0.0.1", 1234)) as client:
        initialized = client.post(
            "/mcp/",
            headers=mcp_headers,
            json={
                "jsonrpc": "2.0",
                "id": 1,
                "method": "initialize",
                "params": {
                    "protocolVersion": "2025-03-26",
                    "capabilities": {},
                    "clientInfo": {"name": "test", "version": "1"},
                },
            },
        )
        mcp_headers["mcp-session-id"] = initialized.headers["mcp-session-id"]

        off = inspect_description(client)
        assert "'/'" in off
        assert "create mode is currently OFF" in off

        # toggling create mode mid-chat must regenerate the catalog, not leave stale text
        store.set_create_mode("home", True)
        on = inspect_description(client)
        assert "create mode is currently ON" in on


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
    client = chat_client()
    assert (
        client.put("/api/pages/home/session", json={"session_id": "session-a"}).status_code == 200
    )

    def save(value: str):
        with chat_client() as active:
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
        assert db.execute("PRAGMA user_version").fetchone()[0] == 4
    for sidecar in (home / "achilles.sqlite3-wal", home / "achilles.sqlite3-shm"):
        if sidecar.exists():
            assert sidecar.stat().st_mode & 0o777 == 0o600


def chat_client() -> TestClient:
    return TestClient(
        web.create_app(),
        client=("127.0.0.1", 1234),
        headers={"host": "127.0.0.1:5190", "origin": "http://127.0.0.1:5190"},
    )


def test_page_index_is_safe_bounded_and_origin_protected(tmp_path: Path) -> None:
    store = PageStore(tmp_path / "achilles")
    with store.transaction() as db:
        db.execute(
            "INSERT INTO page(id,route,title,created_at,updated_at,create_mode,credential_hash) "
            "VALUES(?,?,?,?,?,?,?)",
            ("reading", "/reading", "reading", "2025-01-01", "2025-01-02", 1, "secret"),
        )
        db.execute("UPDATE page SET created_by_page_id='home' WHERE id='reading'")
        db.execute(
            "INSERT INTO chat(session_id,page_id,created_at,updated_at) VALUES(?,?,?,?)",
            ("reading-chat", "reading", "2025-01-01", "2025-01-02"),
        )
    client = chat_client()
    response = client.get("/api/pages")
    assert response.status_code == 200
    payload = response.json()
    assert {page["route"] for page in payload["pages"]} == {"/", "/reading"}
    reading = next(page for page in payload["pages"] if page["route"] == "/reading")
    assert reading["chat_count"] == 1
    assert reading["created_by_route"] == "/"
    assert not {"credential_hash", "workspace", "zeta_session_id"} & reading.keys()
    assert client.get("/api/pages?limit=201").status_code == 400
    assert client.get("/api/pages?limit=invalid").status_code == 400
    limited = client.get("/api/pages?limit=1")
    assert limited.status_code == 200
    assert len(limited.json()["pages"]) == 1
    assert client.get("/api/pages", headers={"origin": "http://evil.test"}).status_code == 403

    with store.transaction() as db:
        for index in range(199):
            db.execute(
                "INSERT INTO page(id,route,title,created_at,updated_at) VALUES(?,?,?,?,?)",
                (
                    f"page-{index}",
                    f"/page-{index}",
                    f"page {index}",
                    "2099-03-01" if index == 198 else "2025-02-01",
                    "2025-02-01",
                ),
            )
    capped = client.get("/api/pages?limit=200").json()
    assert len(capped["pages"]) == 200
    assert [page["id"] for page in capped["pages"][:2]] == ["home", "page-198"]
    assert capped["pages"][1]["created_at"] >= capped["pages"][-1]["created_at"]
    assert capped["next"]
    remainder = client.get(f"/api/pages?limit=200&before={capped['next']}").json()
    assert len(remainder["pages"]) == 1
    assert remainder["next"] is None


def test_chat_list_orders_pages_and_uses_stable_cursor(tmp_path: Path) -> None:
    store = PageStore(tmp_path / "achilles")
    with store.transaction() as db:
        db.execute(
            "INSERT INTO page(id,route,title,created_at,updated_at) VALUES(?,?,?,?,?)",
            ("notes", "/notes", "notes", "2025-01-01", "2025-01-01"),
        )
        for session_id, page_id, stamp in (
            ("a", "home", "2025-01-01"),
            ("b", "notes", "2025-01-02"),
            ("c", "home", "2025-01-02"),
            ("d", "notes", "2025-01-02"),
        ):
            db.execute(
                "INSERT INTO chat(session_id,page_id,title,created_at,updated_at) "
                "VALUES(?,?,?,?,?)",
                (session_id, page_id, f"chat {session_id}", stamp, stamp),
            )
    client = chat_client()
    first = client.get("/api/chats?limit=2").json()
    first_rows = first["chats"] if isinstance(first, dict) else first
    cursor = first["next"] if isinstance(first, dict) else first_rows[-1]["session_id"]
    assert [row["session_id"] for row in first_rows] == ["d", "c"]
    assert client.patch("/api/chats/c", json={"title": "renamed"}).status_code == 200
    second = client.get(f"/api/chats?limit=2&before={cursor}").json()
    second_rows = second["chats"] if isinstance(second, dict) else second
    assert [row["session_id"] for row in second_rows] == ["b", "a"]
    assert second["next"] is None
    assert first_rows[0]["page_route"] == "/notes"
    assert first_rows[0]["page_title"] == "notes"
    client.patch("/api/chats/a", json={"last_state": "approval"})
    filtered = client.get("/api/chats?limit=1&q=chat%20d").json()
    assert [row["session_id"] for row in filtered["chats"]] == ["d"]
    assert filtered["approval_count"] == 1
    with store.transaction() as db:
        db.execute("UPDATE chat SET purpose='page_build' WHERE session_id='a'")
    assert client.get("/api/chats?limit=1").json()["approval_count"] == 0
    assert client.get("/api/chats?limit=201").status_code == 400
    assert client.get("/api/chats?limit=invalid").status_code == 400
    assert client.get("/api/chats?before=missing").status_code == 400


def test_chat_order_and_time_follow_the_last_message_only(monkeypatch) -> None:
    clock = iter(f"2025-01-01T00:00:{second:02d}" for second in range(60))
    monkeypatch.setattr("achilles.pages.now", lambda: next(clock))
    client = chat_client()

    def order():
        return [row["session_id"] for row in client.get("/api/chats").json()["chats"]]

    def stamp(session_id):
        return client.get(f"/api/chats?include={session_id}").json()["chats"]

    for session_id in ("old", "new"):
        client.post("/api/pages/home/chats", json={"session_id": session_id})
        client.patch(f"/api/chats/{session_id}", json={"first_message": session_id})
        client.patch(f"/api/chats/{session_id}", json={"last_state": "running"})
        client.patch(f"/api/chats/{session_id}", json={"last_state": "idle"})
    assert order() == ["new", "old"]
    before = {row["session_id"]: row["updated_at"] for row in stamp("old")}
    # opening the older chat: attach, re-register, history repair and re-reported states
    assert client.put("/api/pages/home/session", json={"session_id": "old"}).status_code == 200
    client.post("/api/pages/home/chats", json={"session_id": "old"})
    client.patch("/api/chats/old", json={"first_message": "repaired"})
    client.patch("/api/chats/old", json={"last_state": "idle"})
    client.patch("/api/chats/old", json={"title": "zeta auto name"})
    # renaming and clearing a name
    client.patch("/api/chats/old", json={"title": "renamed", "titled_by_user": True})
    client.patch("/api/chats/old", json={"title": None, "titled_by_user": False})
    assert order() == ["new", "old"]
    assert {row["session_id"]: row["updated_at"] for row in stamp("old")} == before
    # a new message starts a turn, so the chat moves up and its time changes
    client.patch("/api/chats/old", json={"last_state": "running"})
    assert order() == ["old", "new"]
    client.patch("/api/chats/old", json={"last_state": "approval"})
    client.patch("/api/chats/new", json={"last_state": "failed"})
    assert order() == ["new", "old"]
    # re-reporting the same waiting state on attach does not move it again
    client.patch("/api/chats/old", json={"last_state": "approval"})
    assert order() == ["new", "old"]


def test_chat_search_escapes_like_wildcards(tmp_path: Path) -> None:
    store = PageStore(tmp_path / "achilles")
    with store.transaction() as db:
        for session_id, title in (
            ("percent", "100% done"),
            ("underscore", "under_score"),
            ("plain", "plain"),
        ):
            db.execute(
                "INSERT INTO chat(session_id,page_id,title,created_at,updated_at) "
                "VALUES(?,?,?,?,?)",
                (session_id, "home", title, "2025-01-01", "2025-01-01"),
            )
    client = chat_client()
    assert [row["session_id"] for row in client.get("/api/chats?q=%25").json()["chats"]] == [
        "percent"
    ]
    assert [row["session_id"] for row in client.get("/api/chats?q=_").json()["chats"]] == [
        "underscore"
    ]
    assert [row["session_id"] for row in client.get("/api/chats?q=PLAIN").json()["chats"]] == [
        "plain"
    ]


def test_register_chat_is_idempotent_and_rejects_another_page(tmp_path: Path) -> None:
    store = PageStore(tmp_path / "achilles")
    with store.transaction() as db:
        db.execute(
            "INSERT INTO page(id,route,title,created_at,updated_at) VALUES(?,?,?,?,?)",
            ("other", "/other", "other", "2025-01-01", "2025-01-01"),
        )
    client = chat_client()
    path = "/api/pages/home/chats"
    assert client.post(path, json=[]).status_code == 400
    assert client.post(path, json={"session_id": "new-session"}).status_code == 200
    with store.transaction() as db:
        db.execute("UPDATE chat SET updated_at='old' WHERE session_id='new-session'")
    response = client.post(path, json={"session_id": "new-session"})
    assert response.status_code == 200
    assert response.json()["updated_at"] == "old"
    assert response.json().get("purpose") == "chat"
    with store.transaction() as db:
        assert (
            db.execute("SELECT COUNT(*) FROM chat WHERE session_id='new-session'").fetchone()[0]
            == 1
        )
    assert (
        client.post("/api/pages/other/chats", json={"session_id": "new-session"}).status_code == 409
    )


def test_register_page_build_chat(tmp_path: Path) -> None:
    store = PageStore(tmp_path / "achilles")
    client = chat_client()
    path = "/api/pages/home/chats"
    body = {"session_id": "build-chat", "purpose": "page_build"}
    response = client.post(path, json=body)
    assert response.status_code == 200
    assert response.json().get("purpose") == "page_build"
    assert store.chat("build-chat")["purpose"] == "page_build"
    assert store.chats(1, include="build-chat")[0]["purpose"] == "page_build"
    assert client.post(path, json=body).json() == response.json()


def test_register_chat_rejects_a_conflicting_purpose(tmp_path: Path) -> None:
    store = PageStore(tmp_path / "achilles")
    client = chat_client()
    path = "/api/pages/home/chats"
    initial = client.post(path, json={"session_id": "registered"})
    assert initial.status_code == 200
    response = client.post(path, json={"session_id": "registered", "purpose": "page_build"})
    assert response.status_code == 409
    assert response.text == "session already registered with a different purpose"
    assert store.chat("registered") == initial.json()


def test_register_chat_rejects_invalid_purpose_without_writing(tmp_path: Path) -> None:
    store = PageStore(tmp_path / "achilles")
    client = chat_client()
    for purpose in ("unknown", "", None, False, []):
        response = client.post(
            "/api/pages/home/chats", json={"session_id": "invalid", "purpose": purpose}
        )
        assert response.status_code == 400
        assert store.chats(1, include="invalid") == []


def test_patch_chat_updates_fields_and_validates_input() -> None:
    client = chat_client()
    client.post("/api/pages/home/chats", json={"session_id": "editable"})
    assert (
        client.get("/api/chats?limit=1&include=editable").json()["chats"][0]["titled_by_user"]
        is False
    )
    response = client.patch(
        "/api/chats/editable",
        json={"title": "renamed", "last_state": "approval", "titled_by_user": True},
    )
    assert response.status_code == 200
    assert response.json()["title"] == "renamed"
    assert response.json()["last_state"] == "approval"
    assert response.json()["titled_by_user"] is True
    auto_name = client.patch("/api/chats/editable", json={"title": "zeta auto name"})
    assert auto_name.json()["title"] == "renamed"
    for body in (
        {},
        {"title": 1},
        {"title": "x" * 201},
        {"last_state": "unknown"},
        {"unknown": True},
        {"titled_by_user": "true"},
        {"title": "  ", "titled_by_user": True},
    ):
        assert client.patch("/api/chats/editable", json=body).status_code == 400
    assert (
        client.patch("/api/chats/editable", json={"titled_by_user": False}).json()["titled_by_user"]
        is False
    )
    assert client.patch("/api/chats/missing", json={"title": "x"}).status_code == 404


def test_chat_routes_require_same_origin() -> None:
    client = TestClient(web.create_app(), client=("127.0.0.1", 1234))
    headers = {"host": "127.0.0.1:5190", "origin": "http://evil.test"}
    assert client.get("/api/chats", headers=headers).status_code == 403
    assert (
        client.put(
            "/api/pages/home/session", headers=headers, json={"session_id": "session"}
        ).status_code
        == 403
    )
    assert (
        client.post(
            "/api/pages/home/chats", headers=headers, json={"session_id": "session"}
        ).status_code
        == 403
    )
    assert (
        client.patch("/api/chats/session", headers=headers, json={"title": "x"}).status_code == 403
    )


def test_json_routes_reject_a_body_that_is_not_a_json_object(tmp_path) -> None:
    token = PageStore(tmp_path / "achilles").ensure_credential("home")
    client = TestClient(web.create_app(), client=("127.0.0.1", 1234), raise_server_exceptions=False)
    headers = {"host": "127.0.0.1:5190", "origin": "http://127.0.0.1:5190"}
    bearer = {**headers, "authorization": f"Bearer {token}"}
    for method, path, sent in (
        ("POST", "/api/pages/home/runtime-error", bearer),
        ("PUT", "/api/pages/home/session", headers),
        ("POST", "/api/pages/home/chats", headers),
        ("PATCH", "/api/chats/session", headers),
    ):
        for body in (b"{not json", b"[1]"):
            response = client.request(method, path, headers=sent, content=body)
            assert response.status_code == 400, (path, body, response.status_code)


def test_rollback_requires_page_bearer_and_same_origin(tmp_path):
    store = PageStore(tmp_path / "achilles")
    store.set_create_mode("home", True)
    bundle = {
        "format_version": 1,
        "kind": "data_operation",
        "name": "annotate_trace",
        "description": "annotate",
        "input_schema": {"type": "object"},
        "implementation": {
            "operation": "insert",
            "collection": "annotations",
            "data_schema": {"type": "object"},
        },
    }
    store.create_tool("home", bundle)
    store.create_tool("home", bundle)
    store.set_create_mode("home", True)
    with store.transaction() as db:
        db.execute(
            "INSERT INTO page(id,route,title,created_at,updated_at) VALUES(?,?,?,?,?)",
            ("other", "/other", "other", "2025-01-01", "2025-01-01"),
        )
    home_token = store.ensure_credential("home")
    other_token = store.ensure_credential("other")
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


def test_records_reject_a_missing_or_invalid_json_body(tmp_path: Path) -> None:
    store = PageStore(tmp_path / "achilles")
    own = {"authorization": f"Bearer {store.ensure_credential('home')}"}
    client = TestClient(web.create_app())
    book = client.post("/api/pages/home/records/books", headers=own, json={"title": "dune"})
    path = f"/api/pages/home/records/books/{book.json()['record_id']}"
    for method, url in (("POST", "/api/pages/home/records/books"), ("PATCH", path)):
        for content in (b"", b"{", b"[1]"):
            response = client.request(method, url, headers=own, content=content)
            assert response.status_code == 400, (method, content, response.text)
            assert response.text == "body must be a JSON object"
    assert client.get("/api/pages/home/records/books", headers=own).json() == [book.json()]


def test_http_restores_follow_create_mode(tmp_path: Path) -> None:
    store = PageStore(tmp_path / "achilles")
    with store.transaction() as db:
        db.execute(
            "INSERT INTO page(id,route,title,created_at,updated_at) VALUES(?,?,?,?,?)",
            ("other", "/other", "other", "2025-01-01", "2025-01-01"),
        )
        for page_id in ("home", "other"):
            for version in (1, 2):
                db.execute(
                    "INSERT INTO code_revision(page_id,version,source,dependencies,digest,"
                    "created_at) VALUES(?,?,?,?,?,?)",
                    (page_id, version, f"v{version}", "{}", f"d{version}", "2025-01-01"),
                )
            db.execute("UPDATE page SET active_code_revision=2 WHERE id=?", (page_id,))
    bundle = {
        "format_version": 1,
        "kind": "data_operation",
        "name": "annotate_trace",
        "description": "annotate",
        "input_schema": {"type": "object"},
        "implementation": {
            "operation": "insert",
            "collection": "annotations",
            "data_schema": {"type": "object"},
        },
    }
    store.set_create_mode("home", True)
    store.create_tool("home", bundle)
    store.create_tool("home", bundle | {"description": "annotate v2"})
    store.set_create_mode("home", False)
    client = chat_client()

    def post(page_id: str, path: str) -> int:
        headers = {"authorization": f"Bearer {store.ensure_credential(page_id)}"}
        body = {"version": 1, "expected_version": 2}
        return client.post(f"/api/pages/{page_id}/{path}", headers=headers, json=body).status_code

    # with create mode off, home may not restore code or tools; another page restores its code
    assert post("home", "code/restore") == 403
    assert post("home", "tools/annotate_trace/rollback") == 403
    assert store.page("home")["active_code_revision"] == 2
    assert store.page_tools("home")[0]["version"] == 2
    assert post("other", "code/restore") == 200
    assert store.page("other")["active_code_revision"] == 3


def test_records_limit_order_and_total_header(tmp_path: Path) -> None:
    store = PageStore(tmp_path / "achilles")
    token = store.ensure_credential("home")
    with store.transaction() as db:
        for index in range(101):
            stamp = "2025-01-01T00:00:00+00:00"
            db.execute(
                "INSERT INTO page_record("
                "page_id,collection,record_id,version,document,created_at,updated_at"
                ") VALUES(?,?,?,?,?,?,?)",
                ("home", "events", str(index), 1, json.dumps({"value": index}), stamp, stamp),
            )
    client = TestClient(web.create_app())
    response = client.get(
        "/api/pages/home/records/events?limit=100",
        headers={"authorization": f"Bearer {token}"},
    )
    assert response.status_code == 200
    body = response.json()
    assert len(body) == 100
    assert body[0]["value"] == 100
    assert body[-1]["value"] == 1
    assert response.headers["x-achilles-total"] == "101"
    assert (
        client.get(
            "/api/pages/home/records/events?limit=101", headers={"authorization": f"Bearer {token}"}
        ).status_code
        == 400
    )


@pytest.mark.parametrize(
    ("field", "equals", "limit", "expected_ids", "expected_total"),
    [
        ("kind", "one", 100, ["one"], 1),
        ("kind", "none", 100, [], 0),
        ("kind", "shared", 1, ["shared-z"], 3),
        ("kind", "shared", 100, ["shared-z", "shared-a", "shared-old"], 3),
        ("value", 1, 100, ["number"], 1),
        ("value", "1", 100, ["string"], 1),
        ("value", True, 100, ["boolean"], 1),
        ("nullable", None, 100, ["null-missing", "null-explicit"], 2),
    ],
)
def test_filtered_records_observer_endpoint(
    tmp_path: Path,
    field: str,
    equals: object,
    limit: int,
    expected_ids: list[str],
    expected_total: int,
) -> None:
    store = PageStore(tmp_path / "achilles")
    token = store.ensure_credential("home")
    records = [
        ("one", {"kind": "one", "nullable": "set"}, "2025-01-01"),
        ("shared-old", {"kind": "shared", "nullable": "set"}, "2025-01-01"),
        ("shared-a", {"kind": "shared", "nullable": "set"}, "2025-01-03"),
        ("shared-z", {"kind": "shared", "nullable": "set"}, "2025-01-03"),
        ("number", {"value": 1, "nullable": "set"}, "2025-01-01"),
        ("string", {"value": "1", "nullable": "set"}, "2025-01-01"),
        ("boolean", {"value": True, "nullable": "set"}, "2025-01-01"),
        ("null-explicit", {"nullable": None}, "2025-01-04"),
        ("null-missing", {}, "2025-01-05"),
    ]
    with store.transaction() as db:
        db.executemany(
            "INSERT INTO page_record("
            "page_id,collection,record_id,version,document,created_at,updated_at"
            ") VALUES(?,?,?,?,?,?,?)",
            [
                ("home", "items", record_id, 1, json.dumps(document), stamp, stamp)
                for record_id, document, stamp in records
            ],
        )

    response = TestClient(web.create_app(), raise_server_exceptions=False).get(
        "/api/pages/home/records/items",
        params={"field": field, "equals": json.dumps(equals), "limit": limit},
        headers={"authorization": f"Bearer {token}"},
    )

    assert response.status_code == 200
    assert [record["record_id"] for record in response.json()] == expected_ids
    assert response.headers["x-achilles-total"] == str(expected_total)


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
    static = tmp_path / "dist"
    static.mkdir()
    (static / "index.html").write_text("<html><body></body></html>")
    monkeypatch.setattr(web, "_static_root", lambda: static)
    monkeypatch.setenv("ACHILLES_ZETA_DISCOVERY", str(discovery))
    client = TestClient(
        web.create_app(),
        client=("127.0.0.1", 1234),
        headers={
            "origin": "http://127.0.0.1:5190",
            "host": "127.0.0.1:5190",
            "sec-fetch-site": "same-origin",
        },
    )
    shell = client.get("/")
    assert shell.status_code == 200
    token = re.search(r'<meta name="achilles-shell" content="([^"]+)">', shell.text)
    assert token is not None
    response = client.get("/api/zeta/discovery", headers={"x-achilles-shell": token.group(1)})
    assert response.status_code == 200
    assert response.json()["url"] == "ws://127.0.0.1:8765"
    assert response.json()["controller_token"] == "controller-secret"


def test_forged_browser_headers_cannot_read_shell_secrets(monkeypatch, tmp_path: Path) -> None:
    discovery = tmp_path / "discovery.json"
    discovery.write_text(
        json.dumps(
            {
                "port": 8765,
                "controller_token": "controller-secret",
                "observer_token": "observer-secret",
                "pid": os.getpid(),
                "origins": ["http://127.0.0.1:5190"],
            }
        )
    )
    monkeypatch.setenv("ACHILLES_ZETA_DISCOVERY", str(discovery))
    client = TestClient(
        web.create_app(),
        client=("127.0.0.1", 1234),
        headers={
            "origin": "http://127.0.0.1:5190",
            "host": "127.0.0.1:5190",
            "sec-fetch-site": "same-origin",
        },
    )
    discovery_response = client.get("/api/zeta/discovery")
    credential_response = client.get("/api/pages/home/credential")
    assert discovery_response.status_code == 403
    assert credential_response.status_code == 403
    assert "secret" not in discovery_response.text + credential_response.text


def test_non_ascii_shell_secret_is_forbidden() -> None:
    client = TestClient(
        web.create_app(),
        client=("127.0.0.1", 1234),
        headers={"origin": "http://127.0.0.1:5190", "host": "127.0.0.1:5190"},
    )

    response = client.get("/api/pages/home/credential", headers={"x-achilles-shell": b"\xe9"})

    assert response.status_code == 403


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


@pytest.mark.parametrize(
    ("discovery", "port", "start"),
    [
        (None, 5191, None),
        ("home", 5191, "make dev"),
        ("home", 5297, "make dev PORT=5297"),
        (
            "attached",
            5190,
            "zeta serve --ws 0 --ws-discovery {path} --ws-origin http://127.0.0.1:5190",
        ),
    ],
)
def test_stopped_zeta_names_the_command_for_this_achilles(
    monkeypatch, tmp_path: Path, discovery: str | None, port: int, start: str | None
) -> None:
    monkeypatch.setenv("ACHILLES_HOME", str(tmp_path / "achilles"))
    monkeypatch.setenv("ZETA_HOME", str(tmp_path / "zeta"))
    path = tmp_path / "achilles/run/serve.json" if discovery == "home" else tmp_path / "serve.json"
    if discovery:
        monkeypatch.setenv("ACHILLES_ZETA_DISCOVERY", str(path))
    else:
        monkeypatch.delenv("ACHILLES_ZETA_DISCOVERY", raising=False)
    origin = f"http://127.0.0.1:{port}"
    response = TestClient(web.create_app(), client=("127.0.0.1", 1234)).get(
        "/api/zeta/discovery", headers={"origin": origin, "host": f"127.0.0.1:{port}"}
    )
    assert response.status_code == 503
    assert response.json()["start"] == (start and start.format(path=path))


def test_chat_list_includes_a_chat_only_after_its_first_message(tmp_path: Path) -> None:
    client = chat_client()
    client.post("/api/pages/home/chats", json={"session_id": "sent"})
    first = client.patch("/api/chats/sent", json={"first_message": "  about birds  "}).json()
    client.post("/api/pages/home/chats", json={"session_id": "draft"})
    assert first["message_sent"] is True
    assert first["first_title"] == first["title"] == "about birds"
    # the never-sent chat is newest, yet the list and its count come only from sent chats
    listed = client.get("/api/chats?limit=1").json()
    assert [row["session_id"] for row in listed["chats"]] == ["sent"]
    assert listed["next"] is None
    included = client.get("/api/chats?include=draft").json()["chats"]
    assert [(row["session_id"], row["message_sent"]) for row in included] == [
        ("draft", False),
        ("sent", True),
    ]
    again = client.patch("/api/chats/sent", json={"first_message": "later text"}).json()
    assert again["first_title"] == "about birds"
    client.patch("/api/chats/sent", json={"title": "bird notes", "titled_by_user": True})
    cleared = client.patch("/api/chats/sent", json={"title": None, "titled_by_user": False})
    assert cleared.json()["title"] is None
    assert cleared.json()["first_title"] == "about birds"
    assert [row["session_id"] for row in client.get("/api/chats?q=birds").json()["chats"]] == [
        "sent"
    ]
    for body in ({"first_message": 1}, {"first_message": "x" * 201}):
        assert client.patch("/api/chats/sent", json=body).status_code == 400


def test_a_chat_whose_turn_ran_is_listed_without_its_first_message_record() -> None:
    client = chat_client()
    for session_id in ("ran", "draft"):
        client.post("/api/pages/home/chats", json={"session_id": session_id})
    # the first-message PATCH was lost, but the run state proves a turn ran
    assert client.patch("/api/chats/ran", json={"last_state": "running"}).json()["message_sent"]
    assert not client.patch("/api/chats/draft", json={"last_state": "idle"}).json()["message_sent"]
    listed = client.get("/api/chats").json()["chats"]
    assert [row["session_id"] for row in listed] == ["ran"]


def test_a_first_message_cut_through_an_emoji_is_stored_without_the_half() -> None:
    client = chat_client()
    client.post("/api/pages/home/chats", json={"session_id": "cut"})
    # a lone surrogate (half an emoji) must never reach sqlite, which cannot encode it
    body = '{"first_message": "' + "a" * 199 + '\\ud83d"}'
    response = client.patch(
        "/api/chats/cut", content=body, headers={"content-type": "application/json"}
    )
    assert response.status_code == 200
    assert response.json()["first_title"] == "a" * 199
    assert response.json()["message_sent"] is True
    renamed = client.patch(
        "/api/chats/cut",
        content='{"title": "x\\ude00", "titled_by_user": true}',
        headers={"content-type": "application/json"},
    )
    assert renamed.status_code == 200
    assert renamed.json()["title"] == "x"


def test_chats_from_a_database_without_the_sent_marker_stay_listed(tmp_path: Path) -> None:
    home = tmp_path / "achilles"
    home.mkdir(mode=0o700)
    with sqlite3.connect(home / "achilles.sqlite3") as db:
        db.execute(
            "CREATE TABLE page (id TEXT PRIMARY KEY, route TEXT NOT NULL UNIQUE, "
            "title TEXT NOT NULL, zeta_session_id TEXT, active_layout_version INTEGER, "
            "created_at TEXT NOT NULL, updated_at TEXT NOT NULL)"
        )
        db.execute(
            "CREATE TABLE chat (session_id TEXT PRIMARY KEY, page_id TEXT NOT NULL, title TEXT, "
            "created_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_state TEXT, "
            "titled_by_user INTEGER NOT NULL DEFAULT 0)"
        )
        db.execute("INSERT INTO page VALUES ('home','/','home',NULL,NULL,'t','t')")
        db.executemany(
            "INSERT INTO chat VALUES (?,?,?,?,?,?,?)",
            [
                ("named", "home", "old first message", "t1", "t1", None, 0),
                ("renamed", "home", "user name", "t2", "t2", None, 1),
                ("untitled", "home", None, "t3", "t3", None, 0),
            ],
        )
        db.execute("PRAGMA user_version = 3")
    rows = chat_client().get("/api/chats").json()["chats"]
    assert {
        row["session_id"]: (row["message_sent"], row["title"], row["first_title"]) for row in rows
    } == {
        "named": (True, "old first message", "old first message"),
        "renamed": (True, "user name", None),
        "untitled": (True, None, None),
    }
    with sqlite3.connect(home / "achilles.sqlite3") as db:
        assert db.execute("PRAGMA user_version").fetchone()[0] == 4


def test_versions_lists_tool_versions_with_the_active_one(tmp_path: Path) -> None:
    store = PageStore(tmp_path / "achilles")
    store.set_create_mode("home", True)
    bundle = {
        "format_version": 1,
        "kind": "data_operation",
        "name": "annotate_trace",
        "description": "annotate",
        "input_schema": {"type": "object"},
        "implementation": {
            "operation": "insert",
            "collection": "annotations",
            "data_schema": {"type": "object"},
        },
    }
    store.create_tool("home", bundle)
    store.create_tool("home", bundle | {"description": "annotate v2"})
    own = {"authorization": f"Bearer {store.ensure_credential('home')}"}
    client = chat_client()
    rollback = client.post(
        "/api/pages/home/tools/annotate_trace/rollback",
        headers=own,
        json={"version": 1, "expected_version": 2},
    )
    assert rollback.status_code == 200
    assert (rollback.json()["version"], rollback.json()["restored_from"]) == (3, 1)
    tools = client.get("/api/pages/home/versions", headers=own).json()["tools"]
    listed = [(row["name"], row["version"], row["active"], row["restored_from"]) for row in tools]
    assert listed == [
        ("annotate_trace", 3, True, 1),
        ("annotate_trace", 2, False, None),
        ("annotate_trace", 1, False, None),
    ]


def test_compiled_frame_has_response_sandbox_and_anonymous_artifacts(tmp_path: Path) -> None:
    root = tmp_path / "achilles"
    store = PageStore(root)
    digest = "a" * 64
    (root / "bundles" / f"{digest}.js").write_text("export default 1")
    with store.transaction() as db:
        db.execute(
            "INSERT INTO code_revision(page_id,version,source,dependencies,digest,"
            "artifact_size,diagnostics,runtime_error,created_at) VALUES(?,?,?,?,?,?,?,?,?)",
            ("home", 1, "source", "{}", digest, 16, None, None, "2025-01-01"),
        )
        db.execute("UPDATE page SET active_code_revision=1 WHERE id='home'")

    with TestClient(web.create_app()) as client:
        frame = client.get("/api/pages/home/frame")
        artifact = client.get(f"/api/pages/home/artifact/{digest}", headers={"origin": "null"})
        bootstrap = client.get(
            "/api/pages/home/frame-bootstrap.js?revision=1", headers={"origin": "null"}
        )

    assert (
        "sandbox allow-scripts allow-forms allow-downloads"
        in frame.headers["content-security-policy"]
    )
    assert "<script>" not in frame.text
    assert "crossorigin='anonymous'" in frame.text
    assert artifact.headers["access-control-allow-origin"] == "*"
    assert bootstrap.headers["access-control-allow-origin"] == "*"
    assert "window.achilles" in bootstrap.text


def test_fresh_home_is_plain_chat_and_a_codeless_page_keeps_the_notice(tmp_path: Path) -> None:
    store = PageStore(tmp_path / "achilles")
    with store.transaction() as db:
        db.execute(
            "INSERT INTO page(id,route,title,created_at,updated_at) VALUES(?,?,?,?,?)",
            ("old", "/old", "old block page", "2025-01-01", "2025-01-01"),
        )

    with TestClient(web.create_app()) as client:
        home = client.get("/api/pages/home").json()
        old = client.get("/api/pages/old").json()

    assert home["code"] is None
    assert home["unsupported_format"] is None
    assert old["unsupported_format"] == web.EMPTY_PAGE


def test_page_bridge_updates_and_deletes_only_its_own_records(tmp_path: Path) -> None:
    store = PageStore(tmp_path / "achilles")
    with store.transaction() as db:
        db.execute(
            "INSERT INTO page(id,route,title,created_at,updated_at) VALUES(?,?,?,?,?)",
            ("other", "/other", "other", "2025-01-01", "2025-01-01"),
        )
    own = {"authorization": f"Bearer {store.ensure_credential('home')}"}
    other = {"authorization": f"Bearer {store.ensure_credential('other')}"}
    client = TestClient(web.create_app())
    book = client.post("/api/pages/home/records/books", headers=own, json={"title": "dune"})
    theirs = client.post("/api/pages/other/records/books", headers=other, json={"title": "emma"})
    path = f"/api/pages/home/records/books/{book.json()['record_id']}"

    updated = client.patch(path, headers=own, json={"read": True})
    assert updated.status_code == 200, updated.text
    assert updated.json() == {**book.json(), "read": True, "revision": 2}
    assert client.get("/api/pages/home/records/books", headers=own).json() == [updated.json()]

    # another page's credential, or this page's credential on another page's record, is refused
    assert client.patch(path, headers=other, json={"read": False}).status_code == 403
    assert client.delete(path, headers=other).status_code == 403
    their_id = theirs.json()["record_id"]
    leaked = client.patch(f"/api/pages/home/records/books/{their_id}", headers=own, json={"x": 1})
    assert leaked.status_code == 404
    assert "emma" not in leaked.text
    assert (
        client.delete(f"/api/pages/home/records/books/{their_id}", headers=own).status_code == 404
    )
    assert client.get("/api/pages/other/records/books", headers=other).json() == [theirs.json()]

    assert client.delete(path, headers=own).status_code == 200
    assert client.get("/api/pages/home/records/books", headers=own).json() == []
    assert client.delete(path, headers=own).status_code == 404


def test_non_utf8_body_is_a_400_not_a_500(tmp_path: Path) -> None:
    store = PageStore(tmp_path / "achilles")
    store.set_create_mode("home", True)
    headers = {
        "authorization": f"Bearer {store.ensure_credential('home')}",
        "host": "127.0.0.1:5190",
        "origin": "http://127.0.0.1:5190",
        "content-type": "application/json",
    }
    client = TestClient(web.create_app(), client=("127.0.0.1", 1234), raise_server_exceptions=False)
    for path in (
        "/api/pages/home/records/notes",
        "/api/pages/home/code/restore",
        "/api/pages/home/tools/add_note/rollback",
    ):
        response = client.post(path, headers=headers, content=b'{"version": "\xff"}')
        assert response.status_code == 400, path


def _mcp(client, token: str):
    """Opens one MCP session for the page that owns `token`; returns an rpc(method, params)."""
    headers = {
        "host": "127.0.0.1:5190",
        "authorization": f"Bearer {token}",
        "accept": "application/json, text/event-stream",
        "content-type": "application/json",
    }
    params = {
        "protocolVersion": "2025-03-26",
        "capabilities": {},
        "clientInfo": {"name": "test", "version": "1"},
    }
    body = {"jsonrpc": "2.0", "id": 0, "method": "initialize", "params": params}
    headers["mcp-session-id"] = client.post("/mcp/", headers=headers, json=body).headers[
        "mcp-session-id"
    ]

    def rpc(method, params):
        body = {"jsonrpc": "2.0", "id": 1, "method": method, "params": params}
        return client.post("/mcp/", headers=headers, json=body).json()["result"]

    return rpc


def test_render_page_follows_the_edit_gate_and_own_page_rule(tmp_path: Path) -> None:
    store = PageStore(tmp_path / "achilles")
    with store.transaction() as db:
        for page_id, creator in (("parent", None), ("child", "parent"), ("theirs", "parent")):
            db.execute(
                "INSERT INTO page(id,route,title,created_at,updated_at,created_by_page_id) "
                "VALUES(?,?,?,?,?,?)",
                (page_id, f"/{page_id}", page_id, "2025-01-01", "2025-01-01", creator),
            )

    def render(rpc, arguments):
        return rpc("tools/call", {"name": "render_page", "arguments": arguments})

    with TestClient(web.create_app(), client=("127.0.0.1", 1234)) as client:
        home = _mcp(client, store.ensure_credential("home"))
        parent = _mcp(client, store.ensure_credential("parent"))
        listed = home("tools/list", {})["tools"]
        off = render(home, {})
        # a page's own chat may render its own page without create mode, but not a page it created
        child_without_create = render(parent, {"page_id": "child"})
        store.set_create_mode("home", True)
        # in create mode, a page another page created stays off limits
        theirs = render(home, {"page_id": "theirs"})
        codeless = render(home, {})
    assert "render_page" not in [tool["name"] for tool in listed]
    assert off["isError"] and off["content"][0]["text"] == "forbidden: create mode is off"
    for refused in (child_without_create, theirs):
        assert refused["isError"] and "forbidden" in refused["content"][0]["text"], refused
    assert codeless["isError"] and "no_code" in codeless["content"][0]["text"]


def test_render_page_runs_two_at_once_and_a_third_is_busy(monkeypatch, tmp_path: Path) -> None:
    store = PageStore(tmp_path / "achilles")
    store.set_create_mode("home", True)
    token = store.ensure_credential("home")
    started, release = threading.Semaphore(0), threading.Event()

    def blocked_render(origin, page_id, credential):
        started.release()
        release.wait(10)
        return {"ready": True}

    monkeypatch.setattr(PageStore, "page_code", lambda self, page_id: {"version": 1})
    monkeypatch.setattr(mcp_server, "render_page", blocked_render)
    monkeypatch.setattr(mcp_server, "RENDER_WAIT_SECONDS", 0.2, raising=False)
    call = {"name": "render_page", "arguments": {}}
    with (
        TestClient(web.create_app(), client=("127.0.0.1", 1234)) as client,
        ThreadPoolExecutor(2) as pool,
    ):
        # one session runs its calls in order, so each render gets its own session
        first, second, third = (_mcp(client, token) for _ in range(3))
        try:
            running = [pool.submit(rpc, "tools/call", call) for rpc in (first, second)]
            assert started.acquire(timeout=10) and started.acquire(timeout=10)
            busy = third("tools/call", call)
        finally:
            release.set()
        done = [future.result(10) for future in running]
        # both slots are free again once the renders end
        after = third("tools/call", call)
    assert busy["isError"] and "busy" in busy["content"][0]["text"], busy
    assert [result.get("isError") for result in done] == [False, False]
    assert not after.get("isError"), after


@pytest.mark.parametrize(
    ("exit_code", "output", "error"),
    [(1, "", "runner failed"), (0, "not json", "not JSON")],
)
def test_render_runner_failure_is_a_plain_error_and_kills_its_group(
    monkeypatch, tmp_path: Path, exit_code: int, output: str, error: str
) -> None:
    pid_file = tmp_path / "runner.pid"
    runner = tmp_path / "runner.sh"
    # the runner leaves a detached child behind, like a chromium the runner never closed
    runner.write_text(
        f"echo $$ > {pid_file}; sleep 60 </dev/null >/dev/null 2>&1 & printf '{output}'; "
        f"exit {exit_code}"
    )
    monkeypatch.setattr(render_page_module, "_RUNNER", runner)
    monkeypatch.setattr(render_page_module.shutil, "which", lambda name: "/bin/sh")
    with pytest.raises(render_page_module.RenderError, match=error):
        render_page_module.render_page("http://127.0.0.1:1", "home", "token", timeout=5)
    group = int(pid_file.read_text())
    for _ in range(100):  # SIGKILL is delivered asynchronously
        try:
            os.killpg(group, 0)
        except ProcessLookupError:
            break
        time.sleep(0.05)
    else:
        os.killpg(group, signal.SIGKILL)
        pytest.fail(f"process group {group} still had a live process")
