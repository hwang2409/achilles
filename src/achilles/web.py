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
    version = db.execute("PRAGMA user_version").fetchone()[0]
    if version not in (0, 1):
        db.close()
        raise RuntimeError(f"unsupported database version: {version}")
    db.execute("""CREATE TABLE IF NOT EXISTS page (
        id TEXT PRIMARY KEY, route TEXT NOT NULL UNIQUE, title TEXT NOT NULL,
        zeta_session_id TEXT, active_layout_version INTEGER, created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
    )""")
    now = _now()
    db.execute(
        "INSERT OR IGNORE INTO page VALUES ('home', '/', 'home', NULL, NULL, ?, ?)", (now, now)
    )
    db.execute("PRAGMA user_version = 1")
    db.commit()
    for sidecar in (root / "achilles.sqlite3-wal", root / "achilles.sqlite3-shm"):
        if sidecar.exists():
            sidecar.chmod(0o600)
    return db


def _loopback(value: str) -> bool:
    parsed = urlparse(value)
    return parsed.hostname in {"127.0.0.1", "localhost", "::1"}


def _request_is_same_origin(request, origins: list[str]) -> bool:
    peer = request.client.host if request.client else ""
    host = urlparse(f"//{request.headers.get('host', '')}").hostname
    origin = request.headers.get("origin", "")
    if not _loopback(f"http://{peer}") or not _loopback(f"http://{host or ''}"):
        return False
    if request.headers.get("sec-fetch-site") not in (None, "same-origin"):
        return False
    return bool(origin and origin in origins)


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
