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


def make_server() -> tuple[ZetaServer, Path, str]:
    home = private_proof_home()
    cwd = Path(os.environ["ZETA_PROOF_CWD"])
    control = Path(os.environ["ZETA_PROOF_CONTROL"])
    home.mkdir(parents=True, exist_ok=True)
    (home / "mcp.json").write_text(
        json.dumps(
            {
                "servers": {
                    "achilles": {
                        "transport": "streamable-http",
                        "url": f"{os.environ['ZETA_PROOF_ORIGIN']}/mcp/",
                    }
                }
            }
        )
    )
    advance(home, expected_epoch=0)
    turns = [
        ScriptedTurn(
            content=[TextContent("assistant ready")],
            tool_calls=[ToolCall("proof-read", "read", {"path": str(cwd / "fixture.txt")})],
        ),
        ScriptedTurn(content=[TextContent("approval complete")]),
        ScriptedTurn(
            tool_calls=[
                ToolCall(
                    "create",
                    "achilles__create_page",
                    {
                        "route": "/created",
                        "title": "created",
                        "layout": {"blocks": [{"type": "text", "text": "from zeta"}]},
                    },
                )
            ]
        ),
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
    ]

    def record_request(messages, tool_schemas):
        document = json.loads(control.read_text())
        document["schemas"] = [schema["name"] for schema in tool_schemas]
        document["schema_documents"] = tool_schemas
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
