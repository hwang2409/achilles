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
    return PageStore(_home()).db


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
        if not isinstance(document, dict) or not _loopback(str(document["url"])):
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
                key: document[key]
                for key in ("url", "controller_token", "observer_token", "origins")
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
        return await call_next(request)


def create_app() -> Starlette:
    store = PageStore(_home())

    async def page(request):
        key = request.path_params["route"]
        row = store.page(key if key.startswith("/") else f"/{key}") or store.page(key)
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
                    "create_mode",
                )
            }
            | {
                "workspace": str(store.root / "pages" / row["id"] / "workspace"),
                "layout": store.layout(row["id"]),
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
        page_row = store.page(page_id)
        if page_row is None:
            raise HTTPException(404, "page not found")
        current = page_row["zeta_session_id"]
        if current != expected:
            return JSONResponse({"session_id": current}, status_code=409)
        changed = store.db.execute(
            "UPDATE page SET zeta_session_id=?, updated_at=? WHERE id=? AND zeta_session_id IS ?",
            (
                session_id,
                __import__("datetime").datetime.now(__import__("datetime").UTC).isoformat(),
                page_id,
                expected,
            ),
        ).rowcount
        store.db.commit()
        if changed != 1:
            return JSONResponse(
                {"session_id": store.page(page_id)["zeta_session_id"]}, status_code=409
            )
        return JSONResponse({"session_id": session_id})

    async def rollback_tool(request):
        row = store.page(request.path_params["id"])
        if row is None:
            raise HTTPException(404, "page not found")
        body = await request.json()
        if not isinstance(body.get("version"), int) or body["version"] < 1:
            raise HTTPException(400, "version must be a positive integer")
        try:
            await anyio.to_thread.run_sync(
                store.rollback_tool, row["id"], request.path_params["name"], body["version"]
            )
        except ValueError as exc:
            raise HTTPException(404, str(exc)) from exc
        return JSONResponse({"ok": True})

    async def create_mode(request):
        if not _same_origin(request):
            raise HTTPException(403, "same-origin request required")
        row = store.page(request.path_params["id"])
        if row is None:
            raise HTTPException(404, "page not found")
        body = await request.json()
        enabled = body.get("enabled")
        if not isinstance(enabled, bool):
            raise HTTPException(400, "enabled must be boolean")
        row = store.set_create_mode(row["id"], enabled)
        return JSONResponse({"id": row["id"], "create_mode": bool(row["create_mode"])})

    mcp, mcp_lifespan = build_mcp(store)
    app = Starlette(
        lifespan=mcp_lifespan,
        routes=[
            Route("/api/zeta/discovery", _discovery),
            Route("/api/pages/{id}/session", session, methods=["PUT"]),
            Route("/api/pages/{id}/credential", credential),
            Route("/api/pages/{id}/create-mode", create_mode, methods=["POST"]),
            Route("/api/pages/{id}/tools/{name}/rollback", rollback_tool, methods=["POST"]),
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
