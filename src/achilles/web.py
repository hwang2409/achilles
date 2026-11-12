from __future__ import annotations

import json
import os
from datetime import UTC, datetime
from pathlib import Path
from urllib.parse import urlparse

import anyio
from starlette.applications import Starlette
from starlette.concurrency import run_in_threadpool
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


def _request_is_same_origin(request, origins: list[str]) -> bool:
    peer = request.client.host if request.client else ""
    host = urlparse(f"//{request.headers.get('host', '')}").hostname
    origin = request.headers.get("origin") or (
        f"{request.url.scheme}://{request.headers.get('host', '')}"
    )
    if not _loopback(f"http://{peer}") or not _loopback(f"http://{host or ''}"):
        return False
    if request.headers.get("sec-fetch-site") not in (None, "same-origin"):
        return False
    return origin in origins


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
        origins = document.get("origins", [])
        if not isinstance(origins, list) or not _request_is_same_origin(request, origins):
            raise HTTPException(403, "same-origin request required")
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
            value = request.headers.get("authorization", "")
            if not value.startswith("Bearer "):
                return JSONResponse({"error": "missing bearer"}, status_code=401)
            page = await anyio.to_thread.run_sync(self.store.authenticate, value[7:])
            if page is None:
                return JSONResponse({"error": "invalid bearer"}, status_code=401)
            request.scope.setdefault("state", {})["page"] = page
        return await call_next(request)


def _save_session(expected: str | None, session_id: str) -> tuple[bool, str | None]:
    db = _database()
    try:
        changed = db.execute(
            "UPDATE page SET zeta_session_id=?, updated_at=? "
            "WHERE id='home' AND zeta_session_id IS ?",
            (session_id, datetime.now(UTC).isoformat(), expected),
        ).rowcount
        db.commit()
        winner = db.execute("SELECT zeta_session_id FROM page WHERE id='home'").fetchone()[0]
        return changed == 1, winner
    finally:
        db.close()


def create_app() -> Starlette:
    store = PageStore(_home())

    async def page(request):
        key = request.path_params["route"]
        row = await run_in_threadpool(
            lambda: store.page(key if key.startswith("/") else f"/{key}") or store.page(key)
        )
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
        )

    async def credential(request):
        page_id = request.path_params["id"]
        token = await anyio.to_thread.run_sync(store.ensure_credential, page_id)
        return JSONResponse({"credential": token})

    async def session(request):
        body = await request.json()
        expected, session_id = body.get("expected_session_id"), body.get("session_id")
        if expected is not None and not isinstance(expected, str):
            raise HTTPException(400, "invalid expected session")
        if not isinstance(session_id, str) or not session_id:
            raise HTTPException(400, "invalid session")
        won, winner = await run_in_threadpool(_save_session, expected, session_id)
        if not won:
            return JSONResponse({"session_id": winner}, status_code=409)
        return JSONResponse({"session_id": session_id})

    async def records(request):
        value = request.headers.get("authorization", "")
        if not value.startswith("Bearer "):
            raise HTTPException(401, "missing bearer")
        page = await anyio.to_thread.run_sync(store.authenticate, value[7:])
        if page is None or page["id"] != request.path_params["id"]:
            raise HTTPException(403, "forbidden")
        rows = await anyio.to_thread.run_sync(
            store.records, page["id"], request.path_params["collection"]
        )
        return JSONResponse(rows)

    async def rollback_tool(request):
        row = await anyio.to_thread.run_sync(store.page, request.path_params["id"])
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
        row = await run_in_threadpool(store.page, request.path_params["id"])
        if row is None:
            raise HTTPException(404, "page not found")
        body = await request.json()
        enabled = body.get("enabled")
        if not isinstance(enabled, bool):
            raise HTTPException(400, "enabled must be boolean")
        row = await run_in_threadpool(store.set_create_mode, row["id"], enabled)
        return JSONResponse({"id": row["id"], "create_mode": bool(row["create_mode"])})

    mcp, mcp_lifespan = build_mcp(store)
    app = Starlette(
        lifespan=mcp_lifespan,
        routes=[
            Route("/api/zeta/discovery", _discovery),
            Route("/api/pages/{id}/credential", credential),
            Route("/api/pages/home/session", session, methods=["PUT"]),
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


def _static_file(root: Path, request_path: str) -> Path:
    root = root.resolve()
    candidate = (root / request_path).resolve()
    if candidate != root and root not in candidate.parents:
        raise HTTPException(404, "static file not found")
    if not candidate.is_file():
        raise HTTPException(404, "static file not found")
    return candidate


async def _asset(request):
    return FileResponse(_static_file(_static_root() / "assets", request.path_params["path"]))


async def _app(request):
    return FileResponse(_static_file(_static_root(), "index.html"))
