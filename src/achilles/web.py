from __future__ import annotations

import json
import os
from pathlib import Path
from urllib.parse import urlparse

import anyio
from starlette.applications import Starlette
from starlette.exceptions import HTTPException
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.responses import FileResponse, JSONResponse
from starlette.routing import Mount, Route

from .mcp_server import build_mcp
from .pages import PageStore


def _home() -> Path:
    return Path(os.environ.get("ACHILLES_HOME", Path.home() / ".local/share/achilles"))


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


def _discovery(request):
    path = Path(
        os.environ.get(
            "ACHILLES_ZETA_DISCOVERY",
            Path(os.environ.get("ZETA_HOME", Path.home() / ".zeta")) / "run/serve.ws.json",
        )
    )
    try:
        document = json.loads(path.read_text())
        if not isinstance(document, dict):
            raise ValueError
        port = document["port"]
        if isinstance(port, bool) or not isinstance(port, int) or not 1 <= port <= 65535:
            raise ValueError
        os.kill(int(document["pid"]), 0)
        origin = (
            request.headers.get("origin")
            or f"{request.url.scheme}://{request.headers.get('host', '')}"
        )
        if not _same_origin(request) or origin not in document.get("origins", []):
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
        raise HTTPException(503, "zeta serve is not available")


class PageAuthMiddleware(BaseHTTPMiddleware):
    def __init__(self, app, store: PageStore):
        super().__init__(app)
        self.store = store

    async def dispatch(self, request, call_next):
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

    async def page(request):
        key = request.path_params["route"]
        row = await anyio.to_thread.run_sync(store.page, key if key.startswith("/") else f"/{key}")
        if row is None:
            row = await anyio.to_thread.run_sync(store.page, key)
        if row is None:
            raise HTTPException(404, "page not found")
        return JSONResponse(
            {
                key: row[key]
                for key in (
                    "id",
                    "route",
                    "title",
                    "zeta_session_id",
                    "active_layout_version",
                )
            }
            | {
                "workspace": str(store.root / "pages" / row["id"] / "workspace"),
                "layout": await anyio.to_thread.run_sync(store.layout, row["id"]),
                "create_mode": bool(row["create_mode"]),
            }
        )

    async def credential(request):
        if not _same_origin(request):
            raise HTTPException(403, "same-origin request required")
        row = await anyio.to_thread.run_sync(store.page, request.path_params["id"])
        if row is None:
            raise HTTPException(404, "page not found")
        token = await anyio.to_thread.run_sync(store.ensure_credential, row["id"])
        return JSONResponse({"credential": token}, headers={"cache-control": "no-store"})

    async def session(request):
        body = await request.json()
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
        if not saved:
            return JSONResponse({"session_id": actual}, status_code=409)
        return JSONResponse({"session_id": actual})

    async def records(request):
        page_id = request.path_params["id"]
        token = request.headers.get("authorization", "")
        if not token.startswith("Bearer "):
            raise HTTPException(401, "missing bearer")
        principal = await anyio.to_thread.run_sync(store.authenticate, token[7:])
        if principal is None or principal["id"] != page_id:
            raise HTTPException(403, "forbidden")
        collection = request.path_params["collection"]
        raw_limit = request.query_params.get("limit", "100")
        try:
            limit = int(raw_limit)
        except ValueError as exc:
            raise HTTPException(400, "limit must be an integer") from exc
        if not 1 <= limit <= 100:
            raise HTTPException(400, "limit must be between 1 and 100")
        records, total = await anyio.to_thread.run_sync(store.records, page_id, collection, limit)
        return JSONResponse(records, headers={"x-achilles-total": str(total)})

    async def rollback_tool(request):
        if not _same_origin(request):
            raise HTTPException(403, "same-origin request required")
        page_id = request.path_params["id"]
        token = request.headers.get("authorization", "")
        if not token.startswith("Bearer "):
            raise HTTPException(401, "missing bearer")
        principal = await anyio.to_thread.run_sync(store.authenticate, token[7:])
        if principal is None or principal["id"] != page_id:
            raise HTTPException(403, "forbidden")
        body = await request.json()
        try:
            await anyio.to_thread.run_sync(
                store.rollback_tool, page_id, request.path_params["name"], body["version"]
            )
        except (KeyError, TypeError, ValueError) as exc:
            raise HTTPException(400, str(exc)) from exc
        await notify_tools_changed(page_id)
        return JSONResponse({"ok": True})

    async def create_mode(request):
        if not _same_origin(request):
            raise HTTPException(403, "same-origin request required")
        row = await anyio.to_thread.run_sync(store.page, request.path_params["id"])
        if row is None:
            raise HTTPException(404, "page not found")
        body = await request.json()
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
            Route("/api/pages/{id}/session", session, methods=["PUT"]),
            Route("/api/pages/{id}/credential", credential),
            Route("/api/pages/{id}/create-mode", create_mode, methods=["POST"]),
            Route("/api/pages/{id}/tools/{name}/rollback", rollback_tool, methods=["POST"]),
            Route("/api/pages/{id}/records/{collection}", records),
            Route("/api/pages/{route:path}", page),
            Mount("/mcp", app=mcp),
            Route("/", _app),
            Route("/assets/{path:path}", _asset),
            Route("/{path:path}", _app),
        ],
    )
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
    return FileResponse(_static_file(_static_root(), "index.html"))
