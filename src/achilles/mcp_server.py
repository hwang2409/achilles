from __future__ import annotations

import json
from contextlib import asynccontextmanager
from typing import Any

import anyio
from mcp.server.lowlevel import Server
from mcp.types import CallToolResult, ListToolsResult, TextContent, Tool

from .pages import PageStore
from .records import call_record


def _page(context):
    request = context.request
    return request.scope.get("state", {}).get("page") if request else None


def _text(value: Any) -> CallToolResult:
    return CallToolResult(
        content=[TextContent(type="text", text=json.dumps(value, sort_keys=True))]
    )


def build_mcp(store: PageStore):
    async def list_tools(context, _params) -> ListToolsResult:
        principal = _page(context)
        page = await anyio.to_thread.run_sync(store.page, principal["id"]) if principal else None
        if not page:
            return ListToolsResult(tools=[])
        tools: list[Tool] = []
        if page["create_mode"]:
            tools.extend(
                [
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
                    ),
                ]
            )
        return ListToolsResult(tools=tools)

    async def call_tool(context, params) -> CallToolResult:
        principal = _page(context)
        page = await anyio.to_thread.run_sync(store.page, principal["id"]) if principal else None
        if not page:
            return CallToolResult(
                isError=True, content=[TextContent(type="text", text="forbidden")]
            )
        args = params.arguments or {}
        if params.name == "create_page":
            if not page["create_mode"]:
                return CallToolResult(
                    isError=True,
                    content=[TextContent(type="text", text="forbidden: create mode is off")],
                )
            try:
                if params.name == "create_page":
                    created, digest = await anyio.to_thread.run_sync(
                        store.create_page, args["route"], args["title"], args["layout"]
                    )
                    result = {"page_id": created["id"], "route": created["route"], "digest": digest}

            except (KeyError, TypeError, ValueError, json.JSONDecodeError) as exc:
                return CallToolResult(
                    isError=True, content=[TextContent(type="text", text=str(exc))]
                )
            try:
                await context.session.send_tool_list_changed()
            except Exception:
                pass
            return _text(result)
        try:
            result = await anyio.to_thread.run_sync(
                call_record, store, page["id"], params.name, args
            )
        except (PermissionError, TypeError, ValueError, KeyError, json.JSONDecodeError) as exc:
            return CallToolResult(isError=True, content=[TextContent(type="text", text=str(exc))])
        return _text(result)

    server = Server("achilles", on_list_tools=list_tools, on_call_tool=call_tool)
    app = server.streamable_http_app(
        streamable_http_path="/", json_response=True, stateless_http=True, host="127.0.0.1"
    )

    @asynccontextmanager
    async def lifespan(_app: Any):
        async with app.router.lifespan_context(app):
            yield

    return app, lifespan
