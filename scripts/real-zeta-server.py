"""Run the pinned Zeta server with only its provider backend replaced by a script."""

from __future__ import annotations

import asyncio
import json
import os
import signal
import tempfile
from pathlib import Path

from tests.support.fake_backend import FakeBackend, ScriptedTurn
from zeta.mcp.server_actor import MCPServerActor
from zeta.protocol.types import MessageRole, TextContent, ToolCall
from zeta.providers.completion import owned_completion
from zeta.runtime.loop.agent import AgentLoop
from zeta.server.control import ServeControl
from zeta.server.delivery import DeliveryRequests
from zeta.server.handlers.registry import HANDLERS
from zeta.server.protocol import MethodDescriptor
from zeta.server.server import ZetaServer
from zeta.storage_format import advance

inspect_turn_release = asyncio.Event()
page_open_turn_release = asyncio.Event()
METRIC_BOUNDARY_MATRIX = json.loads(
    (Path(__file__).parent.parent / "apps/web/src/metric-boundary-matrix.json").read_text()
)


class BarrierBackend(FakeBackend):
    @staticmethod
    def opening_prompt(messages) -> str | None:
        latest_user = next(
            (message for message in reversed(messages) if message.role is MessageRole.USER),
            None,
        )
        if latest_user is None:
            return None
        return next(
            (
                block.text
                for block in latest_user.content
                if isinstance(block, TextContent)
                and block.text in {"open created page", "start allow-mode chat", "sb7 page stream"}
            ),
            None,
        )

    def __init__(self, turns, request_serializer, control):
        super().__init__(turns, request_serializer=request_serializer)
        self.opening = {
            "open created page": FakeBackend(
                [ScriptedTurn(content=[TextContent("new page ready")])],
                request_serializer=request_serializer,
            ),
            "start allow-mode chat": FakeBackend(
                [ScriptedTurn(content=[TextContent("allow page ready")])],
                request_serializer=request_serializer,
            ),
            "sb7 page stream": FakeBackend(
                [
                    ScriptedTurn(
                        content=[
                            TextContent(f"sb7 stream line {index:03d}\\n") for index in range(120)
                        ],
                        delay=0.03,
                    )
                ],
                request_serializer=request_serializer,
            ),
        }
        self.control = control

    @owned_completion
    async def complete(self, messages, tool_schemas):
        opening_prompt = self.opening_prompt(messages)
        backend = self.opening.get(opening_prompt, self)
        turn_index = len(self.calls)
        stream = FakeBackend.complete.__wrapped__(backend, messages, tool_schemas)
        async for event in stream:
            jump_chunk = (
                event.type.name == "MESSAGE_UPDATE"
                and isinstance(event.content, TextContent)
                and event.content.text.startswith("text-only line 080")
            )
            if jump_chunk:
                yield event
                await hold(self.control, "jump_stream_barrier")
                continue
            if event.type.name == "MESSAGE_END":
                document = read_control(self.control) or {}
                returned = document.get("returned_tool_calls", [])
                if any(call.get("id") == "inspect-after-discovery" for call in returned):
                    document["inspect_turn_barrier"] = "held"
                    write_control(self.control, document)
                    await asyncio.wait_for(inspect_turn_release.wait(), 30)
                elif opening_prompt == "open created page":
                    document["page_open_turn_barrier"] = "held"
                    write_control(self.control, document)
                    try:
                        await asyncio.wait_for(page_open_turn_release.wait(), 30)
                    except TimeoutError as error:
                        raise TimeoutError(
                            "waiting for the gate to release the first page turn"
                        ) from error
                elif turn_index == 4:
                    await hold(self.control, "turn_barrier")
            yield event


async def hold(control: Path, barrier: str, seconds: int = 15) -> None:
    held = False
    for _ in range(seconds * 20):
        document = read_control(control)
        if document is not None and not held:
            document[barrier] = "held"
            write_control(control, document)
            held = True
        elif document is not None and document.get(f"release_{barrier}"):
            return
        await asyncio.sleep(0.05)
    raise RuntimeError(f"{barrier} release timed out after {seconds} seconds")


def read_control(path: Path) -> dict | None:
    """One read of the control file; None while it is missing or not yet a complete document."""
    try:
        return json.loads(path.read_text())
    except (FileNotFoundError, json.JSONDecodeError):
        return None


class RestartBackend:
    def __init__(self, resume_turns, cursor_turn, request_serializer):
        self.resume = FakeBackend(resume_turns, request_serializer=request_serializer)
        self.cursor = FakeBackend([cursor_turn], request_serializer=request_serializer)

    @owned_completion
    async def complete(self, messages, tool_schemas):
        cursor_prompt = any(
            message.role is MessageRole.USER
            and any(
                isinstance(block, TextContent) and block.text == "start cursor stream"
                for block in message.content
            )
            for message in messages
        )
        backend = self.cursor if cursor_prompt else self.resume
        stream = FakeBackend.complete.__wrapped__(backend, messages, tool_schemas)
        async for event in stream:
            yield event


def write_control(path: Path, document: dict) -> None:
    payload = json.dumps(document).encode()
    temporary = path.with_name(f".{path.name}.{os.getpid()}.{os.urandom(8).hex()}.tmp")
    flags = os.O_CREAT | os.O_EXCL | os.O_WRONLY
    descriptor = os.open(temporary, flags, 0o600)
    try:
        with os.fdopen(descriptor, "wb") as stream:
            descriptor = -1
            stream.write(payload)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        if descriptor != -1:
            os.close(descriptor)
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass


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
        input_schema = {
            "type": "object",
            "properties": {"search": {"type": "string"}},
            "additionalProperties": False,
        }
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
    restarting_turn = (read_control(control) or {}).get("request_count", 0) > 0
    home.mkdir(parents=True, exist_ok=True)
    if not (home / "storage-format.json").exists():
        advance(home, expected_epoch=0)
    turns = [
        ScriptedTurn(
            content=[TextContent("assistant ready")],
            # a page tool: an approval answered after a reload must run it with the page binding
            tool_calls=[ToolCall("proof-inspect", "achilles__inspect_page", {})],
        ),
        ScriptedTurn(content=[TextContent("approval complete")]),
        ScriptedTurn(
            content=[
                TextContent(
                    "# Rendered markdown\n\n## Structured reply\n\n"
                    "* first item\n* second item\n\n"
                    "| book | change since june | status |\n"
                    "| :--- | ---: | :--- |\n"
                    "| achilles | +12 | ready |\n"
                    "| fulcrum | -3 | review |\n\n"
                    "| one | two | three | four | five | six | seven | eight |\n"
                    "| --- | --- | --- | --- | --- | --- | --- | --- |\n"
                    "| alphaaaaaaaaaaaaaaaaaaaaaaaaaaaa | betaaaaaaaaaaaaaaaaaaaaaaaaaaaa | "
                    "gammaaaaaaaaaaaaaaaaaaaaaaaaaaaaa | deltaaaaaaaaaaaaaaaaaaaaaaaaaaaaa | "
                    "epsiloooooooooooooooooooooooooooo | zetaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa | "
                    "etaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa | thetaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa |\n\n"
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
        ScriptedTurn(content=[TextContent("end-of-turn followup complete")]),
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
        # a page reload in the middle of this stream must keep the turn (`turn_reconnect`)
        ScriptedTurn(
            content=[TextContent(f"reload line {index:03d}\n") for index in range(80)],
            delay=0.1,
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
                                {"type": "text", "text": "reading list layout"},
                                {"type": "form", "title": "add book", "tool": "add_book"},
                                *[
                                    {
                                        "type": "metric",
                                        **{
                                            key: value
                                            for key, value in metric.items()
                                            if key not in {"expectedText", "classification"}
                                        },
                                    }
                                    for metric in METRIC_BOUNDARY_MATRIX
                                ],
                                {
                                    "type": "metric",
                                    "label": "review status",
                                    "value": "waiting on an intentionally long legal and "
                                    "editorial review",
                                },
                                {
                                    "type": "metric",
                                    "label": "reading",
                                    "collection": "books",
                                    "count": True,
                                    "where": {"field": "status", "equals": "reading"},
                                },
                                {"type": "list", "title": "books", "collection": "books"},
                                {
                                    "type": "detail",
                                    "title": "selected reading book",
                                    "collection": "books",
                                    "fields": ["title"],
                                    "filter": {"field": "status", "equals": "reading"},
                                },
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
                    "update-reading-layout",
                    "achilles__update_layout",
                    {
                        "layout": {
                            "blocks": [
                                {"type": "text", "text": "layout updated without reload"},
                                {
                                    "type": "metric",
                                    "label": "all books",
                                    "collection": "books",
                                    "count": True,
                                },
                                {
                                    "type": "metric",
                                    "label": "review status",
                                    "value": "waiting on an intentionally long legal and "
                                    "editorial review",
                                },
                                {
                                    "type": "metric",
                                    "label": "reading",
                                    "collection": "books",
                                    "count": True,
                                    "where": {"field": "status", "equals": "reading"},
                                },
                                {"type": "list", "title": "books", "collection": "books"},
                                {
                                    "type": "detail",
                                    "title": "selected reading book",
                                    "collection": "books",
                                    "fields": ["title"],
                                    "filter": {"field": "status", "equals": "reading"},
                                },
                                {"type": "form", "title": "edit book", "tool": "update_book"},
                            ]
                        },
                        "expected_version": 2,
                    },
                ),
                ToolCall(
                    "list-books-summary",
                    "achilles__list_books",
                    {"search": "synthetic-" + "x" * 9_000},
                ),
            ]
        ),
        ScriptedTurn(content=[TextContent("layout updated")]),
        ScriptedTurn(
            tool_calls=[
                ToolCall(
                    "stale-reading-layout",
                    "achilles__update_layout",
                    {"layout": {"blocks": []}, "expected_version": 2},
                )
            ]
        ),
        ScriptedTurn(
            content=[
                TextContent(
                    "layout version conflict: inspect the page and retry with its current version."
                )
            ]
        ),
        ScriptedTurn(
            tool_calls=[
                ToolCall(
                    "invalid-metric-layout",
                    "achilles__update_layout",
                    {
                        "layout": {
                            "blocks": [
                                {
                                    "type": "metric",
                                    "label": "invalid",
                                    "collection": "books",
                                    "count": "yes",
                                }
                            ]
                        },
                        "expected_version": 3,
                    },
                )
            ]
        ),
        ScriptedTurn(
            content=[
                TextContent(
                    "metric update rejected: /layout/blocks/0 must match one valid schema variant."
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
        # a page tool called while a reload has the page away must wait for its binding
        ScriptedTurn(
            tool_calls=[
                ToolCall(
                    "reload-add-book",
                    "achilles__add_book",
                    {"title": "Reload Book", "status": "reading"},
                )
            ]
        ),
        ScriptedTurn(content=[TextContent("reload book added")]),
        # a foreground tool running across a reload: its output so far shows once after it
        ScriptedTurn(
            tool_calls=[
                ToolCall(
                    "reload-bash",
                    "bash",
                    {
                        "command": (
                            'echo tool-line "before-reload"; '
                            f"while [ ! -e {cwd / 'release-reload-tool'} ]; do sleep 0.05; done; "
                            'echo tool-line "after-reload"'
                        )
                    },
                )
            ]
        ),
        ScriptedTurn(content=[TextContent("reload tool complete")]),
        # a background task: its end wakes the session for a turn the page did not send
        ScriptedTurn(
            tool_calls=[
                ToolCall(
                    "wake-task",
                    "run_background",
                    {
                        "command": (
                            f"while [ ! -e {cwd / 'release-wake-task'} ]; do sleep 0.05; done"
                        )
                    },
                )
            ]
        ),
        ScriptedTurn(content=[TextContent("background task started")]),
        # the woken turn, after a reload during its setup: the page tools must be bound again
        ScriptedTurn(tool_calls=[ToolCall("wake-inspect", "achilles__inspect_page", {})]),
        ScriptedTurn(content=[TextContent("woken turn complete")]),
        ScriptedTurn(content=[TextContent("stock complete")]),
        ScriptedTurn(content=[TextContent("vim complete")]),
        ScriptedTurn(content=[TextContent("focus complete")], delay=5),
        ScriptedTurn(
            content=[TextContent(f"cursor stream delta {index}\n") for index in range(8)],
            tool_calls=[
                ToolCall("cursor-stream-proof", "read", {"path": str(cwd / "fixture.txt")})
            ],
            delay=0.03,
        ),
    ]

    def record_request(messages, tool_schemas):
        document = read_control(control)
        if document is None:
            # a partial control file: skip this record, so the gate's own wait reports it
            names = [schema["name"] for schema in tool_schemas]
            return json.dumps({"messages": len(messages), "schemas": names}).encode()
        if opening_prompt := BarrierBackend.opening_prompt(messages):
            marker = (
                "page_open_request"
                if opening_prompt == "open created page"
                else "allow_open_request"
            )
            document[marker] = True
            write_control(control, document)
            return json.dumps({"messages": len(messages), "schemas": []}).encode()
        request_count = document.get("request_count", 0) + 1
        document["request_count"] = request_count
        document["last_message"] = str(messages[-1]) if messages else ""
        document["user_messages"] = [
            block.text
            for message in messages
            if message.role is MessageRole.USER
            for block in message.content
            if isinstance(block, TextContent)
        ]
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
        write_control(control, document)
        return json.dumps({"messages": len(messages), "schemas": document["schemas"]}).encode()

    backend = (
        RestartBackend(turns[:2], turns[-1], record_request)
        if restarting_turn
        else BarrierBackend(turns, record_request, control)
    )
    return (
        ZetaServer(
            home=home,
            cwd=cwd,
            ws_port=0,
            ws_discovery=os.environ["ZETA_PROOF_DISCOVERY"],
            ws_origins=(os.environ["ZETA_PROOF_ORIGIN"],),
            provider="codex",
            auto_memory=False,
            backend_factory=lambda provider, model, selected_home: (backend, model or "offline"),
        ),
        control,
        "stale-session-id",
    )


async def main(server: ZetaServer, control: Path, pending_session: str) -> None:
    asyncio.get_running_loop().add_signal_handler(signal.SIGUSR1, inspect_turn_release.set)
    asyncio.get_running_loop().add_signal_handler(signal.SIGUSR2, page_open_turn_release.set)
    original_event = ServeControl._event

    async def held_event(control_pair, event, *args, **kwargs):
        document = read_control(control) or {}
        if (
            event.type.name == "TURN_START"
            and document.get("hold_turn_start")
            and "turn_start_barrier" not in document
        ):
            control_pair._turn_end_published = False
            # longer than the gate's 30 s wait, so the gate reports its own timeout first
            await hold(control, "turn_start_barrier", seconds=35)
        await original_event(control_pair, event, *args, **kwargs)

    # every session pair has its own ServeControl, so patch the class
    ServeControl._event = held_event
    original_send = DeliveryRequests.send

    async def held_send(instance, params, features):
        outcome = await original_send(instance, params, features)
        if params.get("text") == "steer while running":
            await hold(control, "fallback_send_barrier")
        return outcome

    original_finalize_turn = DeliveryRequests.finalize_turn

    async def held_finalize_turn(instance, *args, **kwargs):
        document = read_control(control) or {}
        if document.get("request_count") == 18 and "late_turn_barrier" not in document:
            await hold(control, "late_turn_barrier")
        await original_finalize_turn(instance, *args, **kwargs)

    original_suspend = MCPServerActor.suspend

    async def counted_suspend(actor, *args, **kwargs):
        # a page binding left (its client disconnected): the gate waits for this
        await original_suspend(actor, *args, **kwargs)
        if (document := read_control(control)) is not None:
            document["bound_suspends"] = document.get("bound_suspends", 0) + 1
            write_control(control, document)

    original_handle_call = MCPServerActor._handle_call

    def recorded_handle_call(actor, request):
        if request.tool_name == "add_book" and actor._binding_detached:
            if (document := read_control(control)) is not None:
                calls = document.get("detached_add_book_calls", 0) + 1
                document["detached_add_book_calls"] = calls
                write_control(control, document)
        original_handle_call(actor, request)

    original_call_tool = MCPServerActor.call_tool

    async def held_call_tool(actor, tool_name, *args, **kwargs):
        # announced (tool_start sent) but not yet at the MCP server: the gate reloads the page here
        if tool_name == "add_book":
            document = read_control(control) or {}
            if document.get("hold_reload_tool") and "reload_tool_barrier" not in document:
                await hold(control, "reload_tool_barrier")
        return await original_call_tool(actor, tool_name, *args, **kwargs)

    def held_history(original):
        async def handler(client, request_id, params):
            # the reloaded page's first history read waits until the reply is published, rowless
            document = read_control(control) or {}
            if (
                document.get("hold_reload_history") == params.get("session_id")
                and "reload_history_barrier" not in document
            ):
                await hold(control, "reload_history_barrier")
            return await original(client, request_id, params)

        return handler

    for method in (
        MethodDescriptor.SESSION_HISTORY,
        MethodDescriptor.SESSION_HISTORY_AND_SUBSCRIBE,
    ):
        HANDLERS[method] = held_history(HANDLERS[method])
    original_append_reply = AgentLoop._append_turn_message_with_approvals

    async def held_append_reply(loop, message, *args, **kwargs):
        # zeta publishes assistant_message before it writes the reply's row: hold that row write
        if any(
            isinstance(block, TextContent) and block.text == "reload book added"
            for block in message.content
        ):
            await hold(control, "reload_row_barrier")
        return await original_append_reply(loop, message, *args, **kwargs)

    original_notification_turn = server.turn_contexts.run_notification_turn

    async def held_notification_turn(*args, **kwargs):
        # a woken turn in its setup, before turn_start: the gate reloads the page here
        document = read_control(control) or {}
        if document.get("hold_wake_setup") and "wake_setup_barrier" not in document:
            # the gate restarts achilles while held, so this hold is longer than the others
            await hold(control, "wake_setup_barrier", seconds=60)
        return await original_notification_turn(*args, **kwargs)

    server.turn_contexts.run_notification_turn = held_notification_turn
    AgentLoop._append_turn_message_with_approvals = held_append_reply
    MCPServerActor.call_tool = held_call_tool
    MCPServerActor.suspend = counted_suspend
    MCPServerActor._handle_call = recorded_handle_call
    DeliveryRequests.send = held_send
    DeliveryRequests.finalize_turn = held_finalize_turn
    await server.start()
    websocket = server._websocket
    assert websocket is not None and websocket.controller_token is not None
    write_control(
        control,
        {
            "port": websocket.port,
            "token": websocket.controller_token,
            "pending_session": pending_session,
            "pid": os.getpid(),
        },
    )
    try:
        await server.serve_forever()
    finally:
        await server.close()


if __name__ == "__main__":
    proof_server, proof_control, proof_pending_session = make_server()
    asyncio.run(main(proof_server, proof_control, proof_pending_session))
