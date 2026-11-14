"""Run the pinned Zeta server with only its provider backend replaced by a script."""

from __future__ import annotations

import asyncio
import json
import os
import tempfile
from pathlib import Path

from tests.support.fake_backend import FakeBackend, ScriptedTurn
from zeta.protocol.types import TextContent, ToolCall
from zeta.server.server import ZetaServer
from zeta.storage_format import advance


def private_proof_home() -> Path:
    raw = os.environ.get("ZETA_HOME")
    worktree = os.environ.get("ZETA_PROOF_WORKTREE")
    if not raw or not worktree:
        raise RuntimeError("real-zeta proof requires explicit ZETA_HOME and ZETA_PROOF_WORKTREE")
    home = Path(raw).resolve()
    default = (Path.home() / ".zeta").resolve()
    if home == default or home.is_relative_to(default):
        raise RuntimeError("real-zeta proof must never use ~/.zeta or a child of it")
    if (
        not home.is_relative_to(Path(tempfile.gettempdir()).resolve())
        and not home.is_relative_to(Path("/tmp").resolve())
        and not home.is_relative_to(Path(worktree).resolve())
    ):
        raise RuntimeError("real-zeta proof ZETA_HOME must be under /tmp or the proof worktree")
    return home


def book_tool(name: str, operation: str, description: str) -> dict:
    properties = {
        "title": {"type": "string"},
        "status": {"type": "string"},
    }
    schema = {
        "type": "object",
        "properties": properties,
        "required": ["title"],
        "additionalProperties": False,
    }
    if operation == "list":
        input_schema = {"type": "object", "additionalProperties": False}
    elif operation == "update":
        input_schema = {
            "type": "object",
            "properties": {
                "record_id": {"type": "string"},
                "revision": {"type": "integer"},
                **properties,
            },
            "required": ["record_id", "revision"],
            "additionalProperties": False,
        }
    else:
        input_schema = schema
    return {
        "format_version": 1,
        "kind": "data_operation",
        "name": name,
        "description": description,
        "input_schema": input_schema,
        "output_schema": {"type": "object"},
        "implementation": {
            "operation": operation,
            "collection": "books",
            "data_schema": schema,
        },
    }


def make_server() -> tuple[ZetaServer, Path, str]:
    home = private_proof_home()
    cwd = Path(os.environ["ZETA_PROOF_CWD"])
    control = Path(os.environ["ZETA_PROOF_CONTROL"])
    home.mkdir(parents=True, exist_ok=True)
    if not (home / "storage-format.json").exists():
        advance(home, expected_epoch=0)
    turns = [
        ScriptedTurn(
            content=[TextContent("assistant ready")],
            tool_calls=[ToolCall("proof-read", "read", {"path": str(cwd / "fixture.txt")})],
        ),
        ScriptedTurn(content=[TextContent("approval complete")]),
        ScriptedTurn(
            content=[
                TextContent(
                    "# Rendered markdown\n\n## Structured reply\n\n"
                    "* first item\n* second item\n\n"
                    "```python\nvalue = 42\nprint(value)\n```"
                )
            ]
        ),
        ScriptedTurn(
            content=[
                TextContent(
                    f"stream line {index:03d}: "
                    + "enough content to overflow the transcript viewport\n"
                )
                for index in range(120)
            ],
            tool_calls=[ToolCall("stream-proof-read", "read", {"path": str(cwd / "fixture.txt")})],
            delay=0.03,
        ),
        ScriptedTurn(content=[TextContent("stream tool complete")]),
        ScriptedTurn(
            content=[
                TextContent(
                    f"text-only line {index:03d}: "
                    "enough content to overflow the transcript viewport\n"
                )
                for index in range(120)
            ],
            delay=0.03,
        ),
        ScriptedTurn(content=[TextContent("catalog ready")]),
        ScriptedTurn(
            tool_calls=[
                ToolCall(
                    "create",
                    "achilles__create_page",
                    {
                        "route": "/reading",
                        "title": "reading list",
                        "layout": {
                            "blocks": [
                                {"type": "form", "title": "add book", "tool": "add_book"},
                                {"type": "list", "title": "books", "collection": "books"},
                            ]
                        },
                        "tools": [
                            book_tool("add_book", "insert", "add a book"),
                            book_tool("update_book", "update", "update a book"),
                            book_tool("list_books", "list", "list books"),
                        ],
                    },
                )
            ]
        ),
        ScriptedTurn(content=[TextContent("annotation complete")]),
        ScriptedTurn(
            tool_calls=[
                ToolCall(
                    "discover-resources",
                    "mcp_discover",
                    {"action": "resources", "server": "achilles"},
                )
            ]
        ),
        ScriptedTurn(
            tool_calls=[
                ToolCall(
                    "inspect-after-discovery",
                    "achilles__inspect_page",
                    {"route": "/reading"},
                )
            ]
        ),
        ScriptedTurn(content=[TextContent("new chat tools complete")]),
        ScriptedTurn(
            tool_calls=[
                ToolCall(
                    "add-book",
                    "achilles__add_book",
                    {"title": "Synthetic Book", "status": "reading"},
                )
            ]
        ),
        ScriptedTurn(content=[TextContent("book added")]),
        ScriptedTurn(
            tool_calls=[
                ToolCall(
                    "annotate",
                    "achilles__annotate_trace",
                    {"text": "from zeta"},
                )
            ]
        ),
        ScriptedTurn(content=[TextContent("annotation complete")]),
        ScriptedTurn(content=[TextContent("v2 turn")]),
        ScriptedTurn(content=[TextContent("rollback turn")]),
        ScriptedTurn(
            tool_calls=[
                ToolCall(
                    "annotate-after-restart",
                    "achilles__annotate_trace",
                    {"text": "after achilles restart"},
                )
            ]
        ),
        ScriptedTurn(content=[TextContent("post-reconnect complete")]),
        ScriptedTurn(
            content=[TextContent("allow tool ready")],
            tool_calls=[ToolCall("allow-read", "read", {"path": str(cwd / "fixture.txt")})],
        ),
        ScriptedTurn(content=[TextContent("allow complete")]),
    ]

    def record_request(messages, tool_schemas):
        document = json.loads(control.read_text())
        request_count = document.get("request_count", 0) + 1
        document["request_count"] = request_count
        document["last_message"] = str(messages[-1]) if messages else ""
        document["schemas"] = [schema["name"] for schema in tool_schemas]
        document["schema_documents"] = tool_schemas
        returned_calls = turns[request_count - 1].tool_calls if request_count <= len(turns) else []
        document["schemas_include_annotate_trace"] = (
            "achilles__annotate_trace" in document["schemas"]
        )
        document["returned_tool_calls"] = [
            {
                "id": call.id,
                "name": call.name,
                "schemas_include_name": call.name in document["schemas"],
            }
            for call in returned_calls
        ]
        document["tool_results"] = [
            {
                "call_id": message.tool_result.tool_call_id,
                "is_error": message.tool_result.is_error,
                "content": "[redacted]",
            }
            for message in messages
            if message.tool_result is not None
        ]
        control.write_text(json.dumps(document))
        control.chmod(0o600)
        return json.dumps({"messages": len(messages), "schemas": document["schemas"]}).encode()

    backend = FakeBackend(turns, request_serializer=record_request)
    return (
        ZetaServer(
            home=home,
            cwd=cwd,
            ws_port=0,
            ws_origins=(os.environ["ZETA_PROOF_ORIGIN"],),
            provider="codex",
            auto_memory=False,
            backend_factory=lambda provider, model, selected_home: (backend, model or "offline"),
        ),
        control,
        "stale-session-id",
    )


async def main(server: ZetaServer, control: Path, pending_session: str) -> None:
    await server.start()
    websocket = server._websocket
    assert websocket is not None and websocket.controller_token is not None
    control.write_text(
        json.dumps(
            {
                "port": websocket.port,
                "token": websocket.controller_token,
                "pending_session": pending_session,
                "pid": os.getpid(),
            }
        ),
        encoding="utf-8",
    )
    control.chmod(0o600)
    try:
        await server.serve_forever()
    finally:
        await server.close()


if __name__ == "__main__":
    proof_server, proof_control, proof_pending_session = make_server()
    asyncio.run(main(proof_server, proof_control, proof_pending_session))
