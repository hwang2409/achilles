from __future__ import annotations

import base64
import binascii
import json
import os
import secrets
import shlex
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

import anyio
from starlette.applications import Starlette
from starlette.exceptions import HTTPException
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.responses import FileResponse, HTMLResponse, JSONResponse, Response
from starlette.routing import Mount, Route

from .mcp_server import build_mcp
from .page_build import PageBuildError
from .pages import CHAT_PURPOSES, ChatChanged, PageStore, RecordExists
from .records import VersionConflict, call_record
from .validation import ValidationError, error_document

MAX_JSON_BODY = 1024 * 1024  # page bridge writes and shell requests are small JSON objects
EMPTY_PAGE = (
    "this page has no compiled revision. ask the agent in page chat to build it with write_page."
)


def _home() -> Path:
    return Path(os.environ.get("ACHILLES_HOME", Path.home() / ".local/share/achilles"))


def approval_mode() -> str:
    value = os.environ.get("ACHILLES_APPROVAL", "allow")
    if value not in {"allow", "ask"}:
        raise ValueError("ACHILLES_APPROVAL must be allow or ask")
    return value


def _database():
    """compatibility entry point used by the real-zeta fixture seeder."""
    return PageStore(_home())._connect()


def _loopback(value: str) -> bool:
    return urlparse(value).hostname in {"127.0.0.1", "localhost", "::1"}


def _same_origin(request) -> bool:
    peer = request.client.host if request.client else ""
    host = request.headers.get("host", "")
    origin = request.headers.get("origin") or f"{request.url.scheme}://{host}"
    return (
        _loopback(f"http://{peer}")
        and _loopback(f"http://{host}")
        and origin == f"{request.url.scheme}://{host}"
        and request.headers.get("sec-fetch-site") in (None, "same-origin")
    )


def _script_request(request) -> bool:
    # a browser always sends Sec-Fetch-Dest; script tags pass, fetch() reads from other sites do not
    return request.headers.get("sec-fetch-dest") in (None, "script")


def _shell_authorized(request) -> bool:
    supplied = request.headers.get("x-achilles-shell", "").encode()
    expected = request.app.state.shell_token.encode()
    return _same_origin(request) and secrets.compare_digest(supplied, expected)


def _chat_cursor(updated_at: str, session_id: str) -> str:
    payload = json.dumps([updated_at, session_id], separators=(",", ":")).encode()
    return base64.urlsafe_b64encode(payload).decode().rstrip("=")


def _page_cursor(created_at: str, page_id: str) -> str:
    payload = json.dumps([created_at, page_id], separators=(",", ":")).encode()
    return base64.urlsafe_b64encode(payload).decode().rstrip("=")


def _parse_page_cursor(cursor: str | None) -> tuple[str, str] | None:
    if cursor is None:
        return None
    try:
        payload = base64.b64decode(cursor + "=" * (-len(cursor) % 4), altchars=b"-_", validate=True)
        value = json.loads(payload)
    except (binascii.Error, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ValueError("invalid cursor") from exc
    if (
        not isinstance(value, list)
        or len(value) != 2
        or not all(isinstance(item, str) and item for item in value)
    ):
        raise ValueError("invalid cursor")
    return value[0], value[1]


def _parse_chat_cursor(cursor: str | None) -> tuple[str, str] | None:
    if cursor is None:
        return None
    try:
        payload = base64.b64decode(cursor + "=" * (-len(cursor) % 4), altchars=b"-_", validate=True)
        value = json.loads(payload)
    except (binascii.Error, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ValueError("invalid cursor") from exc
    if (
        not isinstance(value, list)
        or len(value) != 2
        or not all(isinstance(item, str) and item for item in value)
    ):
        raise ValueError("invalid cursor")
    return value[0], value[1]


def _start_command(request, attached: str | None, origin: str) -> str | None:
    """The command that starts the zeta serve this achilles reads, for the zeta-down screen."""
    if attached is None:
        return None  # zeta's default discovery: the page names `zeta serve` on the last port it saw
    if Path(attached).resolve() == (_home() / "run/serve.json").resolve():
        port = request.url.port
        return "make dev" if port in (None, 5191) else f"make dev PORT={port}"
    return (
        f"zeta serve --ws 0 --ws-discovery {shlex.quote(attached)}"
        f" --ws-origin {shlex.quote(origin)}"
    )


def _discovery(request):
    attached = os.environ.get("ACHILLES_ZETA_DISCOVERY")
    path = Path(
        attached or Path(os.environ.get("ZETA_HOME", Path.home() / ".zeta")) / "run/serve.ws.json"
    )
    origin = (
        request.headers.get("origin") or f"{request.url.scheme}://{request.headers.get('host', '')}"
    )
    try:
        document = json.loads(path.read_text())
        if not isinstance(document, dict):
            raise ValueError
        port = document["port"]
        if isinstance(port, bool) or not isinstance(port, int) or not 1 <= port <= 65535:
            raise ValueError
        os.kill(int(document["pid"]), 0)
        if not _shell_authorized(request) or origin not in document.get("origins", []):
            raise HTTPException(403, "origin is not allowed")
        return JSONResponse(
            {
                "url": f"ws://127.0.0.1:{port}",
                **{key: document[key] for key in ("controller_token", "observer_token", "origins")},
            },
            headers={"cache-control": "no-store"},
        )
    except HTTPException:
        raise
    except (OSError, KeyError, TypeError, ValueError, json.JSONDecodeError):
        return JSONResponse(
            {
                "detail": "zeta serve is not available",
                "start": _start_command(request, attached, origin),
            },
            status_code=503,
            headers={"cache-control": "no-store"},
        )


class PageAuthMiddleware(BaseHTTPMiddleware):
    def __init__(self, app, store: PageStore):
        super().__init__(app)
        self.store = store

    async def dispatch(self, request, call_next):
        # dns rebinding: another site's name resolved to 127.0.0.1 sends its own Host
        if request.url.path.startswith("/api") and not _loopback(
            f"http://{request.headers.get('host', '')}"
        ):
            return JSONResponse({"error": "loopback host required"}, status_code=403)
        if request.url.path.startswith("/mcp"):
            if not request.client or not _loopback(f"http://{request.client.host}"):
                return JSONResponse({"error": "loopback required"}, status_code=403)
            value = request.headers.get("authorization", "")
            if not value.startswith("Bearer "):
                return JSONResponse({"error": "missing bearer"}, status_code=401)
            page = await anyio.to_thread.run_sync(self.store.authenticate, value[7:])
            if page is None:
                return JSONResponse({"error": "invalid bearer"}, status_code=401)
            request.scope.setdefault("state", {})["page"] = page
            request.scope["state"]["token"] = value[7:]
        return await call_next(request)


def create_app() -> Starlette:
    store = PageStore(_home())
    shell_token = secrets.token_urlsafe(32)

    async def page(request):
        key = request.path_params["route"]
        row = await anyio.to_thread.run_sync(store.page, key if key.startswith("/") else f"/{key}")
        if row is None:
            row = await anyio.to_thread.run_sync(store.page, key)
        if row is None:
            raise HTTPException(404, "page not found")
        code = await anyio.to_thread.run_sync(store.page_code, row["id"])
        # create_page always builds code: only home or a migrated block page lacks it
        unsupported = EMPTY_PAGE if not code and row["id"] != "home" else None
        if unsupported and store.block_model_backup.exists():
            unsupported += f" the old layout of this page is saved in {store.block_model_backup}"
        return JSONResponse(
            {
                key: row[key]
                for key in (
                    "id",
                    "route",
                    "title",
                    "zeta_session_id",
                )
            }
            | {
                "approval_mode": approval_mode(),
            }
            | {
                "workspace": str(store.root / "pages" / row["id"] / "workspace"),
                "create_mode": bool(row["create_mode"]),
                "code": code,
                "unsupported_format": unsupported,
            }
        )

    async def page_frame(request):
        if request.headers.get("sec-fetch-dest") not in (None, "iframe"):
            raise HTTPException(403, "the frame loads only in an iframe")
        row = await anyio.to_thread.run_sync(store.page, request.path_params["id"])
        if row is None:
            raise HTTPException(404, "page not found")
        code = await anyio.to_thread.run_sync(store.page_code, row["id"])
        if not code:
            raise HTTPException(404, "page has no compiled revision")
        # the sandboxed frame's own reloads and form posts are cross-site; only achilles rebuilds
        if request.headers.get("sec-fetch-site") not in (None, "same-origin"):
            if not (store.root / "bundles" / f"{code['digest']}.js").is_file():
                raise HTTPException(404, "page artifact not found")
        else:
            try:
                await anyio.to_thread.run_sync(store.rebuild_artifact, row["id"])
            except PageBuildError as exc:
                raise HTTPException(404, "page artifact not found") from exc
        html = (
            "<!doctype html><meta charset='utf-8'><div id='root'></div>"
            f"<script crossorigin='anonymous' src='/api/pages/{row['id']}/"
            f"frame-bootstrap.js?revision={code['version']}'></script>"
            f"<script crossorigin='anonymous' type='module' src='/api/pages/{row['id']}/"
            f"artifact/{code['digest']}'></script>"
        )
        return HTMLResponse(
            html,
            headers={
                "content-security-policy": (
                    "default-src 'self' https:; script-src 'self' https:; "
                    "style-src 'self' https: 'unsafe-inline'; "
                    "img-src 'self' https: data: blob:; font-src 'self' https: data: blob:; "
                    "connect-src https: http:; frame-ancestors 'self'; "
                    "sandbox allow-scripts allow-forms allow-downloads allow-modals"
                ),
                "cache-control": "no-store",
            },
        )

    async def frame_bootstrap(request):
        if not _script_request(request):
            raise HTTPException(403, "load this script with a script tag")
        row = await anyio.to_thread.run_sync(store.page, request.path_params["id"])
        code = await anyio.to_thread.run_sync(store.page_code, row["id"]) if row else None
        if not code or request.query_params.get("revision") != str(code["version"]):
            raise HTTPException(404, "page revision not found")
        identity = json.dumps({"pageId": row["id"], "revision": code["version"]})
        script = f"""const identity={identity};
const pending=new Map();let request=0;
function call(method,collection,document,id){{return new Promise((resolve,reject)=>{{
 const requestId=String(++request);pending.set(requestId,{{resolve,reject}});
 parent.postMessage({{...identity,requestId,method,collection,document,id}},'*');
}})}}
window.achilles={{records:{{list:(collection)=>call('list',collection),insert:(collection,document)=>call('insert',collection,document),
 update:(collection,id,document)=>call('update',collection,document,String(id)),delete:(collection,id)=>call('delete',collection,undefined,String(id))}}}};
addEventListener('message',event=>{{if(event.source!==parent||event.origin===\"null\")return;
 const item=pending.get(event.data?.requestId);if(!item)return;pending.delete(event.data.requestId);
 event.data.ok?item.resolve(event.data.result):item.reject(event.data.result);
}});
addEventListener('error',event=>parent.postMessage({{...identity,runtimeError:String(event.message)}},'*'));
addEventListener('unhandledrejection',event=>parent.postMessage({{...identity,runtimeError:String(event.reason?.detail??event.reason)}},'*'));
"""
        return Response(
            script,
            media_type="text/javascript",
            headers={
                # the sandboxed frame has the opaque origin "null"; no real site reads or runs it
                "access-control-allow-origin": "null",
                "cross-origin-resource-policy": "same-origin",
                "cache-control": "no-store",
            },
        )

    async def page_artifact(request):
        if not _script_request(request):
            raise HTTPException(403, "load this script with a script tag")
        row = await anyio.to_thread.run_sync(store.page, request.path_params["id"])
        if row is None:
            raise HTTPException(404, "page not found")
        code = await anyio.to_thread.run_sync(store.page_code, row["id"])
        if not code or code["digest"] != request.path_params["digest"]:
            raise HTTPException(404, "artifact not found")
        bundle = store.root / "bundles" / f"{code['digest']}.js"
        # a plain body: FileResponse adds etag and last-modified, which no-store makes dead
        return Response(
            await anyio.to_thread.run_sync(bundle.read_bytes),
            media_type="text/javascript",
            headers={
                # the sandboxed frame has the opaque origin "null"; no real site reads or runs it
                "access-control-allow-origin": "null",
                "cross-origin-resource-policy": "same-origin",
                # a cached copy would answer a top-level visit without the Sec-Fetch-Dest check
                "cache-control": "no-store",
            },
        )

    async def runtime_error(request):
        page_id = await require_page_bearer(request)
        body = await json_object(request)
        revision = body.get("revision")
        if isinstance(revision, bool) or not isinstance(revision, int):
            raise HTTPException(400, "revision must be an integer")
        await anyio.to_thread.run_sync(
            store.set_runtime_error, page_id, revision, str(body.get("error", "runtime error"))
        )
        return JSONResponse({"ok": True})

    async def credential(request):
        if not _shell_authorized(request):
            raise HTTPException(403, "shell request required")
        row = await anyio.to_thread.run_sync(store.page, request.path_params["id"])
        if row is None:
            raise HTTPException(404, "page not found")
        token = await anyio.to_thread.run_sync(store.ensure_credential, row["id"])
        return JSONResponse({"credential": token}, headers={"cache-control": "no-store"})

    async def session(request):
        if not _same_origin(request):
            raise HTTPException(403, "same-origin request required")
        body = await json_object(request)
        expected, session_id = body.get("expected_session_id"), body.get("session_id")
        if expected is not None and not isinstance(expected, str):
            raise HTTPException(400, "invalid expected session")
        if not isinstance(session_id, str) or not session_id:
            raise HTTPException(400, "invalid session")
        page_id = request.path_params["id"]
        try:
            saved, actual = await anyio.to_thread.run_sync(
                store.save_session, page_id, expected, session_id
            )
        except KeyError as exc:
            raise HTTPException(404, "page not found") from exc
        except ValueError as exc:
            raise HTTPException(409, str(exc)) from exc
        if not saved:
            return JSONResponse({"session_id": actual}, status_code=409)
        return JSONResponse({"session_id": actual})

    async def pages(request):
        if not _same_origin(request):
            raise HTTPException(403, "same-origin request required")
        try:
            limit = int(request.query_params.get("limit", "200"))
        except ValueError as exc:
            raise HTTPException(400, "limit must be an integer") from exc
        if not 1 <= limit <= 200:
            raise HTTPException(400, "limit must be between 1 and 200")
        try:
            rows, cursor = await anyio.to_thread.run_sync(
                store.pages, limit, _parse_page_cursor(request.query_params.get("before"))
            )
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc
        return JSONResponse(
            {"pages": rows, "next": _page_cursor(*cursor) if cursor is not None else None}
        )

    async def chats(request):
        if not _same_origin(request):
            raise HTTPException(403, "same-origin request required")
        try:
            limit = int(request.query_params.get("limit", "50"))
        except ValueError as exc:
            raise HTTPException(400, "limit must be an integer") from exc
        if not 1 <= limit <= 200:
            raise HTTPException(400, "limit must be between 1 and 200")
        try:
            rows = await anyio.to_thread.run_sync(
                store.chats,
                limit,
                _parse_chat_cursor(request.query_params.get("before")),
                request.query_params.get("q"),
                request.query_params.get("include"),
            )
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc
        has_more = len(rows) > limit
        rows = rows[:limit]
        next_cursor = (
            _chat_cursor(rows[-1]["updated_at"], rows[-1]["session_id"]) if has_more else None
        )
        approval_count = await anyio.to_thread.run_sync(store.approval_count)
        return JSONResponse({"chats": rows, "next": next_cursor, "approval_count": approval_count})

    async def unsent_chats(request):
        if not _same_origin(request):
            raise HTTPException(403, "same-origin request required")
        ids = await anyio.to_thread.run_sync(store.unsent_chat_ids)
        return JSONResponse({"session_ids": ids})

    async def register_chat(request):
        if not _same_origin(request):
            raise HTTPException(403, "same-origin request required")
        body = await json_object(request)
        session_id = body.get("session_id")
        if not isinstance(session_id, str) or not session_id:
            raise HTTPException(400, "session_id must be a non-empty string")
        purpose = body.get("purpose", "chat")
        if purpose not in CHAT_PURPOSES:
            raise HTTPException(400, "purpose must be chat or page_build")
        try:
            row = await anyio.to_thread.run_sync(
                store.register_chat, request.path_params["id"], session_id, purpose
            )
        except KeyError as exc:
            raise HTTPException(404, "page not found") from exc
        except ValueError as exc:
            raise HTTPException(409, str(exc)) from exc
        return JSONResponse(row)

    async def patch_chat(request):
        if not _same_origin(request):
            raise HTTPException(403, "same-origin request required")
        body = _validated_chat_changes(await json_object(request))
        expected = (
            (body.pop("expected_last_state"), body.pop("expected_state_version"))
            if "expected_state_version" in body
            else None
        )
        try:
            row = await anyio.to_thread.run_sync(
                store.update_chat, request.path_params["session_id"], body, expected
            )
        except KeyError as exc:
            raise HTTPException(404, "chat not found") from exc
        except ChatChanged:
            # an expected race (the holder wrote first), not an error: answer the row as it is now
            row = await anyio.to_thread.run_sync(store.chat, request.path_params["session_id"])
        return JSONResponse(row)

    async def page_tools(request):
        if not _same_origin(request):
            raise HTTPException(403, "same-origin request required")
        page_id = request.path_params["id"]
        if await anyio.to_thread.run_sync(store.page, page_id) is None:
            raise HTTPException(404, "page not found")
        token = request.headers.get("authorization", "")
        if not token.startswith("Bearer "):
            raise HTTPException(403, "forbidden")
        principal = await anyio.to_thread.run_sync(store.authenticate, token[7:])
        if principal is None or principal["id"] != page_id:
            raise HTTPException(403, "forbidden")
        tools = await anyio.to_thread.run_sync(store.page_tools, page_id)
        return JSONResponse(
            {
                "tools": [
                    {
                        "name": tool["name"],
                        "description": tool["description"],
                        "operation": tool["implementation"]["operation"],
                        "collection": tool["implementation"]["collection"],
                        "input_schema": tool["input_schema"],
                        "data_schema": tool["implementation"]["data_schema"],
                        "version": tool["version"],
                        "needs_record_id": tool["implementation"]["operation"] in {"get", "update"},
                        "needs_version": True,
                    }
                    for tool in tools
                ]
            }
        )

    async def invoke_tool(request):
        if not _same_origin(request):
            raise HTTPException(403, "same-origin request required")
        page_id = request.path_params["id"]
        if await anyio.to_thread.run_sync(store.page, page_id) is None:
            raise HTTPException(404, "page not found")
        token = request.headers.get("authorization", "")
        if not token.startswith("Bearer "):
            raise HTTPException(403, "forbidden")
        principal = await anyio.to_thread.run_sync(store.authenticate, token[7:])
        if principal is None or principal["id"] != page_id:
            raise HTTPException(403, "forbidden")
        try:
            body = await capped_json(request)
        except ValueError:  # bad JSON, or a body that is not UTF-8
            error = ValidationError("", "valid JSON object")
            return JSONResponse({"error": error_document(error)}, status_code=400)
        if not isinstance(body, dict) or set(body) - {"arguments", "version"}:
            error = ValidationError("", "only properties: arguments, version")
            return JSONResponse({"error": error_document(error)}, status_code=400)
        arguments = body.get("arguments", {})
        version = body.get("version")
        if isinstance(version, bool) or not isinstance(version, int):
            error = ValidationError("/version", "type: integer")
            return JSONResponse({"error": error_document(error)}, status_code=400)
        try:
            result = await anyio.to_thread.run_sync(
                call_record,
                store,
                page_id,
                request.path_params["name"],
                arguments,
                version,
                "form",
            )
        except VersionConflict as exc:
            return JSONResponse({"error": error_document(exc)}, status_code=409)
        except PermissionError as exc:
            raise HTTPException(404, "tool not found") from exc
        except ValidationError as exc:
            return JSONResponse({"error": error_document(exc)}, status_code=400)
        except (TypeError, ValueError, KeyError, json.JSONDecodeError) as exc:
            raise HTTPException(400, str(exc)) from exc
        return JSONResponse(result)

    async def page_bearer(request) -> str:
        """The request carries this page's own credential; returns the page id."""
        page_id = request.path_params["id"]
        token = request.headers.get("authorization", "")
        if not token.startswith("Bearer "):
            raise HTTPException(401, "missing bearer")
        principal = await anyio.to_thread.run_sync(store.authenticate, token[7:])
        if principal is None or principal["id"] != page_id:
            raise HTTPException(403, "forbidden")
        return page_id

    async def require_page_bearer(request) -> str:
        """Same-origin request carrying this page's own credential; returns the page id."""
        if not _same_origin(request):
            raise HTTPException(403, "same-origin request required")
        return await page_bearer(request)

    async def capped_json(request):
        raw = b""
        async for chunk in request.stream():  # stop reading at the cap, even for a chunked body
            raw += chunk
            if len(raw) > MAX_JSON_BODY:
                raise HTTPException(413, f"body must be at most {MAX_JSON_BODY} bytes")
        return json.loads(raw)

    async def json_object(request) -> dict:
        try:
            body = await capped_json(request)
        except ValueError:  # bad JSON, or a body that is not UTF-8
            body = None
        if not isinstance(body, dict):
            raise HTTPException(400, "body must be a JSON object")
        return body

    def records_headers(total: int) -> dict:
        return {"x-achilles-total": str(total), "cache-control": "no-store"}

    async def records(request):
        page_id = await page_bearer(request)
        collection = request.path_params["collection"]
        if request.method == "POST":
            body = await json_object(request)
            if not isinstance(body.get("record_id", ""), str):
                raise HTTPException(400, "record_id must be a string")
            try:
                inserted = await anyio.to_thread.run_sync(
                    store.insert_record, page_id, collection, body
                )
            except RecordExists as exc:
                raise HTTPException(409, "a record with this record_id already exists") from exc
            return JSONResponse(inserted)
        field = request.query_params.get("field")
        raw_equals = request.query_params.get("equals")
        raw_limit = request.query_params.get("limit", "100")
        try:
            limit = int(raw_limit)
        except ValueError as exc:
            raise HTTPException(400, "limit must be an integer") from exc
        if not 1 <= limit <= 100:
            raise HTTPException(400, "limit must be between 1 and 100")
        if field is not None or raw_equals is not None:
            if field is None or raw_equals is None:
                raise HTTPException(400, "field and equals must be used together")
            try:
                field_filter = {"field": field, "equals": json.loads(raw_equals)}
                records, total = await anyio.to_thread.run_sync(
                    store.matching_records, page_id, collection, field_filter, limit
                )
            except (json.JSONDecodeError, ValidationError) as exc:
                raise HTTPException(400, "invalid record filter") from exc
            return JSONResponse(records, headers=records_headers(total))
        records, total = await anyio.to_thread.run_sync(store.records, page_id, collection, limit)
        return JSONResponse(records, headers=records_headers(total))

    async def record(request):
        page_id = await page_bearer(request)
        collection = request.path_params["collection"]
        record_id = request.path_params["record_id"]
        if request.method == "DELETE":
            if not await anyio.to_thread.run_sync(
                store.delete_record, page_id, collection, record_id
            ):
                raise HTTPException(404, "record not found")
            return JSONResponse({"record_id": record_id, "deleted": True})
        body = await json_object(request)
        updated = await anyio.to_thread.run_sync(
            store.update_record, page_id, collection, record_id, body
        )
        if updated is None:
            raise HTTPException(404, "record not found")
        return JSONResponse(updated)

    async def rollback_tool(request):
        page_id = await require_page_bearer(request)
        try:
            body = await capped_json(request)
        except ValueError:  # bad JSON, or a body that is not UTF-8
            error = ValidationError("", "valid JSON object")
            return JSONResponse({"error": error_document(error)}, status_code=400)
        if not isinstance(body, dict):
            error = ValidationError("", "JSON object")
            return JSONResponse({"error": error_document(error)}, status_code=400)
        try:
            restored = await anyio.to_thread.run_sync(
                store.rollback_tool,
                page_id,
                request.path_params["name"],
                body.get("version"),
                body.get("expected_version"),
            )
        except ValidationError as exc:
            status = 409 if exc.code == "conflict" else 400
            return JSONResponse({"error": error_document(exc)}, status_code=status)
        except PermissionError:
            error = ValidationError(
                "", "create mode on", "forbidden", "turn on create mode to restore tools."
            )
            return JSONResponse({"error": error_document(error)}, status_code=403)
        await notify_tools_changed(page_id)
        return JSONResponse({"ok": True, **restored})

    async def versions(request):
        page_id = await require_page_bearer(request)
        return JSONResponse(
            await anyio.to_thread.run_sync(store.versions, page_id),
            headers={"cache-control": "no-store"},
        )

    async def restore_code(request):
        page_id = await require_page_bearer(request)
        try:
            body = await capped_json(request)
        except ValueError:  # bad JSON, or a body that is not UTF-8
            body = None
        if not isinstance(body, dict):
            error = ValidationError("", "JSON object")
            return JSONResponse({"error": error_document(error)}, status_code=400)
        try:
            restored = await anyio.to_thread.run_sync(
                store.restore_code, page_id, body.get("version"), body.get("expected_version")
            )
        except ValidationError as exc:
            status = 409 if exc.code == "conflict" else 400
            return JSONResponse({"error": error_document(exc)}, status_code=status)
        except PermissionError:
            error = ValidationError(
                "", "create mode on", "forbidden", "turn on create mode to restore code."
            )
            return JSONResponse({"error": error_document(error)}, status_code=403)
        return JSONResponse({"version": restored["revision"], **restored})

    async def create_mode(request):
        if not _same_origin(request):
            raise HTTPException(403, "same-origin request required")
        row = await anyio.to_thread.run_sync(store.page, request.path_params["id"])
        if row is None:
            raise HTTPException(404, "page not found")
        body = await json_object(request)
        enabled = body.get("enabled")
        if not isinstance(enabled, bool):
            raise HTTPException(400, "enabled must be boolean")
        row = await anyio.to_thread.run_sync(store.set_create_mode, row["id"], enabled)
        await notify_tools_changed(row["id"])
        return JSONResponse(
            {
                "id": row["id"],
                "create_mode": bool(row["create_mode"]),
                "notifications": ["notifications/tools/list_changed"],
            }
        )

    mcp, mcp_lifespan, notify_tools_changed = build_mcp(store)
    app = Starlette(
        lifespan=mcp_lifespan,
        routes=[
            Route("/api/zeta/discovery", _discovery),
            Route("/api/pages", pages),
            Route("/api/chats", chats),
            Route("/api/chats/unsent", unsent_chats),
            Route("/api/chats/{session_id}", patch_chat, methods=["PATCH"]),
            Route("/api/pages/{id}/chats", register_chat, methods=["POST"]),
            Route("/api/pages/{id}/session", session, methods=["PUT"]),
            Route("/api/pages/{id}/credential", credential),
            Route("/api/pages/{id}/runtime-error", runtime_error, methods=["POST"]),
            Route("/api/pages/{id}/frame", page_frame),
            Route("/api/pages/{id}/frame-bootstrap.js", frame_bootstrap),
            Route("/api/pages/{id}/artifact/{digest}", page_artifact),
            Route("/api/pages/{id}/create-mode", create_mode, methods=["POST"]),
            Route("/api/pages/{id}/tools", page_tools),
            Route("/api/pages/{id}/tools/{name}/invoke", invoke_tool, methods=["POST"]),
            Route("/api/pages/{id}/tools/{name}/rollback", rollback_tool, methods=["POST"]),
            Route("/api/pages/{id}/versions", versions),
            Route("/api/pages/{id}/code/restore", restore_code, methods=["POST"]),
            Route("/api/pages/{id}/records/{collection}", records, methods=["GET", "POST"]),
            Route(
                "/api/pages/{id}/records/{collection}/{record_id}",
                record,
                methods=["PATCH", "DELETE"],
            ),
            Route("/api/pages/{route:path}", page),
            Mount("/mcp", app=mcp),
            Route("/", _app),
            Route("/assets/{path:path}", _asset),
            Route("/{path:path}", _app),
        ],
    )
    app.state.shell_token = shell_token
    return PageAuthMiddleware(app, store)


def _static_root() -> Path:
    return Path(__file__).parents[2] / "apps/web/dist"


def _static_file(root: Path, name: str) -> Path:
    candidate = (root / name).resolve()
    if root.resolve() not in candidate.parents or not candidate.is_file():
        raise HTTPException(404, "static file not found")
    return candidate


def _asset(request):
    return FileResponse(_static_file(_static_root() / "assets", request.path_params["path"]))


def _app(request):
    html = _static_file(_static_root(), "index.html").read_text()
    marker = '<meta name="achilles-shell" content="' + request.app.state.shell_token + '">'
    if "<head>" in html:
        html = html.replace("<head>", "<head>" + marker, 1)
    else:
        html = marker + html
    return HTMLResponse(html)


def _text(value: str) -> str:
    # drops lone surrogates (a client cut through an emoji); sqlite cannot store them
    return value.encode("utf-8", "ignore").decode()


CHAT_FIELDS = {
    "title",
    "last_state",
    "titled_by_user",
    "first_message",
    "message",
    "expected_last_state",
    "expected_state_version",
}


def _validated_chat_changes(body: Any) -> dict[str, Any]:
    if not isinstance(body, dict) or not body or not set(body) <= CHAT_FIELDS:
        raise HTTPException(
            400,
            "provide only title, last_state, titled_by_user, first_message, message,"
            " or expected_last_state and expected_state_version",
        )
    # expected_*: a compare-and-set of last_state, both together with last_state
    expected = {"expected_last_state", "expected_state_version"} & set(body)
    version = body.get("expected_state_version")
    if expected and (
        len(expected) != 2
        or "last_state" not in body
        or body["expected_last_state"] not in {None, "idle", "running", "approval", "failed"}
        or type(version) is not int
        or version < 0
    ):
        raise HTTPException(
            400, "expected_last_state and expected_state_version go together with last_state"
        )
    # message: a user send (send or steer), the only write that moves a chat in the list
    if "message" in body and body["message"] is not True:
        raise HTTPException(400, "message must be true")
    if "first_message" in body:
        first = body["first_message"]
        if not isinstance(first, str) or len(first) > 200:
            raise HTTPException(400, "first_message must be a string of at most 200 characters")
        body["first_message"] = _text(first).strip() or None
    title = body.get("title")
    if "title" in body and (title is not None and not isinstance(title, str)):
        raise HTTPException(400, "title must be a string or null")
    if isinstance(title, str):
        if len(title) > 200:
            raise HTTPException(400, "title must be at most 200 characters")
        body["title"] = title = _text(title)
    state = body.get("last_state")
    if "last_state" in body and state not in {None, "idle", "running", "approval", "failed"}:
        raise HTTPException(400, "invalid last_state")
    if "titled_by_user" in body and not isinstance(body["titled_by_user"], bool):
        raise HTTPException(400, "titled_by_user must be a boolean")
    if body.get("titled_by_user") is True and not (isinstance(title, str) and title.strip()):
        raise HTTPException(400, "a user title must not be blank")
    return body
