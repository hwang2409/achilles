import json

from starlette.testclient import TestClient

import achilles.pages as pages
import achilles.web as web
from achilles.pages import PageStore


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
    app = web.create_app()
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
