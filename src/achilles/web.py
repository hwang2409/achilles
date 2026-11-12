from __future__ import annotations

import json
import os
import sqlite3
from datetime import UTC, datetime
from pathlib import Path
from urllib.parse import urlparse

from starlette.applications import Starlette
from starlette.concurrency import run_in_threadpool
from starlette.exceptions import HTTPException
from starlette.responses import FileResponse, JSONResponse
from starlette.routing import Route


def _now() -> str:
    return datetime.now(UTC).isoformat()


def _home() -> Path:
    return Path(os.environ.get("ACHILLES_HOME", Path.home() / ".local/share/achilles"))


def _database() -> sqlite3.Connection:
    root = _home()
    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    root.chmod(0o700)
    path = root / "achilles.sqlite3"
    db = sqlite3.connect(path)
    path.chmod(0o600)
    db.execute("PRAGMA journal_mode=WAL")
    db.execute("PRAGMA foreign_keys=ON")
    db.execute("PRAGMA busy_timeout=5000")
    db.execute("""CREATE TABLE IF NOT EXISTS page (
        id TEXT PRIMARY KEY, route TEXT NOT NULL UNIQUE, title TEXT NOT NULL,
        zeta_session_id TEXT, active_layout_version INTEGER, created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
    )""")
    now = _now()
    db.execute(
        "INSERT OR IGNORE INTO page VALUES ('home', '/', 'home', NULL, NULL, ?, ?)", (now, now)
    )
    db.commit()
    for sidecar in (root / "achilles.sqlite3-wal", root / "achilles.sqlite3-shm"):
        if sidecar.exists():
            sidecar.chmod(0o600)
    return db


def _loopback(value: str) -> bool:
    parsed = urlparse(value)
    return parsed.hostname in {"127.0.0.1", "localhost", "::1"}


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
        if not _loopback(str(document["url"])):
            raise ValueError
        if int(document["pid"]) <= 0:
            raise ValueError
        os.kill(int(document["pid"]), 0)
        origin = str(request.headers.get("origin", ""))
        if not origin:
            origin = f"{request.url.scheme}://{request.headers.get('host', '')}"
        origins = document.get("origins", [])
        if origin not in origins:
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


def _page(request):
    with _database() as db:
        row = db.execute(
            "SELECT id, route, title, zeta_session_id, active_layout_version "
            "FROM page WHERE id = ? OR route = ?",
            (request.path_params["route"], request.path_params["route"]),
        ).fetchone()
    if row is None:
        raise HTTPException(404, "page not found")
    return JSONResponse(
        dict(zip(("id", "route", "title", "zeta_session_id", "active_layout_version"), row))
    )


def _save_session(expected: str | None, session_id: str) -> tuple[bool, str | None]:
    with _database() as db:
        changed = db.execute(
            "UPDATE page SET zeta_session_id = ?, updated_at = ? "
            "WHERE id = 'home' AND zeta_session_id IS ?",
            (session_id, _now(), expected),
        ).rowcount
        winner = db.execute("SELECT zeta_session_id FROM page WHERE id = 'home'").fetchone()[0]
    return changed == 1, winner


async def _session(request):
    body = await request.json()
    expected = body.get("expected_session_id")
    session_id = body.get("session_id")
    if expected is not None and not isinstance(expected, str):
        raise HTTPException(400, "invalid expected session")
    if not isinstance(session_id, str) or not session_id:
        raise HTTPException(400, "invalid session")
    won, winner = await run_in_threadpool(_save_session, expected, session_id)
    if not won:
        return JSONResponse({"session_id": winner}, status_code=409)
    return JSONResponse({"session_id": session_id})


async def _asset(request):
    path = Path(__file__).parents[2] / "apps/web/dist/assets" / request.path_params["path"]
    if not path.is_file():
        raise HTTPException(404, "asset not found")
    return FileResponse(path)


async def _app(request):
    path = Path(__file__).parents[2] / "apps/web/dist/index.html"
    if not path.exists():
        raise HTTPException(404, "web assets are not built")
    return FileResponse(path)


def create_app() -> Starlette:
    return Starlette(
        routes=[
            Route("/api/zeta/discovery", _discovery),
            Route("/api/pages/home/session", _session, methods=["PUT"]),
            Route("/api/pages/{route:path}", _page),
            Route("/", _app),
            Route("/assets/{path:path}", _asset),
            Route("/{path:path}", _app),
        ]
    )
