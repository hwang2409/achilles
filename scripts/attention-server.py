"""Real Zeta with synthetic attention records.

The owner has two decisions, one deferred item, two FYI notes and one resolved decision; another
session has one decision (the attention place lists only its own session's items).
"""

import asyncio
import os
from dataclasses import replace
from pathlib import Path

from tests.support.fake_backend import FakeBackend, ScriptedTurn
from zeta.attention_records import AttentionStore
from zeta.core.session import SessionManager
from zeta.protocol.types import TextContent
from zeta.server.server import ZetaServer
from zeta.storage_format import advance

OWNER = "synthetic attention owner"


def seed(home: Path, cwd: Path) -> None:
    manager = SessionManager(home)
    sessions = (
        (OWNER, "owner", ("decision", "decision", "deferred", "answer", "decided", "resolved")),
        ("synthetic other session", "other", ("decision",)),
    )
    for name, label, kinds in sessions:
        opened = manager.create(
            provider="codex", model="offline", cwd=cwd, name=name, auto_project=False
        )
        store = opened.store
        try:
            epoch = manager.observed_storage_epoch
            attention = AttentionStore(store.session_dir, writer_epoch=epoch)
            for n, kind in enumerate(kinds, 1):
                record = attention.request(
                    session_id=store.session_id,
                    project_id=None,
                    entry_id=None,
                    entry_seq=None,
                    title=f"{label} {kind} {n}",
                    why="synthetic fixture",
                    kind="decision" if kind == "resolved" else kind,
                )
                if kind == "resolved":
                    resolved = replace(
                        record, status="resolved", resolved_at="2026-11-08T00:01:00+00:00"
                    )
                    attention.replace(resolved)
        finally:
            store.close()


def backend() -> FakeBackend:
    return FakeBackend([ScriptedTurn(content=[TextContent("fixture reply")])])


def make_server() -> ZetaServer:
    home = Path(os.environ["ZETA_HOME"])
    cwd = Path(os.environ["ZETA_PROOF_CWD"])
    advance(home, expected_epoch=0)
    seed(home, cwd)
    return ZetaServer(
        home=home,
        cwd=cwd,
        ws_port=0,
        ws_discovery=os.environ["ZETA_PROOF_DISCOVERY"],
        ws_origins=(os.environ["ZETA_PROOF_ORIGIN"],),
        provider="codex",
        auto_memory=False,
        backend_factory=lambda _provider, model, _home: (backend(), model or "offline"),
    )


async def main(server: ZetaServer) -> None:
    await server.start()
    try:
        await server.serve_forever()
    finally:
        await server.close()


if __name__ == "__main__":
    asyncio.run(main(make_server()))
