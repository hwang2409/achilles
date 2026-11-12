from __future__ import annotations

import json
from contextlib import asynccontextmanager
from typing import Any

import anyio
from mcp.server.lowlevel import Server
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
    async def list_tools(context, _params) -> ListToolsResult:
        token = _token(context)
        principal = await anyio.to_thread.run_sync(store.authenticate, token) if token else None
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
    app = server.streamable_http_app(
        streamable_http_path="/", json_response=True, stateless_http=True, host="127.0.0.1"
    )

    @asynccontextmanager
    async def lifespan(_app: Any):
        async with app.router.lifespan_context(app):
            yield

    return app, lifespan
