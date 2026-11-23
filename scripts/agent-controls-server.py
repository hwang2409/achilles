"""Real Zeta child controls with a provider that holds synthetic turns open."""

import asyncio
import os
from pathlib import Path

from tests.support.fake_backend import FakeBackend, ScriptedTurn
from zeta.agent import runner
from zeta.protocol.types import TextContent
from zeta.server.server import ZetaServer
from zeta.storage_format import advance


def make_server() -> ZetaServer:
    home = Path(os.environ["ZETA_HOME"])
    advance(home, expected_epoch=0)

    def backend():
        return FakeBackend([ScriptedTurn(content=[TextContent("fixture reply")], delay=45)])

    # Keep parent and child provider calls offline and independently held.
    runner.resolve_child_backend = lambda _loop, _model: (backend(), None)
    return ZetaServer(
        home=home,
        cwd=Path(os.environ["ZETA_PROOF_CWD"]),
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
