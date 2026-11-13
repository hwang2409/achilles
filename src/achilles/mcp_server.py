from __future__ import annotations

import json
from contextlib import asynccontextmanager
from typing import Any

import anyio
from mcp.server.lowlevel import Server
from mcp.server.lowlevel.server import NotificationOptions
from mcp.types import CallToolResult, ListToolsResult, TextContent, Tool

from .pages import PageStore


def _token(context):
    request = context.request
    return request.scope.get("state", {}).get("token") if request else None


def _text(value: Any) -> CallToolResult:
    return CallToolResult(
        content=[TextContent(type="text", text=json.dumps(value, sort_keys=True))]
    )


def build_mcp(store: PageStore):
    sessions: dict[str, set] = {}

    async def remove_connection(page_id: str, connection) -> None:
        sessions.get(page_id, set()).difference_update(
            session
            for session in sessions.get(page_id, ())
            if session._connection is connection
        )

    async def notify(page_id: str) -> None:
        print(f"mcp notify page={page_id} sessions={len(sessions.get(page_id, ())) }", flush=True)
        for session in list(sessions.get(page_id, ())):
            await session.send_tool_list_changed()
            print(f"mcp notify sent page={page_id}", flush=True)

    async def list_tools(context, _params) -> ListToolsResult:
        token = _token(context)
        principal = await anyio.to_thread.run_sync(store.authenticate, token) if token else None
        if principal:
            page_sessions = sessions.setdefault(principal["id"], set())
            page_sessions.add(context.session)
            print(f"mcp list page={principal['id']} sessions={len(page_sessions)}", flush=True)
            connection = context.session._connection
            cleanup_key = f"achilles-session-cleanup:{principal['id']}"
            if not connection.state.get(cleanup_key):
                connection.state[cleanup_key] = True
                connection.exit_stack.push_async_callback(
                    remove_connection, principal["id"], connection
                )
        return ListToolsResult(
            tools=[
                Tool(
                    name="create_page",
                    description="create a new Achilles page",
                    inputSchema={
                        "type": "object",
                        "properties": {
                            "route": {"type": "string"},
                            "title": {"type": "string"},
                            "layout": {"type": "object"},
                        },
                        "required": ["route", "title", "layout"],
                        "additionalProperties": False,
                    },
                )
            ]
            if principal and principal["create_mode"]
            else []
        )

    async def call_tool(context, params) -> CallToolResult:
        token = _token(context)
        principal = await anyio.to_thread.run_sync(store.authenticate, token) if token else None
        if not principal or params.name != "create_page":
            return CallToolResult(
                isError=True, content=[TextContent(type="text", text="forbidden")]
            )
        try:
            created, digest = await anyio.to_thread.run_sync(
                store.create_page,
                (params.arguments or {})["route"],
                (params.arguments or {})["title"],
                (params.arguments or {})["layout"],
                principal["id"],
            )
        except (KeyError, TypeError, ValueError, json.JSONDecodeError, PermissionError) as exc:
            return CallToolResult(isError=True, content=[TextContent(type="text", text=str(exc))])
        return _text({"page_id": created["id"], "route": created["route"], "digest": digest})

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
