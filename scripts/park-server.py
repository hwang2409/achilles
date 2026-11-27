"""Real Zeta whose provider turns stay busy until the gate releases them (session_park gate)."""

import asyncio
import os
from pathlib import Path

from tests.support.fake_backend import FakeBackend, ScriptedTurn
from zeta.protocol.types import TextContent
from zeta.providers.completion import owned_completion
from zeta.server.server import ZetaServer
from zeta.storage_format import advance

RELEASE = Path(os.environ["ZETA_PARK_RELEASE"])


class HeldBackend(FakeBackend):
    """One turn: "park started", then waits for the release file, then "park finished"."""

    @owned_completion
    async def complete(self, messages, tool_schemas):
        stream = FakeBackend.complete.__wrapped__(self, messages, tool_schemas)
        updates = 0
        async for event in stream:
            if event.type.name == "MESSAGE_UPDATE":
                updates += 1
                if updates == 2:
                    for _ in range(240):
                        if RELEASE.exists():
                            break
                        await asyncio.sleep(0.5)
            yield event


def make_server() -> ZetaServer:
    home = Path(os.environ["ZETA_HOME"])
    advance(home, expected_epoch=0)

    def backend():
        return HeldBackend(
            [ScriptedTurn(content=[TextContent("park started"), TextContent(" · park finished")])]
        )

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
