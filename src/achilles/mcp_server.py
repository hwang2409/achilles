from __future__ import annotations

import json
from contextlib import asynccontextmanager
from typing import Any

import anyio
from mcp.server.lowlevel import Server
from mcp.types import CallToolResult, ListToolsResult, TextContent, Tool

from .pages import PageStore


def _page(context):
    request = context.request
    return request.scope.get("state", {}).get("page") if request else None


def build_mcp(store: PageStore):
    async def list_tools(context, _params) -> ListToolsResult:
        page = _page(context)
        if not page or not page["create_mode"]:
            return ListToolsResult(tools=[])
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
        )

    async def call_tool(context, params) -> CallToolResult:
        page = _page(context)
        if not page or not page["create_mode"]:
            return CallToolResult(
                isError=True,
                content=[TextContent(type="text", text="forbidden: create mode is off")],
            )
        if params.name != "create_page":
            return CallToolResult(
                isError=True, content=[TextContent(type="text", text="unknown tool")]
            )
        try:
            args = params.arguments or {}
            created, digest = await anyio.to_thread.run_sync(
                store.create_page, args["route"], args["title"], args["layout"]
            )
        except (KeyError, TypeError, ValueError) as exc:
            return CallToolResult(isError=True, content=[TextContent(type="text", text=str(exc))])
        return CallToolResult(
            content=[
                TextContent(
                    type="text",
                    text=json.dumps(
                        {"page_id": created["id"], "route": created["route"], "digest": digest}
                    ),
                )
            ]
        )

    server = Server("achilles", on_list_tools=list_tools, on_call_tool=call_tool)
    app = server.streamable_http_app(
        streamable_http_path="/", json_response=True, stateless_http=True, host="127.0.0.1"
    )

    @asynccontextmanager
    async def lifespan(_app: Any):
        async with app.router.lifespan_context(app):
            yield

    return app, lifespan
