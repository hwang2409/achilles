import json
import sqlite3
import threading

import pytest
from starlette.testclient import TestClient

import achilles.web as web
from achilles.pages import PageStore


def bundle(name="add_book", operation="insert"):
    data_schema = {
        "type": "object",
        "properties": {"title": {"type": "string"}},
        "required": ["title"],
        "additionalProperties": False,
    }
    return {
        "format_version": 1,
        "kind": "data_operation",
        "name": name,
        "description": f"{operation} books",
        "input_schema": data_schema,
        "output_schema": {"type": "object"},
        "implementation": {
            "operation": operation,
            "collection": "books",
            "data_schema": data_schema,
        },
    }


def request(tools=None, layout=None):
    return {
        "route": "/reading",
        "title": "reading list",
        "layout": layout
        or {
            "blocks": [
                {"type": "form", "title": "add a book", "tool": "add_book"},
                {"type": "list", "title": "books", "collection": "books"},
            ]
        },
        "tools": tools or [bundle()],
    }


def initialize(client, token, request_id=1):
    headers = {
        "host": "127.0.0.1:5190",
        "authorization": f"Bearer {token}",
        "accept": "application/json, text/event-stream",
        "content-type": "application/json",
    }
    response = client.post(
        "/mcp/",
        headers=headers,
        json={
            "jsonrpc": "2.0",
            "id": request_id,
            "method": "initialize",
            "params": {
                "protocolVersion": "2025-03-26",
                "capabilities": {},
                "clientInfo": {"name": "test", "version": "1"},
            },
        },
    )
    assert response.status_code == 200
    headers["mcp-session-id"] = response.headers["mcp-session-id"]
    return headers


def mcp(client, headers, request_id, method, params):
    response = client.post(
        "/mcp/",
        headers=headers,
        json={"jsonrpc": "2.0", "id": request_id, "method": method, "params": params},
    )
    assert response.status_code == 200
    return response.json()["result"]


@pytest.fixture
def creation_client(monkeypatch, tmp_path):
    root = tmp_path / "achilles"
    monkeypatch.setenv("ACHILLES_HOME", str(root))
    monkeypatch.setenv("ZETA_HOME", str(tmp_path / "zeta"))
    store = PageStore(root)
    store.set_create_mode("home", True)
    app = web.create_app()
    with TestClient(app, client=("127.0.0.1", 1234)) as client:
        yield root, store, client, initialize(client, store.ensure_credential("home"))


def state(root):
    with sqlite3.connect(root / "achilles.sqlite3") as db:
        counts = {
            table: db.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
            for table in ("page", "layout_version", "tool", "tool_version", "page_tool", "audit")
        }
    files = {
        path.relative_to(root).as_posix()
        for directory in (root / "bundles", root / "credentials", root / "pages")
        for path in directory.rglob("*")
        if path.is_file()
    }
    return counts, files


def test_inspect_page_bounds_large_summary_over_public_mcp(creation_client):
    _, store, client, home_headers = creation_client
    tools = []
    blocks = []
    for index in range(32):
        name = f"tool_{index}_{'x' * 54}"
        collection = f"collection_{index}_{'y' * 49}"
        schema = {"type": "object", "properties": {"value": {"type": "string"}}}
        tools.append(
            {
                "format_version": 1,
                "kind": "data_operation",
                "name": name,
                "description": "x" * 2_000,
                "input_schema": schema,
                "output_schema": {"type": "object"},
                "implementation": {
                    "operation": "insert",
                    "collection": collection,
                    "data_schema": schema,
                },
            }
        )
        blocks.append({"type": "list", "title": "b" * 256, "collection": collection})
    created = mcp(
        client,
        home_headers,
        2,
        "tools/call",
        {
            "name": "create_page",
            "arguments": request(tools=tools, layout={"blocks": blocks}),
        },
    )
    page_id = json.loads(created["content"][0]["text"])["page_id"]
    with store.transaction() as db:
        for index in range(32):
            db.execute(
                "INSERT INTO page_record("
                "page_id,collection,record_id,version,document,created_at,updated_at) "
                "VALUES(?,?,?,?,?,?,?)",
                (
                    page_id,
                    f"collection_{index}_{'y' * 49}",
                    f"record-{index}",
                    1,
                    "{}",
                    "now",
                    "now",
                ),
            )
    summary = mcp(
        client,
        home_headers,
        40,
        "tools/call",
        {"name": "inspect_page", "arguments": {"route": "/reading"}},
    )
    text = summary["content"][0]["text"]
    value = json.loads(text)
    assert len(text.encode()) <= 8 * 1024
    assert value["truncated"] is True
    assert set(value["omitted"]) == {"blocks", "tools", "collections"}
    assert sum(value["omitted"].values()) > 0


def test_inspect_page_allows_creator_and_keeps_other_pages_scoped(creation_client):
    root, store, client, home_headers = creation_client
    created = mcp(
        client, home_headers, 2, "tools/call", {"name": "create_page", "arguments": request()}
    )
    reading_id = json.loads(created["content"][0]["text"])["page_id"]
    summary = mcp(
        client,
        home_headers,
        3,
        "tools/call",
        {"name": "inspect_page", "arguments": {"route": "/reading"}},
    )
    value = json.loads(summary["content"][0]["text"])
    assert value["route"] == "/reading"
    assert value["layout"]["version"] == 1
    assert value["tools"][0]["name"] == "add_book"
    assert value["collections"] == {}
    serialized = json.dumps(value)
    assert len(serialized.encode()) <= 8 * 1024
    assert "credentials" not in serialized and str(root) not in serialized
    secret = (root / "credentials" / reading_id).read_text()
    with store.transaction() as db:
        credential_hash = db.execute(
            "SELECT credential_hash FROM page WHERE id=?", (reading_id,)
        ).fetchone()[0]
    assert secret not in serialized and credential_hash not in serialized

    third = mcp(
        client,
        home_headers,
        4,
        "tools/call",
        {"name": "create_page", "arguments": {**request(), "route": "/third", "title": "third"}},
    )
    third_id = json.loads(third["content"][0]["text"])["page_id"]
    store.set_create_mode(third_id, True)
    third_headers = initialize(client, store.ensure_credential(third_id), 5)
    forbidden = mcp(
        client,
        third_headers,
        6,
        "tools/call",
        {"name": "inspect_page", "arguments": {"route": "/reading"}},
    )
    assert forbidden["isError"]
    expected = {"code": "forbidden", "expected": "authorized page", "path": ""}
    assert json.loads(forbidden["content"][0]["text"]) == expected

    store.set_create_mode(reading_id, True)
    reading_headers = initialize(client, store.ensure_credential(reading_id), 7)
    cross_forbidden = mcp(
        client,
        reading_headers,
        8,
        "tools/call",
        {"name": "inspect_page", "arguments": {"route": "/"}},
    )
    missing = mcp(
        client,
        reading_headers,
        9,
        "tools/call",
        {"name": "inspect_page", "arguments": {"route": "/missing"}},
    )
    assert json.loads(cross_forbidden["content"][0]["text"]) == expected
    assert json.loads(missing["content"][0]["text"]) == expected
    store.set_create_mode("home", False)
    off = mcp(client, home_headers, 10, "tools/call", {"name": "inspect_page", "arguments": {}})
    assert off["isError"]


def test_fresh_mcp_session_must_list_tools_before_generated_call(creation_client):
    _root, store, client, headers = creation_client
    store.create_tool("home", bundle(name="same_name"))

    unlisted = mcp(
        client,
        headers,
        2,
        "tools/call",
        {"name": "same_name", "arguments": {"title": "Synthetic Book"}},
    )
    assert unlisted.get("isError") is True, "fresh session wrote a record without tools/list"
    assert json.loads(unlisted["content"][0]["text"]) == {
        "code": "tool_changed",
        "expected": "list tools again",
        "path": "",
    }
    assert store.records("home", "books") == ([], 0)
    with store._connect() as db:
        assert (
            db.execute("SELECT COUNT(*) FROM audit WHERE action='invoke:same_name'").fetchone()[0]
            == 0
        )

    mcp(client, headers, 3, "tools/list", {})
    listed = mcp(
        client,
        headers,
        4,
        "tools/call",
        {"name": "same_name", "arguments": {"title": "Synthetic Book"}},
    )
    assert json.loads(listed["content"][0]["text"])["title"] == "Synthetic Book"


def test_stale_mcp_catalog_rejects_call_until_tools_are_listed_again(creation_client):
    _root, store, client, headers = creation_client
    store.create_tool("home", bundle(name="same_name"))
    first_catalog = mcp(client, headers, 2, "tools/list", {})
    assert [tool["name"] for tool in first_catalog["tools"]][-1] == "same_name"

    store.create_tool(
        "home",
        {
            **bundle(name="same_name"),
            "implementation": {
                **bundle(name="same_name")["implementation"],
                "collection": "new_books",
            },
        },
    )
    stale = mcp(
        client,
        headers,
        3,
        "tools/call",
        {"name": "same_name", "arguments": {"title": "Synthetic Book"}},
    )
    assert stale.get("isError") is True, "stale catalog call executed the new tool version"
    assert json.loads(stale["content"][0]["text"]) == {
        "code": "tool_changed",
        "expected": "list tools again",
        "path": "",
    }
    assert store.records("home", "new_books") == ([], 0)
    with store._connect() as db:
        assert (
            db.execute("SELECT COUNT(*) FROM audit WHERE action='invoke:same_name'").fetchone()[0]
            == 0
        )

    mcp(client, headers, 4, "tools/list", {})
    current = mcp(
        client,
        headers,
        5,
        "tools/call",
        {"name": "same_name", "arguments": {"title": "Synthetic Book"}},
    )
    assert json.loads(current["content"][0]["text"])["title"] == "Synthetic Book"
    assert store.records("home", "new_books")[1] == 1


def test_update_catalog_tells_callers_to_pass_the_returned_revision(creation_client):
    _root, store, client, headers = creation_client
    update = bundle(name="update_book", operation="update")
    update["input_schema"] = {
        "type": "object",
        "properties": {
            "record_id": {"type": "string"},
            "revision": {"type": "integer"},
            "title": {"type": "string"},
        },
        "required": ["record_id", "revision", "title"],
        "additionalProperties": False,
    }
    store.create_tool("home", update)
    catalog = mcp(client, headers, 2, "tools/list", {})
    description = next(
        tool["description"] for tool in catalog["tools"] if tool["name"] == "update_book"
    )
    assert description == "update books; read or list first, then pass the returned revision"


def test_create_page_atomically_publishes_initial_tools_and_page_catalog(creation_client):
    root, store, client, headers = creation_client
    result = mcp(client, headers, 2, "tools/call", {"name": "create_page", "arguments": request()})
    created = json.loads(result["content"][0]["text"])
    assert created["existing"] is False
    page_id = created["page_id"]
    assert [tool["name"] for tool in store.page_tools(page_id)] == ["add_book"]
    assert store.layout(page_id) == request()["layout"]
    assert not store.page(page_id)["create_mode"]
    with store.transaction() as db:
        actions = db.execute("SELECT action FROM audit WHERE page_id=?", (page_id,))
        assert [row[0] for row in actions] == ["create_page", "create_tool"]
    page_headers = initialize(client, store.ensure_credential(page_id), 3)
    catalog = mcp(client, page_headers, 4, "tools/list", {})
    assert [tool["name"] for tool in catalog["tools"]] == ["add_book"]
    inserted = mcp(
        client,
        page_headers,
        5,
        "tools/call",
        {"name": "add_book", "arguments": {"title": "Synthetic Book"}},
    )
    assert json.loads(inserted["content"][0]["text"])["title"] == "Synthetic Book"
    assert store.records(page_id, "books")[1] == 1
    assert len(list((root / "bundles").glob("*.json"))) == 2


@pytest.mark.parametrize(
    "arguments,code,path",
    [
        (
            request(tools=[bundle(operation="delete")]),
            "invalid_input",
            "/tools/0/implementation/operation",
        ),
        (
            request(layout={"blocks": [{"type": "form", "title": "add", "tool": "missing"}]}),
            "invalid_input",
            "/layout/blocks/0/tool",
        ),
        (
            request(layout={"blocks": [{"type": "list", "title": "other", "collection": "other"}]}),
            "invalid_input",
            "/layout/blocks/0/collection",
        ),
        (request(tools=[bundle(), bundle()]), "create_failed", ""),
    ],
)
def test_create_page_failures_leave_no_rows_or_files(creation_client, arguments, code, path):
    root, _store, client, headers = creation_client
    before = state(root)
    result = mcp(client, headers, 2, "tools/call", {"name": "create_page", "arguments": arguments})
    error = json.loads(result["content"][0]["text"])
    assert result["isError"] is True
    assert error == {"code": code, "expected": error["expected"], "path": path}
    assert state(root) == before


def test_create_page_file_failure_leaves_no_rows_or_files(creation_client, monkeypatch):
    root, _store, client, headers = creation_client
    before = state(root)

    def fail_write(_self, path, content):
        path.write_bytes(content)
        raise OSError("synthetic write failure")

    monkeypatch.setattr(PageStore, "_atomic_private_write", fail_write)
    result = mcp(client, headers, 2, "tools/call", {"name": "create_page", "arguments": request()})
    error = json.loads(result["content"][0]["text"])
    assert result["isError"] is True
    assert error == {"code": "create_failed", "expected": "atomic page creation", "path": ""}
    assert state(root) == before


def test_create_page_is_idempotent_and_route_conflicts_are_structured(creation_client):
    root, store, client, headers = creation_client
    first = mcp(client, headers, 2, "tools/call", {"name": "create_page", "arguments": request()})
    first_value = json.loads(first["content"][0]["text"])
    credential = (root / "credentials" / first_value["page_id"]).read_bytes()
    with store.transaction() as db:
        credential_hash = db.execute(
            "SELECT credential_hash FROM page WHERE id=?", (first_value["page_id"],)
        ).fetchone()[0]
    first_serialized = json.dumps(first_value)
    assert set(first_value) == {"page_id", "route", "digest", "existing"}
    assert credential.decode() not in first_serialized
    assert credential_hash not in first_serialized

    before = state(root)
    duplicate = mcp(
        client, headers, 3, "tools/call", {"name": "create_page", "arguments": request()}
    )
    duplicate_value = json.loads(duplicate["content"][0]["text"])
    duplicate_serialized = json.dumps(duplicate_value)
    assert duplicate_value == {**first_value, "existing": True}
    assert credential == (root / "credentials" / first_value["page_id"]).read_bytes()
    with store.transaction() as db:
        assert (
            db.execute(
                "SELECT credential_hash FROM page WHERE id=?", (first_value["page_id"],)
            ).fetchone()[0]
            == credential_hash
        )
    assert credential.decode() not in duplicate_serialized
    assert credential_hash not in duplicate_serialized
    assert state(root) == before
    conflict = mcp(
        client,
        headers,
        4,
        "tools/call",
        {"name": "create_page", "arguments": {**request(), "title": "other"}},
    )
    error = json.loads(conflict["content"][0]["text"])
    assert conflict["isError"] is True
    assert error == {
        "code": "conflict",
        "expected": "unused route or equivalent request",
        "path": "/route",
    }
    assert state(root) == before


def test_simultaneous_identical_create_page_calls_are_idempotent(creation_client):
    root, store, client, headers = creation_client
    barrier = threading.Barrier(2)
    results = [None, None]
    errors = []
    concurrent_headers = [
        initialize(client, store.ensure_credential("home"), 10),
        initialize(client, store.ensure_credential("home"), 11),
    ]

    def call(index):
        try:
            barrier.wait(timeout=10)
            results[index] = mcp(
                client,
                concurrent_headers[index],
                20 + index,
                "tools/call",
                {"name": "create_page", "arguments": request()},
            )
        except BaseException as exc:
            errors.append(exc)

    threads = [threading.Thread(target=call, args=(index,)) for index in range(2)]
    for thread in threads:
        thread.start()
    for index, thread in enumerate(threads):
        thread.join(timeout=10)
        assert not thread.is_alive(), f"concurrent create caller {index} hung"
    assert not errors, errors
    values = [json.loads(result["content"][0]["text"]) for result in results]
    assert sorted(value["existing"] for value in values) == [False, True]
    assert len({value["page_id"] for value in values}) == 1
    counts, files = state(root)
    assert counts == {
        "page": 2,
        "layout_version": 1,
        "tool": 1,
        "tool_version": 1,
        "page_tool": 1,
        "audit": 2,
    }
    assert len([path for path in files if path.startswith("bundles/")]) == 2
    page_id = values[0]["page_id"]
    assert store.page_tools(page_id)[0]["name"] == "add_book"
