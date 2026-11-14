from __future__ import annotations

import json
from contextlib import asynccontextmanager
from typing import Any

import anyio
from mcp.server.lowlevel import Server
from mcp.server.lowlevel.server import NotificationOptions
from mcp.types import CallToolResult, ListToolsResult, TextContent, Tool

from .pages import CREATE_PAGE_SCHEMA, PageStore
from .records import call_record
from .tools import CREATE_TOOL_SCHEMA
from .validation import ValidationError, validate_schema

INSPECT_PAGE_SCHEMA = {
    "type": "object",
    "properties": {"route": {"type": "string"}, "page_id": {"type": "string"}},
    "additionalProperties": False,
}
_INSPECT_MAX_BYTES = 8 * 1024


def _token(context):
    request = context.request
    return request.scope.get("state", {}).get("token") if request else None


def _remove_connection(sessions: dict[str, set], page_id: str, connection) -> None:
    page_sessions = sessions.get(page_id)
    if page_sessions is None:
        return
    page_sessions.difference_update(
        session for session in tuple(page_sessions) if session._connection is connection
    )
    if not page_sessions:
        sessions.pop(page_id, None)


def _text(value: Any) -> CallToolResult:
    return CallToolResult(
        content=[TextContent(type="text", text=json.dumps(value, sort_keys=True))]
    )


def _safe_error(exc: ValidationError) -> CallToolResult:
    return CallToolResult(
        isError=True,
        content=[
            TextContent(
                type="text",
                text=json.dumps(
                    {"code": exc.code, "path": exc.path, "expected": exc.expected}, sort_keys=True
                ),
            )
        ],
    )


def _inspect_result(value: dict[str, Any]) -> CallToolResult:
    encoded = json.dumps(value, sort_keys=True, separators=(",", ":"))
    if len(encoded.encode()) <= _INSPECT_MAX_BYTES:
        return _text(value)
    value["truncated"] = True
    value["layout"]["blocks"] = value["layout"]["blocks"][:32]
    value["tools"] = value["tools"][:32]
    value["collections"] = dict(list(value["collections"].items())[:32])
    for key in ("title",):
        value[key] = value[key][:256]
    encoded = json.dumps(value, sort_keys=True, separators=(",", ":"))
    while len(encoded.encode()) > _INSPECT_MAX_BYTES and value["layout"]["blocks"]:
        value["layout"]["blocks"].pop()
        encoded = json.dumps(value, sort_keys=True, separators=(",", ":"))
    return _text(value)


def _inspect_error() -> CallToolResult:
    return _safe_error(ValidationError("", "authorized page", "forbidden"))


def _validate_create(name: str, args: Any) -> None:
    schema = CREATE_PAGE_SCHEMA if name == "create_page" else CREATE_TOOL_SCHEMA
    validate_schema(args, schema)


def build_mcp(store: PageStore):
    sessions: dict[str, set] = {}

    async def principal(context):
        token = _token(context)
        return await anyio.to_thread.run_sync(store.authenticate, token) if token else None

    async def remove_connection(page_id: str, connection) -> None:
        _remove_connection(sessions, page_id, connection)

    async def notify(page_id: str) -> None:
        for session in list(sessions.get(page_id, ())):
            await session.send_tool_list_changed()

    async def list_tools(context, _params) -> ListToolsResult:
        page = await principal(context)
        if not page:
            return ListToolsResult(tools=[])
        page_sessions = sessions.setdefault(page["id"], set())
        page_sessions.add(context.session)
        connection = context.session._connection
        cleanup_key = f"achilles-session-cleanup:{page['id']}"
        if not connection.state.get(cleanup_key):
            connection.state[cleanup_key] = True
            connection.exit_stack.push_async_callback(remove_connection, page["id"], connection)
        tools: list[Tool] = []
        if page["create_mode"]:
            tools.extend(
                [
                    Tool(
                        name="inspect_page",
                        description="inspect safe summaries of the caller's page",
                        inputSchema=INSPECT_PAGE_SCHEMA,
                    ),
                    Tool(
                        name="create_page",
                        description="create a page; available only in create mode",
                        inputSchema=CREATE_PAGE_SCHEMA,
                    ),
                    Tool(
                        name="create_tool",
                        description=(
                            "create a page-owned immutable declarative tool version; "
                            "available only in create mode; operations are list, get, "
                            "insert, or update; nested schemas must be valid JSON Schema; "
                            "bundle <= 64 KB"
                        ),
                        inputSchema=CREATE_TOOL_SCHEMA,
                    ),
                ]
            )
        for bundle in await anyio.to_thread.run_sync(store.page_tools, page["id"]):
            tools.append(
                Tool(
                    name=bundle["name"],
                    description=bundle["description"],
                    inputSchema=bundle["input_schema"],
                )
            )
        return ListToolsResult(tools=tools)

    async def call_tool(context, params) -> CallToolResult:
        page = await principal(context)
        if not page:
            return CallToolResult(
                isError=True, content=[TextContent(type="text", text="forbidden")]
            )
        args = params.arguments or {}
        if params.name == "inspect_page":
            try:
                validate_schema(args, INSPECT_PAGE_SCHEMA)
                if "route" in args and "page_id" in args:
                    raise ValidationError("", "one selector", "invalid_input")
                if not page["create_mode"]:
                    return _inspect_error()
                target = page
                if "route" in args or "page_id" in args:
                    target = await anyio.to_thread.run_sync(
                        store.page, args.get("route", args.get("page_id"))
                    )
                if target is None or target["id"] != page["id"]:
                    return _inspect_error()
                summary = await anyio.to_thread.run_sync(store.inspect_page, target["id"])
                return _inspect_result(summary)
            except ValidationError as exc:
                return _safe_error(exc)
            except (KeyError, TypeError, ValueError, json.JSONDecodeError):
                return _inspect_error()
        if params.name in {"create_page", "create_tool"}:
            if not page["create_mode"]:
                return CallToolResult(
                    isError=True,
                    content=[TextContent(type="text", text="forbidden: create mode is off")],
                )
            try:
                _validate_create(params.name, args)
                if params.name == "create_page":
                    created, digest, existing = await anyio.to_thread.run_sync(
                        store.create_page,
                        args["route"],
                        args["title"],
                        args["layout"],
                        page["id"],
                        args.get("tools"),
                    )
                    result = {
                        "page_id": created["id"],
                        "route": created["route"],
                        "digest": digest,
                        "existing": existing,
                    }
                else:
                    created, digest = await anyio.to_thread.run_sync(
                        store.create_tool, page["id"], args["bundle"], "/bundle"
                    )
                    result = {**created, "digest": digest}
            except ValidationError as exc:
                return _safe_error(exc)
            except (KeyError, TypeError, ValueError, json.JSONDecodeError, PermissionError) as exc:
                return CallToolResult(
                    isError=True, content=[TextContent(type="text", text=str(exc))]
                )
            await notify(page["id"])
            return _text(result)
        try:
            result = await anyio.to_thread.run_sync(
                call_record, store, page["id"], params.name, args
            )
        except (PermissionError, TypeError, ValueError, KeyError, json.JSONDecodeError) as exc:
            return CallToolResult(isError=True, content=[TextContent(type="text", text=str(exc))])
        return _text(result)

    server = Server("achilles", on_list_tools=list_tools, on_call_tool=call_tool)
    original_options = server.create_initialization_options
    server.create_initialization_options = lambda **kwargs: original_options(
        notification_options=NotificationOptions(tools_changed=True), **kwargs
    )
    app = server.streamable_http_app(
        streamable_http_path="/", json_response=True, stateless_http=False, host="127.0.0.1"
    )

    @asynccontextmanager
    async def lifespan(_app: Any):
        async with app.router.lifespan_context(app):
            yield

    return app, lifespan, notify
