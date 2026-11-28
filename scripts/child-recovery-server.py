"""Real Zeta child recovery: a synthetic provider is offline until the gate writes a flag file."""

import asyncio
import os
from pathlib import Path

from tests.support.fake_backend import FakeBackend, ScriptedTurn
from zeta.agent import resume_child, runner
from zeta.protocol.types import (
    ErrorInfo,
    Message,
    MessageRole,
    StreamEvent,
    StreamEventType,
    TextContent,
)
from zeta.providers.completion import CompletionRun, IteratorProviderAttempt
from zeta.server.server import ZetaServer
from zeta.storage_format import advance


async def _no_wait(_delay: float) -> None:
    return None


class OfflineChildBackend:
    """Fails each attempt with a retryable error until `online` exists, then answers."""

    provider = "codex"
    model = "offline"
    base_url = None

    def __init__(self, online: Path) -> None:
        self.online = online

    async def _complete_once(self, messages, tool_schemas, token=None, *, probe=False):
        del messages, tool_schemas, token
        if not self.online.exists():
            error = ErrorInfo("server_error", "offline")
            yield StreamEvent(StreamEventType.ERROR, error=error, data={"retry_after": 1})
        elif probe:
            yield StreamEvent(StreamEventType.MESSAGE_UPDATE, delta="ok")
        else:
            message = Message(MessageRole.ASSISTANT, [TextContent("synthetic child reply")])
            yield StreamEvent(StreamEventType.MESSAGE_END, message=message)

    def create_attempt(self, messages, tool_schemas, token=None):
        return IteratorProviderAttempt(self._complete_once(messages, tool_schemas, token))

    def complete(self, messages, tool_schemas, *, control):
        # no wait between attempts: the count-based retry budget runs out at once, so zeta suspends
        return CompletionRun(self, messages, tool_schemas, control=control, wait=_no_wait)


def make_server() -> ZetaServer:
    home = Path(os.environ["ZETA_HOME"])
    cwd = Path(os.environ["ZETA_PROOF_CWD"])
    advance(home, expected_epoch=0)
    child = OfflineChildBackend(cwd / "provider-online")

    # first run and a later resume of the same child both get the synthetic provider
    def resolve(*_args, **_kwargs):
        return child, None

    runner.resolve_child_backend = resume_child.resolve_child_backend = resolve
    return ZetaServer(
        home=home,
        cwd=cwd,
        ws_port=0,
        ws_discovery=os.environ["ZETA_PROOF_DISCOVERY"],
        ws_origins=(os.environ["ZETA_PROOF_ORIGIN"],),
        provider="codex",
        auto_memory=False,
        backend_factory=lambda _provider, model, _home: (
            FakeBackend([ScriptedTurn(content=[TextContent("parent reply")]) for _ in range(20)]),
            model or "offline",
        ),
    )


async def main(server: ZetaServer) -> None:
    await server.start()
    try:
        await server.serve_forever()
    finally:
        await server.close()


if __name__ == "__main__":
    asyncio.run(main(make_server()))
