from __future__ import annotations

import json
from contextlib import asynccontextmanager
from typing import Any

import anyio
from mcp.server.lowlevel import Server
from mcp.server.lowlevel.server import NotificationOptions
from mcp.types import CallToolResult, ListToolsResult, TextContent, Tool

from .pages import PageStore
from .records import call_record


def _token(context):
    request = context.request
    return request.scope.get("state", {}).get("token") if request else None


def _text(value: Any) -> CallToolResult:
    return CallToolResult(content=[TextContent(type="text", text=json.dumps(value, sort_keys=True))])


def build_mcp(store: PageStore):
    sessions: dict[str, set] = {}

    async def principal(context):
        token = _token(context)
        return await anyio.to_thread.run_sync(store.authenticate, token) if token else None

    async def remove_connection(page_id: str, connection) -> None:
        sessions.get(page_id, set()).difference_update(
            session for session in sessions.get(page_id, ()) if session._connection is connection
        )

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
            tools.extend([
                Tool(name="create_page", description="create a new Achilles page", inputSchema={
                    "type": "object", "properties": {"route": {"type": "string"}, "title": {"type": "string"}, "layout": {"type": "object"}},
                    "required": ["route", "title", "layout"], "additionalProperties": False,
                }),
                Tool(name="create_tool", description="create a page-local data tool", inputSchema={
                    "type": "object", "properties": {"bundle": {"type": "object"}}, "required": ["bundle"], "additionalProperties": False,
                }),
            ])
        for bundle in await anyio.to_thread.run_sync(store.page_tools, page["id"]):
            tools.append(Tool(name=bundle["name"], description=bundle["description"], inputSchema=bundle["input_schema"]))
        return ListToolsResult(tools=tools)

    async def call_tool(context, params) -> CallToolResult:
        page = await principal(context)
        if not page:
            return CallToolResult(isError=True, content=[TextContent(type="text", text="forbidden")])
        args = params.arguments or {}
        if params.name in {"create_page", "create_tool"}:
            if not page["create_mode"]:
                return CallToolResult(isError=True, content=[TextContent(type="text", text="forbidden: create mode is off")])
            try:
                if params.name == "create_page":
                    created, digest = await anyio.to_thread.run_sync(store.create_page, args["route"], args["title"], args["layout"], page["id"])
                    result = {"page_id": created["id"], "route": created["route"], "digest": digest}
                else:
                    created, digest = await anyio.to_thread.run_sync(store.create_tool, page["id"], args["bundle"])
                    result = {**created, "digest": digest}
            except (KeyError, TypeError, ValueError, json.JSONDecodeError, PermissionError) as exc:
                return CallToolResult(isError=True, content=[TextContent(type="text", text=str(exc))])
            await notify(page["id"])
            return _text(result)
        try:
            result = await anyio.to_thread.run_sync(call_record, store, page["id"], params.name, args)
        except (PermissionError, TypeError, ValueError, KeyError, json.JSONDecodeError) as exc:
            return CallToolResult(isError=True, content=[TextContent(type="text", text=str(exc))])
        return _text(result)

    server = Server("achilles", on_list_tools=list_tools, on_call_tool=call_tool)
    original_options = server.create_initialization_options
    server.create_initialization_options = lambda **kwargs: original_options(notification_options=NotificationOptions(tools_changed=True), **kwargs)
    app = server.streamable_http_app(streamable_http_path="/", json_response=True, stateless_http=False, host="127.0.0.1")

    @asynccontextmanager
    async def lifespan(_app: Any):
        async with app.router.lifespan_context(app):
            yield

    return app, lifespan, notify
