from __future__ import annotations

import json
from contextlib import asynccontextmanager
from typing import Any

import anyio
from mcp.server.lowlevel import Server
from mcp.server.lowlevel.server import NotificationOptions
from mcp.types import CallToolResult, ListToolsResult, TextContent, Tool, ToolAnnotations

from .pages import (
    CREATE_PAGE_SCHEMA,
    EDIT_PAGE_SCHEMA,
    READ_PAGE_FILE_SCHEMA,
    RESTORE_VERSION_SCHEMA,
    PageStore,
    bounded_inspect,
    edits_own_page,
)
from .records import call_record, list_input_schema
from .tools import BUILTIN_TOOL_NAMES, CREATE_TOOL_SCHEMA, derived_output_schema
from .validation import ValidationError, error_document, validate_schema

_UPDATE_TOOL_EXAMPLE = {
    "bundle": {
        "format_version": 1,
        "kind": "data_operation",
        "name": "update_item",
        "description": "update an item",
        "input_schema": {
            "type": "object",
            "properties": {
                "record_id": {"type": "string"},
                "revision": {"type": "integer"},
            },
            "required": ["record_id", "revision"],
        },
        "implementation": {
            "operation": "update",
            "collection": "items",
            "data_schema": {"type": "object"},
        },
    }
}
_UPDATE_TOOL_EXAMPLE_TEXT = json.dumps(_UPDATE_TOOL_EXAMPLE, separators=(",", ":"))
_FIELD_GUIDANCE = (
    "Use the user's exact field words: if they say verdict, name it verdict, not label. "
    "If status, done, verdict, rating, or another field will change later, also create an "
    "update tool. "
)

PAGE_RECORDS_API = (
    "The page stores its data with window.achilles.records (each call returns a Promise; "
    "collections belong to this page): list(collection) returns at most 100 records newest "
    "first, each with record_id; insert(collection, document) returns the new record; "
    "update(collection, record_id, fields) merges fields into the record and returns it; "
    "delete(collection, record_id) removes it. A failed call rejects with {detail}. "
)

INSPECT_PAGE_SCHEMA = {
    "type": "object",
    "properties": {"route": {"type": "string"}, "page_id": {"type": "string"}},
    "additionalProperties": False,
}
INSPECT_PAGE_OUTPUT_SCHEMA = {
    "type": "object",
    "properties": {
        "route": {"type": "string"},
        "title": {"type": "string"},
        "create_mode": {"type": "boolean"},
        "code": {"type": ["object", "null"]},
        "candidate": {"type": ["object", "null"]},
        "tools": {"type": "array", "items": {"type": "object"}},
        "collections": {
            "type": "object",
            "additionalProperties": {"type": "integer", "minimum": 0},
        },
        "truncated": {"type": "boolean"},
    },
    "required": ["route", "title", "create_mode", "code", "tools", "collections"],
    "additionalProperties": False,
}


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
                text=json.dumps(error_document(exc), sort_keys=True),
            )
        ],
    )


def _write_error(exc: ValidationError) -> CallToolResult:
    document = {"error": exc.code, "diagnostics": exc.hint, **(exc.current or {})}
    text = json.dumps(document)
    return CallToolResult(isError=True, content=[TextContent(type="text", text=text)])


def _inspect_result(value: dict[str, Any]) -> CallToolResult:
    _, encoded = bounded_inspect(value)
    return CallToolResult(content=[TextContent(type="text", text=encoded)])


def _inspect_error() -> CallToolResult:
    return _safe_error(ValidationError("", "authorized page", "forbidden"))


def _with_note(result: dict[str, Any], note: str | None) -> dict[str, Any]:
    if note:
        result["note"] = note
    return result


def _validate_create(name: str, args: Any) -> None:
    schema = {
        "create_page": CREATE_PAGE_SCHEMA,
        "create_tool": CREATE_TOOL_SCHEMA,
        "restore_version": RESTORE_VERSION_SCHEMA,
    }[name]
    try:
        validate_schema(args, schema)
    except ValidationError as exc:
        if name == "create_page" and exc.path == "/route" and exc.expected.startswith("pattern "):
            exc.hint = "Use a valid page route whose first segment is not reserved."
        bundle = args.get("bundle") if isinstance(args, dict) else None
        if (
            name == "create_tool"
            and isinstance(bundle, dict)
            and "page" in bundle
            and exc.path.startswith("/bundle")
        ):
            exc.hint = "`page` goes at the top level, not inside `bundle`"
        raise


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
        create_status = "ON" if page["create_mode"] else "OFF"
        can_edit = edits_own_page(page)
        edit_tools: list[Tool] = [
            Tool(
                name="write_page",
                description="write and compile React/TypeScript that mounts into #root; writes are immediate and audited. "  # noqa: E501
                "For a small change to existing code, use edit_page instead. " + PAGE_RECORDS_API,
                inputSchema={
                    "type": "object",
                    "properties": {
                        "source": {"type": "string"},
                        "dependencies": {
                            "type": "object",
                            "additionalProperties": {"type": "string"},
                        },
                        "expected_revision": {"type": ["integer", "null"]},
                    },
                    "required": ["source", "dependencies"],
                    "additionalProperties": False,
                },
            ),
            Tool(
                name="read_page_file",
                description=(
                    "read one file of this page's newest code by lines: src/Page.tsx (the "
                    "source) or package.json (the dependencies). If the newest build failed, "
                    "this is that failed code, so you can fix it. Returns revision for "
                    "edit_page and next_offset while more lines remain."
                ),
                inputSchema=READ_PAGE_FILE_SCHEMA,
                annotations=ToolAnnotations(readOnlyHint=True),
            ),
            Tool(
                name="edit_page",
                description=(
                    "change one file of this page's code with exact replacements, without "
                    "resending the whole file. Each old_string must occur exactly once; edits "
                    "apply in order. Pass the revision read_page_file returned as "
                    "expected_revision. The result compiles like write_page; if an edit does "
                    "not match, nothing changes."
                ),
                inputSchema=EDIT_PAGE_SCHEMA,
            ),
        ]
        tools: list[Tool] = [
            Tool(
                name="inspect_page",
                description=(
                    f"this chat is on the page at route {page['route']!r} (title {page['title']!r}); "  # noqa: E501
                    f"create mode is currently {create_status}"
                    + (
                        "; this chat can still change this page with write_page or edit_page and "
                        "restore its code; creating pages and tools needs create mode. "
                        if can_edit and not page["create_mode"]
                        else ". "
                    )
                    + "Inspect the active React package (file sizes, dependency versions), a "
                    "newer failed build as candidate with its diagnostics, code revision "
                    "history, record counts, tools, and pages created by this page."
                ),
                inputSchema=INSPECT_PAGE_SCHEMA,
                outputSchema=INSPECT_PAGE_OUTPUT_SCHEMA,
                annotations=ToolAnnotations(readOnlyHint=True),
            ),
        ]
        restore_tool = Tool(
            name="restore_version",
            description=(
                "restore an earlier code or tool revision by appending a copy, so history is kept. "  # noqa: E501
                "First call inspect_page. Pass the active revision as expected_version."
                + ("" if page["create_mode"] else " Tool revisions need create mode.")
            ),
            inputSchema=RESTORE_VERSION_SCHEMA,
        )
        if can_edit:
            tools[:0] = edit_tools
        if can_edit and not page["create_mode"]:
            tools.append(restore_tool)
        elif page["create_mode"]:
            tools.extend(
                [
                    Tool(
                        name="create_page",
                        description=(
                            "create and compile a React page; available only in create mode. "
                            "Provide source that mounts into #root and its dependencies, or omit package for a minimal React shell. "  # noqa: E501
                            + PAGE_RECORDS_API
                            + _FIELD_GUIDANCE
                        ),
                        inputSchema=CREATE_PAGE_SCHEMA,
                    ),
                    Tool(
                        name="create_tool",
                        description=(
                            "create a page-owned immutable declarative data tool version; "
                            + _FIELD_GUIDANCE
                            + "For an update tool, use this minimal example: "
                            + _UPDATE_TOOL_EXAMPLE_TEXT
                            + ". revision comes from list/get results; omit output_schema because it is derived; bundle <= 64 KB"  # noqa: E501
                        ),
                        inputSchema=CREATE_TOOL_SCHEMA,
                    ),
                    restore_tool,
                ]
            )
        bundles = await anyio.to_thread.run_sync(store.page_tools, page["id"])
        connection.state[f"achilles-tool-versions:{page['id']}"] = {
            bundle["name"]: bundle["version"] for bundle in bundles
        }
        for bundle in bundles:
            description = bundle["description"]
            output_schema, publish_output_schema = derived_output_schema(bundle)
            input_schema = bundle["input_schema"]
            if bundle["implementation"]["operation"] == "update":
                description += (
                    "; read or list first, then pass the returned revision; record_id "
                    "and revision are for tool calls, not to show the user"
                )
            if bundle["implementation"]["operation"] == "list":
                description += (
                    "; newest first; record_id and revision are for tool calls, not to "
                    "show the user"
                )
                input_schema = list_input_schema(input_schema)
            tools.append(
                Tool(
                    name=bundle["name"],
                    description=description,
                    inputSchema=input_schema,
                    outputSchema=output_schema if publish_output_schema else None,
                )
            )
        return ListToolsResult(tools=tools)

    async def write_page(page, args) -> CallToolResult:
        try:
            result = await anyio.to_thread.run_sync(
                store.write_page,
                page["id"],
                args.get("source", ""),
                args.get("dependencies", {}),
                args.get("expected_revision"),
            )
        except ValidationError as exc:
            return _write_error(exc)
        return CallToolResult(content=[TextContent(type="text", text=json.dumps(result))])

    async def read_page_file(page, args) -> CallToolResult:
        try:
            validate_schema(args, READ_PAGE_FILE_SCHEMA)
            result = await anyio.to_thread.run_sync(
                store.read_page_file,
                page["id"],
                args["path"],
                args.get("offset", 0),
                args.get("limit", 500),
            )
        except ValidationError as exc:
            return _safe_error(exc)
        return _text(result)

    async def edit_page(page, args) -> CallToolResult:
        try:
            validate_schema(args, EDIT_PAGE_SCHEMA)
            result = await anyio.to_thread.run_sync(
                store.edit_page, page["id"], args["path"], args["edits"], args["expected_revision"]
            )
        except ValidationError as exc:
            # a build failure reads like write_page's; a bad edit or stale revision is a plain error
            return _write_error(exc) if exc.path == "/source" else _safe_error(exc)
        return _text(result)

    async def inspect_page(page, args) -> CallToolResult:
        try:
            validate_schema(args, INSPECT_PAGE_SCHEMA)
            if "route" in args and "page_id" in args:
                raise ValidationError("", "one selector", "invalid_input")
            target = page
            if "route" in args or "page_id" in args:
                target = await anyio.to_thread.run_sync(
                    store.page, args.get("route", args.get("page_id"))
                )
            if target is None or (
                target["id"] != page["id"] and target["created_by_page_id"] != page["id"]
            ):
                return _inspect_error()
            summary = await anyio.to_thread.run_sync(store.inspect_page, target["id"])
            return _inspect_result(summary)
        except ValidationError as exc:
            return _safe_error(exc)
        except (KeyError, TypeError, ValueError, json.JSONDecodeError):
            return _inspect_error()

    async def restore_version(page, args) -> dict[str, Any]:
        if args.get("route", page["route"]) != page["route"]:
            raise ValidationError(
                "/route", "this page", "forbidden", "To change another page, open that page's chat."
            )
        if args["kind"] == "code":
            restored = await anyio.to_thread.run_sync(
                store.restore_code, page["id"], args["version"], args["expected_version"]
            )
            return {"kind": "code", **restored}
        if "name" not in args:
            raise ValidationError("/name", "a tool name when kind is tool")
        restored = await anyio.to_thread.run_sync(
            store.rollback_tool, page["id"], args["name"], args["version"], args["expected_version"]
        )
        return {"kind": "tool", **restored}

    async def call_tool(context, params) -> CallToolResult:
        page = await principal(context)
        if not page:
            return CallToolResult(
                isError=True, content=[TextContent(type="text", text="forbidden")]
            )
        args = params.arguments or {}
        page_editors = {
            "write_page": write_page,
            "read_page_file": read_page_file,
            "edit_page": edit_page,
        }
        if params.name in page_editors:
            if not edits_own_page(page):
                return CallToolResult(
                    isError=True,
                    content=[TextContent(type="text", text="forbidden: create mode is off")],
                )
            return await page_editors[params.name](page, args)
        if params.name == "inspect_page":
            return await inspect_page(page, args)
        if params.name in BUILTIN_TOOL_NAMES:
            own_code_restore = (
                params.name == "restore_version" and args.get("kind") == "code"
            ) and edits_own_page(page)
            if not page["create_mode"] and not own_code_restore:
                return CallToolResult(
                    isError=True,
                    content=[TextContent(type="text", text="forbidden: create mode is off")],
                )
            try:
                _validate_create(params.name, args)
                if params.name == "create_page":
                    (
                        created,
                        digest,
                        existing,
                        note,
                    ) = await anyio.to_thread.run_sync(
                        store.create_page,
                        args["route"],
                        args["title"],
                        args.get("package"),
                        page["id"],
                        args.get("tools"),
                    )
                    result = _with_note(
                        {
                            "page_id": created["id"],
                            "route": created["route"],
                            "digest": digest,
                            "existing": existing,
                        },
                        note,
                    )
                elif params.name == "restore_version":
                    result = await restore_version(page, args)
                else:
                    created, digest, note = await anyio.to_thread.run_sync(
                        store.create_tool, page["id"], args["bundle"], "/bundle", args.get("page")
                    )
                    result = _with_note({**created, "digest": digest}, note)
                    if created.get("page_id", page["id"]) != page["id"]:
                        await notify(created["page_id"])
            except ValidationError as exc:
                return _safe_error(exc)
            # PermissionError is an OSError: catch it first, so create mode off says forbidden
            except (KeyError, TypeError, ValueError, json.JSONDecodeError, PermissionError) as exc:
                return CallToolResult(
                    isError=True, content=[TextContent(type="text", text=str(exc))]
                )
            except OSError:
                return _safe_error(ValidationError("", "atomic page creation", "create_failed"))
            await notify(page["id"])
            return _text(result)
        listed_versions = context.session._connection.state.get(
            f"achilles-tool-versions:{page['id']}", {}
        )
        if params.name not in listed_versions:
            await context.session.send_tool_list_changed()
            return _safe_error(ValidationError("", "list tools again", "tool_changed"))
        try:
            result = await anyio.to_thread.run_sync(
                call_record,
                store,
                page["id"],
                params.name,
                args,
                listed_versions[params.name],
                "agent",
            )
        except ValidationError as exc:
            if exc.code == "conflict" and exc.path == "/version":
                return _safe_error(ValidationError("", "list tools again", "tool_changed"))
            return _safe_error(exc)
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
