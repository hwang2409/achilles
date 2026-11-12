"""Run the pinned Zeta server with only its provider backend replaced by a script."""

from __future__ import annotations

import asyncio
import json
import os
import tempfile
from pathlib import Path

from tests.support.fake_backend import FakeBackend, ScriptedTurn
from zeta.core.session import SessionManager
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
    advance(home, expected_epoch=0)
    manager = SessionManager(home)
    pending = manager.create(provider="codex", model="offline", cwd=cwd, name="pending proof")
    pending.store.close()
    turns = [
        ScriptedTurn(
            content=[TextContent("assistant ready")],
            tool_calls=[ToolCall("proof-read", "read", {"path": str(cwd / "fixture.txt")})],
        ),
        ScriptedTurn(content=[TextContent("approval complete")]),
    ]
    backend = FakeBackend(turns)
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
        pending.metadata.session_id,
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
