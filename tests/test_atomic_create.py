import json
import sqlite3
import threading
from concurrent.futures import ThreadPoolExecutor

import homes
import pytest
from starlette.testclient import TestClient

import achilles.pages as pages
from achilles.pages import PageStore
from achilles.tools import derived_output_schema


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
        "implementation": {
            "operation": operation,
            "collection": "books",
            "data_schema": data_schema,
        },
    }


def request(tools=None):
    return {
        "route": "/reading",
        "title": "reading list",
        "package": {
            "source": (
                'import { createRoot } from "react-dom/client"; '
                'createRoot(document.getElementById("root")!).render(<main />);'
            ),
            "dependencies": {},
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
    monkeypatch.setattr(
        pages,
        "build_page",
        lambda _root, _page_id, source, dependencies: {
            "digest": "test-digest",
            "size": len(source),
            # the real builder stores the react pins with the requested deps
            "dependencies": {"react": "19.0.0", "react-dom": "19.0.0", **dependencies},
            "resolved_dependencies": dependencies,
            "lockfile": "test-lock",
        },
    )
    store = PageStore(root)
    store.set_create_mode("home", True)
    app = homes.app()
    with TestClient(app, client=("127.0.0.1", 1234), base_url="http://127.0.0.1") as client:
        yield root, store, client, initialize(client, store.ensure_credential("home"))


def state(root):
    with sqlite3.connect(root / "achilles.sqlite3") as db:
        counts = {
            table: db.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
            for table in ("page", "code_revision", "tool", "tool_version", "page_tool", "audit")
        }
    files = {
        path.relative_to(root).as_posix()
        for directory in (root / "bundles", root / "credentials", root / "pages")
        for path in directory.rglob("*")
        if path.is_file()
    }
    return counts, files


@pytest.fixture
def page_family(creation_client):
    """home created /reading, /other, /loose (no creator); /other created /grandchild."""
    root, store, client, home = creation_client
    ids = {}
    for request_id, route in enumerate(("/reading", "/other", "/loose"), 2):
        created = mcp(
            client,
            home,
            request_id,
            "tools/call",
            {"name": "create_page", "arguments": {**request(), "route": route}},
        )
        ids[route] = json.loads(created["content"][0]["text"])["page_id"]
    with store.transaction() as db:  # a page from before created_by_page_id, or made by the user
        db.execute("UPDATE page SET created_by_page_id=NULL WHERE id=?", (ids["/loose"],))
    store.set_create_mode(ids["/other"], True)
    other = initialize(client, store.ensure_credential(ids["/other"]), 5)
    mcp(
        client,
        other,
        6,
        "tools/call",
        {"name": "create_page", "arguments": {**request(), "route": "/grandchild"}},
    )

    def call(headers, request_id, name, page=None):
        arguments = {"bundle": bundle(name=name)} | ({} if page is None else {"page": page})
        result = mcp(
            client,
            headers,
            request_id,
            "tools/call",
            {"name": "create_tool", "arguments": arguments},
        )
        return result.get("isError", False), json.loads(result["content"][0]["text"])

    def names(route):
        return {tool["name"] for tool in store.page_tools(store.page(route)["id"])}

    return root, ids, home, other, call, names


def test_create_tool_page_adds_to_this_page_or_a_page_it_created(page_family):
    _, ids, home, _, call, names = page_family
    error, value = call(home, 7, "child_tool", "/reading")
    assert not error, value
    assert value["page_id"] == ids["/reading"]
    assert "child_tool" in names("/reading") and "child_tool" not in names("/")

    error, value = call(home, 8, "child_by_id", ids["/reading"])
    assert not error and value["page_id"] == ids["/reading"], value

    error, value = call(home, 9, "own_tool", "/")
    assert not error and value["page_id"] == "home" and "own_tool" in names("/"), value

    error, value = call(home, 10, "plain_tool")
    assert not error and "page_id" not in value
    assert "plain_tool" in names("/")


@pytest.mark.parametrize(
    ("caller", "page"),
    [
        ("home", "/grandchild"),  # a page another page created
        ("home", "/loose"),  # a page with no stored creator
        ("home", "/missing"),
        ("other", "/reading"),  # a sibling: same creator, not this page
        ("other", "/"),  # the caller's own creator
    ],
)
def test_create_tool_page_refuses_pages_this_page_did_not_create(page_family, caller, page):
    root, _, home, other, call, _ = page_family
    before = state(root)
    error, value = call({"home": home, "other": other}[caller], 7, "sneaky", page)
    assert error
    assert value["code"] == "forbidden" and value["path"] == "/page", value
    assert "only to this page or to a page created from this page" in value["hint"]
    assert "Bearer" not in json.dumps(value)
    assert state(root) == before


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
    assert value["code"]["revision"] == 1
    assert value["code"]["source"] == request()["package"]["source"]
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


def test_create_mode_off_lists_read_only_inspect_and_no_write_builtins(creation_client):
    # the home chat is not a page chat: with create mode off it can only inspect
    root, store, client, headers = creation_client
    mcp(client, headers, 2, "tools/call", {"name": "create_page", "arguments": request()})
    store.set_create_mode("home", False)

    catalog = mcp(client, headers, 4, "tools/list", {})
    assert sorted(tool["name"] for tool in catalog["tools"]) == ["inspect_page"]
    inspect = next(tool for tool in catalog["tools"] if tool["name"] == "inspect_page")
    assert "create mode is currently OFF" in inspect["description"]
    assert inspect["annotations"]["readOnlyHint"] is True

    before = state(root)
    inspected = mcp(client, headers, 5, "tools/call", {"name": "inspect_page", "arguments": {}})
    assert inspected.get("isError") is not True, inspected
    assert json.loads(inspected["content"][0]["text"])["route"] == "/"
    assert state(root) == before

    for request_id, name, arguments in (
        (6, "write_page", {"source": "export default 1", "dependencies": {}}),
        (7, "create_page", {**request(), "route": "/other"}),
        (8, "create_tool", {"bundle": bundle(name="sneaky")}),
        (9, "restore_version", {"kind": "code", "version": 1, "expected_version": 1}),
    ):
        refused = mcp(
            client, headers, request_id, "tools/call", {"name": name, "arguments": arguments}
        )
        assert refused["isError"] is True, name
        assert refused["content"][0]["text"] == "forbidden: create mode is off", name
    assert state(root) == before


def test_page_chat_edits_its_own_page_without_create_mode(creation_client):
    root, store, client, headers = creation_client
    created = mcp(client, headers, 2, "tools/call", {"name": "create_page", "arguments": request()})
    page_id = json.loads(created["content"][0]["text"])["page_id"]
    token = store.ensure_credential(page_id)
    page_headers = initialize(client, token, 3)
    assert not store.page(page_id)["create_mode"]

    catalog = mcp(client, page_headers, 4, "tools/list", {})
    names = sorted(tool["name"] for tool in catalog["tools"])
    assert names == [
        "add_book",
        "edit_page",
        "inspect_page",
        "read_page_file",
        "render_page",
        "restore_version",
        "write_page",
    ]
    inspect = next(tool for tool in catalog["tools"] if tool["name"] == "inspect_page")
    assert "read-only" not in inspect["description"]

    source = "export default 2"
    written = mcp(
        client,
        page_headers,
        5,
        "tools/call",
        {"name": "write_page", "arguments": {"source": source, "dependencies": {}}},
    )
    assert written.get("isError") is not True, written
    assert store.page(page_id)["active_code_revision"] == 2
    restored = mcp(
        client,
        page_headers,
        6,
        "tools/call",
        {
            "name": "restore_version",
            "arguments": {"kind": "code", "version": 1, "expected_version": 2},
        },
    )
    assert restored.get("isError") is not True, restored
    assert store.page(page_id)["active_code_revision"] == 3
    # the page's history dialog restores through http with the same rule
    restore = client.post(
        f"/api/pages/{page_id}/code/restore",
        headers={
            "authorization": f"Bearer {token}",
            "origin": "http://127.0.0.1:5190",
            "host": "127.0.0.1:5190",
        },
        json={"version": 2, "expected_version": 3},
    )
    assert restore.status_code == 200, restore.text

    before = state(root)
    for request_id, name, arguments in (
        (7, "create_page", {**request(), "route": "/other"}),
        (8, "create_tool", {"bundle": bundle(name="sneaky")}),
        (
            9,
            "restore_version",
            {"kind": "tool", "name": "add_book", "version": 1, "expected_version": 1},
        ),
    ):
        refused = mcp(
            client, page_headers, request_id, "tools/call", {"name": name, "arguments": arguments}
        )
        assert refused["isError"] is True, name
        assert refused["content"][0]["text"] == "forbidden: create mode is off", name
    assert state(root) == before


def test_inspect_page_bounds_large_code_over_public_mcp(creation_client):
    _, store, client, headers = creation_client
    store.write_page("home", "x" * 20_000, {}, None)
    inspected = mcp(client, headers, 2, "tools/call", {"name": "inspect_page", "arguments": {}})
    assert inspected.get("isError") is not True, inspected
    text = inspected["content"][0]["text"]
    value = json.loads(text)
    assert len(text.encode()) <= 8 * 1024
    assert value["truncated"] is True
    assert "source" not in value["code"] and value["code"]["revision"] == 1


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
    assert description == (
        "update books; read or list first, then pass the returned revision; "
        "record_id and revision are for tool calls, not to show the user"
    )


def test_create_tool_page_inside_bundle_names_the_fix(creation_client):
    # a real run put `page` inside `bundle` and got a bare invalid_input at /bundle
    root, _, client, headers = creation_client
    before = state(root)
    misplaced = {**bundle(name="misplaced_page"), "page": "/reading"}
    rejected = mcp(
        client,
        headers,
        2,
        "tools/call",
        {"name": "create_tool", "arguments": {"bundle": misplaced}},
    )
    assert rejected["isError"]
    error = json.loads(rejected["content"][0]["text"])
    assert error["code"] == "invalid_input" and error["path"] == "/bundle", error
    assert error["hint"] == "`page` goes at the top level, not inside `bundle`", error
    assert state(root) == before


def test_create_tool_rejects_wrong_output_and_derives_usable_result(creation_client):
    _, _, client, headers = creation_client
    wrong = bundle(name="wrong_output")
    wrong["output_schema"] = {
        "type": "object",
        "properties": {"id": {"type": "string"}},
        "required": ["id"],
    }
    rejected = mcp(
        client,
        headers,
        2,
        "tools/call",
        {"name": "create_tool", "arguments": {"bundle": wrong}},
    )
    assert rejected["isError"], "a conflicting generated-tool output schema was accepted"
    assert json.loads(rejected["content"][0]["text"]) == {
        "code": "invalid_input",
        "path": "/bundle/output_schema",
        "expected": "derived insert result: record with required record_id and revision",
    }

    generated = bundle(name="add_derived_book")
    generated["implementation"]["data_schema"]["properties"]["details"] = {
        "type": "object",
        "properties": {"author": {"type": "string"}, "year": {"type": "integer"}},
        "required": ["author", "year"],
        "additionalProperties": False,
    }
    generated["output_schema"], _ = derived_output_schema(generated)
    generated["output_schema"]["required"].reverse()
    generated["output_schema"]["properties"]["details"]["required"].reverse()
    created = mcp(
        client,
        headers,
        3,
        "tools/call",
        {"name": "create_tool", "arguments": {"bundle": generated}},
    )
    assert not created.get("isError")
    catalog = mcp(client, headers, 4, "tools/list", {})
    listed = next(tool for tool in catalog["tools"] if tool["name"] == "add_derived_book")
    assert listed["outputSchema"]["required"] == ["title", "record_id", "revision"]
    inserted = mcp(
        client,
        headers,
        5,
        "tools/call",
        {"name": "add_derived_book", "arguments": {"title": "Synthetic Book"}},
    )
    value = json.loads(inserted["content"][0]["text"])
    assert value["title"] == "Synthetic Book"
    assert value["record_id"]
    assert value["revision"] == 1


def test_create_tool_compares_instance_values_without_required_normalization(creation_client):
    _, _, client, headers = creation_client
    generated = bundle(name="add_const_book")
    generated["implementation"]["data_schema"]["properties"]["metadata"] = {
        "const": {"required": ["first", "second"]}
    }
    generated["output_schema"], _ = derived_output_schema(generated)
    generated["output_schema"]["properties"]["metadata"]["const"]["required"].reverse()

    rejected = mcp(
        client,
        headers,
        2,
        "tools/call",
        {"name": "create_tool", "arguments": {"bundle": generated}},
    )

    assert rejected["isError"], "reordered const instance data was accepted"
    assert json.loads(rejected["content"][0]["text"]) == {
        "code": "invalid_input",
        "path": "/bundle/output_schema",
        "expected": "derived insert result: record with required record_id and revision",
    }


def test_create_tool_handles_mixed_type_enum(creation_client):
    _, _, client, headers = creation_client
    generated = bundle(name="add_enum_book")
    generated["implementation"]["data_schema"]["properties"]["edition"] = {"enum": [1, "second"]}
    generated["output_schema"], _ = derived_output_schema(generated)

    created = mcp(
        client,
        headers,
        2,
        "tools/call",
        {"name": "create_tool", "arguments": {"bundle": generated}},
    )

    assert not created.get("isError")


def test_required_field_errors_name_top_level_and_nested_fields(creation_client):
    _, store, client, headers = creation_client
    update = bundle(name="update_book", operation="update")
    update["input_schema"] = {
        "type": "object",
        "properties": {
            "record_id": {"type": "string"},
            "revision": {"type": "integer"},
            "metadata": {
                "type": "object",
                "properties": {"label": {"type": "string"}},
                "required": ["label"],
                "additionalProperties": False,
            },
            "title": {"type": "string"},
        },
        "required": ["record_id", "revision", "metadata"],
        "additionalProperties": False,
    }
    store.create_tool("home", update)
    mcp(client, headers, 2, "tools/list", {})
    cases = [
        ({"revision": 1, "metadata": {"label": "x"}}, "required property: record_id", "/record_id"),
        (
            {"record_id": "book", "metadata": {"label": "x"}},
            "required property: revision",
            "/revision",
        ),
        (
            {"record_id": "book", "revision": 1, "metadata": {}},
            "required property: label",
            "/metadata/label",
        ),
    ]
    for request_id, (arguments, expected, path) in enumerate(cases, 3):
        result = mcp(
            client,
            headers,
            request_id,
            "tools/call",
            {"name": "update_book", "arguments": arguments},
        )
        error = json.loads(result["content"][0]["text"])
        assert error["expected"] == expected
        assert error["path"] == path

    nested_type = mcp(
        client,
        headers,
        6,
        "tools/call",
        {
            "name": "update_book",
            "arguments": {"record_id": "book", "revision": 1, "metadata": {"label": 1}},
        },
    )
    nested_type_error = json.loads(nested_type["content"][0]["text"])
    assert nested_type_error["path"] == "/metadata/label"


def test_all_operation_tools_list_and_run_over_mcp(creation_client):
    _, store, client, headers = creation_client
    data_schema = bundle()["implementation"]["data_schema"]
    inputs = {
        "insert": data_schema,
        "get": {
            "type": "object",
            "properties": {"record_id": {"type": "string"}},
            "required": ["record_id"],
            "additionalProperties": False,
        },
        "list": {"type": "object", "additionalProperties": False},
        "update": {
            "type": "object",
            "properties": {
                "record_id": {"type": "string"},
                "revision": {"type": "integer"},
                "title": {"type": "string"},
            },
            "required": ["record_id", "revision", "title"],
            "additionalProperties": False,
        },
    }
    for operation in ("insert", "get", "list", "update"):
        store.create_tool(
            "home",
            {
                **bundle(name=f"{operation}_book", operation=operation),
                "input_schema": inputs[operation],
            },
        )

    catalog = mcp(client, headers, 2, "tools/list", {})
    tools = {tool["name"]: tool for tool in catalog["tools"]}
    assert "outputSchema" in tools["insert_book"]
    assert "outputSchema" in tools["update_book"]
    assert "outputSchema" not in tools["list_book"]
    assert "outputSchema" not in tools["get_book"]

    inserted = json.loads(
        mcp(
            client,
            headers,
            3,
            "tools/call",
            {"name": "insert_book", "arguments": {"title": "Synthetic Book"}},
        )["content"][0]["text"]
    )
    record_id = inserted["record_id"]
    fetched = mcp(
        client,
        headers,
        4,
        "tools/call",
        {"name": "get_book", "arguments": {"record_id": record_id}},
    )
    assert json.loads(fetched["content"][0]["text"])["title"] == "Synthetic Book"
    updated = mcp(
        client,
        headers,
        5,
        "tools/call",
        {
            "name": "update_book",
            "arguments": {"record_id": record_id, "revision": 1, "title": "Updated Book"},
        },
    )
    assert json.loads(updated["content"][0]["text"])["revision"] == 2
    listed = mcp(client, headers, 6, "tools/call", {"name": "list_book", "arguments": {}})
    assert json.loads(listed["content"][0]["text"])[0]["title"] == "Updated Book"


@pytest.mark.parametrize(
    "case",
    [
        "documented_update",
        "missing_revision",
        "insert_only",
        "insert_and_update",
        "overlapping_update",
    ],
)
def test_authoring_guidance_and_result_notes_through_public_mcp(creation_client, monkeypatch, case):
    root, _, client, headers = creation_client
    update = {
        **bundle(name="update_book", operation="update"),
        "input_schema": {
            "type": "object",
            "properties": {
                "record_id": {"type": "string"},
                "revision": {"type": "integer"},
                "title": {"type": "string"},
            },
            "required": ["record_id", "revision"],
            "additionalProperties": False,
        },
    }

    if case == "documented_update":
        catalog = mcp(client, headers, 2, "tools/list", {})
        description = next(
            tool["description"] for tool in catalog["tools"] if tool["name"] == "create_tool"
        )
        marker = "For an update tool, use this minimal example: "
        assert marker in description
        example = json.loads(description.split(marker, 1)[1].split(". revision comes", 1)[0])
        result = mcp(
            client,
            headers,
            3,
            "tools/call",
            {"name": "create_tool", "arguments": example},
        )
        assert result.get("isError") is not True
    elif case == "missing_revision":
        result = mcp(
            client,
            headers,
            2,
            "tools/call",
            {
                "name": "create_tool",
                "arguments": {"bundle": bundle(name="update_book", operation="update")},
            },
        )
        error = json.loads(result["content"][0]["text"])
        assert result["isError"] is True
        assert error["expected"] == "required integer property: revision"
        assert "input_schema properties and required" in error["hint"]
    elif case == "insert_only":
        expected_note = "collection books has no update tool; rows cannot be changed after insert"
        page_result = mcp(
            client,
            headers,
            2,
            "tools/call",
            {"name": "create_page", "arguments": request()},
        )
        tool_result = mcp(
            client,
            headers,
            3,
            "tools/call",
            {"name": "create_tool", "arguments": {"bundle": bundle()}},
        )
        assert json.loads(page_result["content"][0]["text"])["note"] == expected_note
        assert json.loads(tool_result["content"][0]["text"])["note"] == expected_note
    elif case == "insert_and_update":
        result = mcp(
            client,
            headers,
            2,
            "tools/call",
            {"name": "create_page", "arguments": request(tools=[bundle(), update])},
        )
        assert "note" not in json.loads(result["content"][0]["text"])
        mcp(
            client,
            headers,
            3,
            "tools/call",
            {"name": "create_tool", "arguments": {"bundle": bundle()}},
        )
        created_update = mcp(
            client,
            headers,
            4,
            "tools/call",
            {"name": "create_tool", "arguments": {"bundle": update}},
        )
        assert "note" not in json.loads(created_update["content"][0]["text"])
    else:
        insert_committed = threading.Event()
        update_committed = threading.Event()
        original_create_tool = PageStore.create_tool

        def pause_after_insert_commit(
            self, page_id, tool_bundle, validation_prefix="", target=None
        ):
            created = original_create_tool(self, page_id, tool_bundle, validation_prefix, target)
            if tool_bundle["implementation"]["operation"] == "insert":
                insert_committed.set()
                assert update_committed.wait(timeout=10)
            return created

        monkeypatch.setattr(PageStore, "create_tool", pause_after_insert_commit)
        with ThreadPoolExecutor(max_workers=1) as executor:
            pending = executor.submit(
                mcp,
                client,
                headers,
                2,
                "tools/call",
                {"name": "create_tool", "arguments": {"bundle": bundle()}},
            )
            assert insert_committed.wait(timeout=10)
            try:
                PageStore(root).create_tool("home", update)
            finally:
                update_committed.set()
            result = pending.result(timeout=10)
        value = json.loads(result["content"][0]["text"])
        assert value.get("note") == (
            "collection books has no update tool; rows cannot be changed after insert"
        )


def test_create_page_atomically_publishes_initial_tools_and_page_catalog(creation_client):
    root, store, client, headers = creation_client
    result = mcp(client, headers, 2, "tools/call", {"name": "create_page", "arguments": request()})
    created = json.loads(result["content"][0]["text"])
    assert created["existing"] is False
    page_id = created["page_id"]
    assert [tool["name"] for tool in store.page_tools(page_id)] == ["add_book"]
    assert store.page_code(page_id)["source"] == request()["package"]["source"]
    assert not store.page(page_id)["create_mode"]
    with store.transaction() as db:
        actions = db.execute("SELECT action FROM audit WHERE page_id=? ORDER BY id", (page_id,))
        assert [row[0] for row in actions] == ["create_page", "create_tool"]
    page_headers = initialize(client, store.ensure_credential(page_id), 3)
    catalog = mcp(client, page_headers, 4, "tools/list", {})
    assert [tool["name"] for tool in catalog["tools"]] == [
        "write_page",
        "read_page_file",
        "edit_page",
        "render_page",
        "inspect_page",
        "restore_version",
        "add_book",
    ]
    inserted = mcp(
        client,
        page_headers,
        5,
        "tools/call",
        {"name": "add_book", "arguments": {"title": "Synthetic Book"}},
    )
    assert json.loads(inserted["content"][0]["text"])["title"] == "Synthetic Book"
    assert store.records(page_id, "books")[1] == 1
    assert len(list((root / "bundles").glob("*.json"))) == 1


@pytest.mark.parametrize(
    "arguments,code,path",
    [
        (
            request(tools=[bundle(operation="delete")]),
            "invalid_input",
            "/tools/0/implementation/operation",
        ),
        (request(tools=[bundle(), bundle()]), "create_failed", ""),
    ],
)
def test_create_page_failures_leave_no_rows_or_page_files(creation_client, arguments, code, path):
    root, _store, client, headers = creation_client
    before = state(root)
    result = mcp(client, headers, 2, "tools/call", {"name": "create_page", "arguments": arguments})
    error = json.loads(result["content"][0]["text"])
    assert result["isError"] is True
    assert {key: error[key] for key in ("code", "expected", "path")} == {
        "code": code,
        "expected": error["expected"],
        "path": path,
    }
    # content-addressed bundle files may stay: they are never removed once written
    counts, files = state(root)
    assert (counts, {name for name in files if not name.startswith("bundles/")}) == before


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
    assert sorted(value.get("existing") for value in values if "code" not in value) == [
        False,
        True,
    ], values
    assert len({value["page_id"] for value in values}) == 1
    counts, files = state(root)
    assert counts == {
        "page": 2,
        "code_revision": 1,
        "tool": 1,
        "tool_version": 1,
        "page_tool": 1,
        "audit": 2,
    }
    assert len([path for path in files if path.startswith("bundles/")]) == 1
    assert store.page_tools(values[0]["page_id"])[0]["name"] == "add_book"


def test_create_page_file_failure_leaves_no_rows_or_files(creation_client, monkeypatch):
    root, _store, client, headers = creation_client
    before = state(root)

    def fail_write(path, content):
        path.write_bytes(content)
        raise OSError("synthetic write failure")

    monkeypatch.setattr(pages, "atomic_private_write", fail_write)
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
    assert set(first_value) == {
        "page_id",
        "route",
        "digest",
        "existing",
        "note",
    }
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


def _restore(client, headers, arguments):
    result = mcp(
        client, headers, 90, "tools/call", {"name": "restore_version", "arguments": arguments}
    )
    return result.get("isError", False), json.loads(result["content"][0]["text"])


def _active_tool_version(store):
    return store.page_tools("home")[0]["version"]


@pytest.mark.parametrize(
    "case",
    ["code", "tool", "stale_code", "stale_tool", "other_page", "unknown_version", "route_bad_json"],
)
def test_restore_version_guards_over_public_interfaces(creation_client, monkeypatch, case):
    root, store, client, headers = creation_client
    store.create_tool("home", bundle())
    store.create_tool("home", {**bundle(), "description": "insert books v2"})
    store.write_page("home", "first", {}, None)
    store.write_page("home", "second", {}, 1)
    store.create_page("/other", "other")
    notified = []

    async def record_list_changed(session):
        notified.append(session)

    monkeypatch.setattr(
        "mcp.server.session.ServerSession.send_tool_list_changed", record_list_changed
    )
    mcp(client, headers, 80, "tools/list", {})
    before = state(root)
    if case == "code":
        error, value = _restore(
            client, headers, {"kind": "code", "version": 1, "expected_version": 2}
        )
        assert not error, value
        assert (value["revision"], value["restored_from"]) == (3, 1)
        assert store.page_code("home")["source"] == "first"
        after = state(root)[0]
        assert after["code_revision"] == before[0]["code_revision"] + 1
        assert after["audit"] == before[0]["audit"] + 1
        return
    if case == "tool":
        error, value = _restore(
            client,
            headers,
            {"kind": "tool", "name": "add_book", "version": 1, "expected_version": 2},
        )
        assert not error, value
        assert value == {"kind": "tool", "name": "add_book", "version": 3, "restored_from": 1}
        assert _active_tool_version(store) == 3
        assert notified, "tools/list_changed was not sent"
        assert state(root)[0]["audit"] == before[0]["audit"] + 1
        return
    if case == "route_bad_json":
        raw = TestClient(
            homes.app(),
            base_url="http://127.0.0.1:8000",
            client=("127.0.0.1", 1234),
            raise_server_exceptions=False,
        )
        response = raw.post(
            "/api/pages/home/tools/add_book/rollback",
            headers={
                "authorization": f"Bearer {store.ensure_credential('home')}",
                "origin": "http://127.0.0.1:8000",
                "content-type": "application/json",
            },
            content=b"{",
        )
        assert response.status_code == 400
        assert state(root) == before
        return
    arguments, code, path = {
        "stale_code": (
            {"kind": "code", "version": 1, "expected_version": 1},
            "conflict",
            "/expected_version",
        ),
        "stale_tool": (
            {"kind": "tool", "name": "add_book", "version": 1, "expected_version": 1},
            "conflict",
            "/expected_version",
        ),
        "other_page": (
            {"kind": "code", "route": "/other", "version": 1, "expected_version": 1},
            "forbidden",
            "/route",
        ),
        "unknown_version": (
            {"kind": "code", "version": 99, "expected_version": 2},
            "not_found",
            "/version",
        ),
    }[case]
    error, value = _restore(client, headers, arguments)
    assert error, value
    assert (value["code"], value["path"]) == (code, path)
    if case == "other_page":
        assert value["hint"] == "To change another page, open that page's chat."
    assert state(root) == before
    assert store.page_code("home")["source"] == "second"
    assert _active_tool_version(store) == 2


def test_page_code_lifecycle_through_real_mcp_requests(monkeypatch, tmp_path):
    count = 0

    def build(_root, _page_id, source, dependencies):
        nonlocal count
        count += 1
        return {
            "digest": f"digest-{count}",
            "size": len(source),
            "dependencies": {"react": "19.0.0", "react-dom": "19.0.0", **dependencies},
            "resolved_dependencies": {
                "react": "19.0.0",
                "react-dom": "19.0.0",
                **{name: "1.0.0" for name in dependencies},
            },
            "lockfile": f"lock-{count}",
        }

    monkeypatch.setattr(pages, "build_page", build)
    root = tmp_path / "achilles"
    monkeypatch.setenv("ACHILLES_HOME", str(root))
    monkeypatch.setenv("ZETA_HOME", str(tmp_path / "zeta"))
    store = PageStore(root)
    store.set_create_mode("home", True)
    app = homes.app()
    with TestClient(app, client=("127.0.0.1", 1234)) as client:
        home_headers = initialize(client, store.ensure_credential("home"))
        listed = mcp(client, home_headers, 2, "tools/list", {})
        assert {tool["name"] for tool in listed["tools"]} >= {
            "create_page",
            "write_page",
            "inspect_page",
            "restore_version",
        }
        assert all("layout" not in tool["name"] for tool in listed["tools"])

        created = mcp(
            client,
            home_headers,
            3,
            "tools/call",
            {
                "name": "create_page",
                "arguments": {
                    "route": "/notes",
                    "title": "notes",
                    "package": {
                        "source": "export default function Page(){return <main>one</main>}",
                        "dependencies": {},
                    },
                },
            },
        )
        created_value = json.loads(created["content"][0]["text"])
        page_id = created_value["page_id"]
        store.set_create_mode(page_id, True)
        page_headers = initialize(client, store.ensure_credential(page_id), 4)
        mcp(client, page_headers, 5, "tools/list", {})

        written = mcp(
            client,
            page_headers,
            6,
            "tools/call",
            {
                "name": "write_page",
                "arguments": {
                    "source": "export default function Page(){return <main>two</main>}",
                    "dependencies": {},
                    "expected_revision": 1,
                },
            },
        )
        assert json.loads(written["content"][0]["text"])["revision"] == 2

        inspected = mcp(
            client,
            page_headers,
            7,
            "tools/call",
            {"name": "inspect_page", "arguments": {}},
        )
        assert json.loads(inspected["content"][0]["text"])["code"]["revision"] == 2

        restored = mcp(
            client,
            page_headers,
            8,
            "tools/call",
            {
                "name": "restore_version",
                "arguments": {"kind": "code", "version": 1, "expected_version": 2},
            },
        )
        value = json.loads(restored["content"][0]["text"])
        assert value == {
            "digest": "digest-1",
            "kind": "code",
            "restored_from": 1,
            "revision": 3,
        }

        browser_restore = client.post(
            f"/api/pages/{page_id}/code/restore",
            headers={
                "authorization": f"Bearer {store.ensure_credential(page_id)}",
                "host": "127.0.0.1:5190",
                "origin": "http://127.0.0.1:5190",
            },
            json={"version": 2, "expected_version": 3},
        )
        assert browser_restore.status_code == 200
        assert browser_restore.json()["version"] == 4


_FILE_SOURCE = (
    'import { createRoot } from "react-dom/client";\n'
    "function Page() { return <main><h1>reading</h1><p>a</p><p>a</p></main>; }\n"
    'createRoot(document.getElementById("root")!).render(<Page />);\n'
)


def _tool_value(result):
    return result.get("isError", False), json.loads(result["content"][0]["text"])


def test_page_files_read_edit_and_restore_over_public_mcp(creation_client, monkeypatch):
    import hashlib

    from achilles.page_build import PageBuildError

    root, store, client, headers = creation_client
    builds = []

    def build(build_root, _page_id, source, dependencies):
        builds.append((source, dependencies))
        if "BROKEN" in source:
            raise PageBuildError("src/Page.tsx:2:1: Unexpected BROKEN")
        digest = hashlib.sha256(source.encode()).hexdigest()
        (build_root / "bundles" / f"{digest}.js").write_text(source)
        return {
            "digest": digest,
            "size": len(source),
            "dependencies": {"react": "19.0.0", "react-dom": "19.0.0", **dependencies},
            "resolved_dependencies": dependencies,
            "lockfile": "test-lock",
        }

    monkeypatch.setattr(pages, "build_page", build)
    created = mcp(
        client,
        headers,
        2,
        "tools/call",
        {
            "name": "create_page",
            "arguments": {**request(), "package": {"source": _FILE_SOURCE, "dependencies": {}}},
        },
    )
    page_id = json.loads(created["content"][0]["text"])["page_id"]
    token = store.ensure_credential(page_id)
    page_headers = initialize(client, token, 3)
    store.set_create_mode("home", False)

    def call(request_id, name, arguments):
        return _tool_value(
            mcp(
                client,
                page_headers,
                request_id,
                "tools/call",
                {"name": name, "arguments": arguments},
            )
        )

    listed = mcp(client, page_headers, 4, "tools/list", {})
    catalog = {tool["name"]: tool for tool in listed["tools"]}
    assert catalog["read_page_file"]["annotations"]["readOnlyHint"] is True
    assert "exactly once" in catalog["edit_page"]["description"]

    # 1. a source file reads in two chunks that join to the whole file
    error, first = call(5, "read_page_file", {"path": "src/Page.tsx", "limit": 2})
    assert not error, first
    assert (first["revision"], first["next_offset"], first["total_lines"]) == (1, 2, 3)
    error, second = call(6, "read_page_file", {"path": "src/Page.tsx", "offset": 2})
    assert not error and second["next_offset"] is None
    assert first["content"] + second["content"] == _FILE_SOURCE

    # path traversal is refused by the schema before anything is read or written
    before = state(root)
    for request_id, name, arguments in (
        (7, "read_page_file", {"path": f"../credentials/{page_id}"}),
        (8, "read_page_file", {"path": "/etc/passwd"}),
        (
            9,
            "edit_page",
            {
                "path": "../../achilles.sqlite3",
                "edits": [{"old_string": "a", "new_string": "b"}],
                "expected_revision": 1,
            },
        ),
    ):
        error, refused = call(request_id, name, arguments)
        assert error and refused["code"] == "invalid_input" and refused["path"] == "/path", name
        assert token not in json.dumps(refused)
    assert state(root) == before

    # 4. zero or two matches, or one bad edit after a good one, change nothing
    for request_id, edits, count in (
        (10, [{"old_string": "<h2>", "new_string": "x"}], 0),
        (11, [{"old_string": "<p>a</p>", "new_string": "x"}], 2),
        (
            12,
            [
                {"old_string": "<h1>reading</h1>", "new_string": "<h1>books</h1>"},
                {"old_string": "missing", "new_string": "x"},
            ],
            0,
        ),
    ):
        error, failed = call(
            request_id,
            "edit_page",
            {"path": "src/Page.tsx", "edits": edits, "expected_revision": 1},
        )
        assert error and failed["code"] == "edit_error", failed
        assert failed["hint"].startswith(f"found {count} matches; nothing was changed")
    assert state(root) == before and len(builds) == 1

    # 2. one exact edit compiles and becomes the active revision
    error, edited = call(
        13,
        "edit_page",
        {
            "path": "src/Page.tsx",
            "edits": [{"old_string": "<h1>reading</h1>", "new_string": "<h1>books</h1>"}],
            "expected_revision": 1,
        },
    )
    assert not error, edited
    assert edited["revision"] == 2
    assert store.page_code(page_id)["source"] == _FILE_SOURCE.replace("reading</h1>", "books</h1>")

    # 3. a stale revision is a conflict and adds no revision
    before = state(root)
    error, stale = call(
        14,
        "edit_page",
        {
            "path": "src/Page.tsx",
            "edits": [{"old_string": "books", "new_string": "stale"}],
            "expected_revision": 1,
        },
    )
    assert error and stale["code"] == "conflict" and stale["current"] == {"revision": 2}
    assert state(root) == before

    # a failed build is the candidate: inspect shows it, the next read and edit start from it
    error, broken = call(
        15,
        "edit_page",
        {
            "path": "src/Page.tsx",
            "edits": [{"old_string": "<main>", "new_string": "<main>BROKEN"}],
            "expected_revision": 2,
        },
    )
    assert error and broken == {
        "error": "compile_error",
        "diagnostics": "src/Page.tsx:2:1: Unexpected BROKEN",
        "revision": 3,
    }
    assert store.page(page_id)["active_code_revision"] == 2
    error, inspected = call(16, "inspect_page", {})
    assert inspected["code"]["revision"] == 2
    assert inspected["code"]["files"][0] == {
        "path": "src/Page.tsx",
        "bytes": len(store.page_code(page_id)["source"].encode()),
    }
    assert inspected["candidate"]["revision"] == 3
    assert inspected["candidate"]["diagnostics"] == "src/Page.tsx:2:1: Unexpected BROKEN"
    error, failed_read = call(17, "read_page_file", {"path": "src/Page.tsx"})
    assert failed_read["failed"] is True and "BROKEN" in failed_read["content"]
    error, fixed = call(
        18,
        "edit_page",
        {
            "path": "package.json",
            "edits": [
                {
                    "old_string": '"react": "19.0.0"',
                    "new_string": '"nanoid": "5.1.6",\n    "react": "19.0.0"',
                }  # noqa: E501
            ],
            "expected_revision": 3,
        },
    )
    assert error  # still broken: the package edit keeps the candidate's source
    error, fixed = call(
        19,
        "edit_page",
        {
            "path": "src/Page.tsx",
            "edits": [{"old_string": "<main>BROKEN", "new_string": "<main>"}],
            "expected_revision": 4,
        },
    )
    assert not error, fixed
    assert builds[-2][1]["nanoid"] == "5.1.6"
    assert fixed["revision"] == 5
    error, inspected = call(20, "inspect_page", {})
    assert inspected["candidate"] is None

    # 5. restoring revision 1 appends a new revision that renders the original code
    error, restored = call(
        21,
        "restore_version",
        {"kind": "code", "version": 1, "expected_version": 5},
    )
    assert not error, restored
    assert restored["revision"] == 6
    assert store.page_code(page_id)["source"] == _FILE_SOURCE
    frame = client.get(f"/api/pages/{page_id}/frame")
    assert frame.status_code == 200
    digest = hashlib.sha256(_FILE_SOURCE.encode()).hexdigest()
    assert f"artifact/{digest}" in frame.text
    assert client.get(f"/api/pages/{page_id}/artifact/{digest}").text == _FILE_SOURCE
