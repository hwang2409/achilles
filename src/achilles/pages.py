from __future__ import annotations

import hashlib
import json
import os
import secrets
import shutil
import sqlite3
import tempfile
from contextlib import contextmanager
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from .tools import TOOL_BUNDLE_SCHEMA, bundle_digest, canonical_bundle, validate_bundle
from .validation import ValidationError, validate_schema

_LAYOUT_BLOCK_SCHEMA = {
    "oneOf": [
        {
            "type": "object",
            "properties": {
                "type": {"const": "list"},
                "title": {"type": "string"},
                "collection": {"type": "string"},
            },
            "required": ["type", "title", "collection"],
            "additionalProperties": False,
        },
        {
            "type": "object",
            "properties": {
                "type": {"const": "detail"},
                "title": {"type": "string"},
                "fields": {"type": "array", "items": {"type": "string"}},
            },
            "required": ["type", "title", "fields"],
            "additionalProperties": False,
        },
        {
            "type": "object",
            "properties": {
                "type": {"const": "form"},
                "title": {"type": "string"},
                "tool": {"type": "string"},
            },
            "required": ["type", "title", "tool"],
            "additionalProperties": False,
        },
        {
            "type": "object",
            "properties": {"type": {"const": "text"}, "text": {"type": "string"}},
            "required": ["type", "text"],
            "additionalProperties": False,
        },
        {
            "type": "object",
            "properties": {
                "type": {"const": "metric"},
                "label": {"type": "string"},
                "value": {"type": "string"},
            },
            "required": ["type", "label", "value"],
            "additionalProperties": False,
        },
    ]
}
LAYOUT_SCHEMA = {
    "type": "object",
    "properties": {"blocks": {"type": "array", "items": _LAYOUT_BLOCK_SCHEMA}},
    "required": ["blocks"],
    "additionalProperties": False,
}
CREATE_PAGE_SCHEMA = {
    "type": "object",
    "properties": {
        "route": {
            "type": "string",
            "pattern": (
                r"^/(?!api(?:/|$)|assets(?:/|$)|mcp(?:/|$))"
                r"(?:[a-z0-9][a-z0-9-]{0,62})"
                r"(?:/(?:[a-z0-9][a-z0-9-]{0,62})){0,7}$"
            ),
        },
        "title": {"type": "string", "minLength": 1},
        "layout": LAYOUT_SCHEMA,
        "tools": {"type": "array", "items": TOOL_BUNDLE_SCHEMA},
    },
    "required": ["route", "title", "layout"],
    "additionalProperties": False,
}


def validate_page_route(route: str) -> None:
    validate_schema(route, CREATE_PAGE_SCHEMA["properties"]["route"], "/route")


def now() -> str:
    return datetime.now(UTC).isoformat()


def ensure_column(conn, table: str, column: str, ddl: str) -> None:
    conn.execute("BEGIN IMMEDIATE")
    try:
        columns = {row[1] for row in conn.execute(f"PRAGMA table_info({table})")}
        if column not in columns:
            conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {ddl}")
        conn.commit()
    except BaseException:
        conn.rollback()
        raise


def validate_layout(
    layout: Any,
    assigned_tools: set[str] | None = None,
    assigned_collections: set[str] | None = None,
    prefix: str = "",
) -> dict[str, Any]:
    validate_schema(layout, LAYOUT_SCHEMA, prefix)
    tools = assigned_tools or set()
    for index, block in enumerate(layout["blocks"]):
        if block["type"] == "form" and block["tool"] not in tools:
            raise ValidationError(f"{prefix}/blocks/{index}/tool", "assigned tool name")
        if (
            block["type"] == "list"
            and assigned_collections is not None
            and block["collection"] not in assigned_collections
        ):
            raise ValidationError(f"{prefix}/blocks/{index}/collection", "assigned collection")
    return layout


class PageStore:
    def __init__(self, root: Path):
        self.root = root
        for directory in (root, root / "pages", root / "bundles", root / "credentials"):
            directory.mkdir(mode=0o700, parents=True, exist_ok=True)
            directory.chmod(0o700)
        self._database = root / "achilles.sqlite3"
        db = self._connect()
        version = db.execute("PRAGMA user_version").fetchone()[0]
        if version not in (0, 1, 2, 3):
            raise RuntimeError(f"unsupported Achilles database version: {version}")
        db.executescript("""
        CREATE TABLE IF NOT EXISTS page (
          id TEXT PRIMARY KEY, route TEXT NOT NULL UNIQUE, title TEXT NOT NULL,
          zeta_session_id TEXT, active_layout_version INTEGER,
          created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
          create_mode INTEGER NOT NULL DEFAULT 0, credential_hash TEXT,
          created_by_page_id TEXT REFERENCES page(id)
        );
        CREATE TABLE IF NOT EXISTS layout_version (
          page_id TEXT NOT NULL REFERENCES page(id), version INTEGER NOT NULL,
          digest TEXT NOT NULL, document TEXT NOT NULL, created_at TEXT NOT NULL,
          PRIMARY KEY(page_id, version)
        );
        CREATE TABLE IF NOT EXISTS audit (
          id INTEGER PRIMARY KEY, page_id TEXT NOT NULL REFERENCES page(id),
          action TEXT NOT NULL, version_digest TEXT, created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS tool (
          id TEXT PRIMARY KEY, owner_page_id TEXT NOT NULL REFERENCES page(id),
          name TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(owner_page_id, name)
        );
        CREATE TABLE IF NOT EXISTS tool_version (
          tool_id TEXT NOT NULL REFERENCES tool(id), version INTEGER NOT NULL,
          digest TEXT NOT NULL, bundle TEXT NOT NULL, created_at TEXT NOT NULL,
          PRIMARY KEY(tool_id, version)
        );
        CREATE TABLE IF NOT EXISTS page_tool (
          page_id TEXT NOT NULL REFERENCES page(id), tool_id TEXT NOT NULL REFERENCES tool(id),
          active_version INTEGER NOT NULL, assigned_at TEXT NOT NULL,
          PRIMARY KEY(page_id, tool_id)
        );
        CREATE TABLE IF NOT EXISTS page_record (
          page_id TEXT NOT NULL REFERENCES page(id), collection TEXT NOT NULL,
          record_id TEXT NOT NULL, version INTEGER NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
          document TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
          PRIMARY KEY(page_id, collection, record_id)
        );
        CREATE TABLE IF NOT EXISTS chat (
          session_id TEXT PRIMARY KEY, page_id TEXT NOT NULL REFERENCES page(id),
          title TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_state TEXT
        );
        CREATE INDEX IF NOT EXISTS chat_updated_at ON chat(updated_at DESC);
        CREATE INDEX IF NOT EXISTS chat_page_updated_at ON chat(page_id, updated_at DESC);
        """)
        columns = {row[1] for row in db.execute("PRAGMA table_info(page)")}
        if "create_mode" not in columns:
            db.execute("ALTER TABLE page ADD COLUMN create_mode INTEGER NOT NULL DEFAULT 0")
        if "credential_hash" not in columns:
            db.execute("ALTER TABLE page ADD COLUMN credential_hash TEXT")
        ensure_column(db, "page", "created_by_page_id", "TEXT REFERENCES page(id)")
        ensure_column(db, "page_record", "revision", "INTEGER NOT NULL DEFAULT 1")
        stamp = now()
        db.execute(
            "INSERT OR IGNORE INTO page(id,route,title,created_at,updated_at) VALUES ('home','/','home',?,?)",  # noqa: E501
            (stamp, stamp),
        )
        db.execute(
            "INSERT OR IGNORE INTO chat(session_id,page_id,created_at,updated_at) "
            "SELECT zeta_session_id,id,created_at,updated_at FROM page "
            "WHERE zeta_session_id IS NOT NULL"
        )
        db.execute("PRAGMA user_version = 3")
        db.commit()
        db.close()
        self._chmod_db()
        self.ensure_credential("home")
        workspace = self.root / "pages" / "home" / "workspace"
        workspace.mkdir(mode=0o700, parents=True, exist_ok=True)
        workspace.chmod(0o700)

    def _connect(self):
        connection = sqlite3.connect(self._database, timeout=5)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys=ON")
        connection.execute("PRAGMA busy_timeout=5000")
        return connection

    @contextmanager
    def transaction(self):
        db = self._connect()
        try:
            db.execute("BEGIN IMMEDIATE")
            yield db
            db.commit()
        except BaseException:
            db.rollback()
            raise
        finally:
            db.close()

    def _chmod_db(self):
        for path in (
            self._database,
            Path(str(self._database) + "-wal"),
            Path(str(self._database) + "-shm"),
        ):
            if path.exists():
                path.chmod(0o600)

    def _atomic_private_write(self, path: Path, content: bytes) -> None:
        path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        fd, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
        try:
            os.fchmod(fd, 0o600)
            with os.fdopen(fd, "wb") as stream:
                stream.write(content)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, path)
        except BaseException:
            try:
                os.unlink(temporary)
            except FileNotFoundError:
                pass
            raise

    def ensure_credential(self, page_id: str) -> str:
        with self.transaction() as db:
            row = db.execute("SELECT credential_hash FROM page WHERE id=?", (page_id,)).fetchone()
            if row is None:
                raise KeyError(page_id)
            path = self.root / "credentials" / page_id
            if row["credential_hash"] and path.exists():
                return path.read_text().strip()
            token = secrets.token_urlsafe(32)
            digest = hashlib.sha256(token.encode()).hexdigest()
            db.execute("UPDATE page SET credential_hash=? WHERE id=?", (digest, page_id))
            self._atomic_private_write(path, token.encode())
            return token

    def authenticate(self, token: str) -> sqlite3.Row | None:
        with self._connect() as db:
            return db.execute(
                "SELECT * FROM page WHERE credential_hash=?",
                (hashlib.sha256(token.encode()).hexdigest(),),
            ).fetchone()

    def page(self, key: str) -> sqlite3.Row | None:
        with self._connect() as db:
            return db.execute("SELECT * FROM page WHERE id=? OR route=?", (key, key)).fetchone()

    def layout(self, page_id: str) -> dict[str, Any]:
        with self._connect() as db:
            row = db.execute(
                "SELECT document FROM layout_version WHERE page_id=? ORDER BY version DESC LIMIT 1",
                (page_id,),
            ).fetchone()
            return json.loads(row[0]) if row else {"blocks": []}

    def inspect_page(self, page_id: str) -> dict[str, Any]:
        with self._connect() as db:
            layout = db.execute(
                "SELECT version, digest, document FROM layout_version "
                "WHERE page_id=? ORDER BY version DESC LIMIT 1",
                (page_id,),
            ).fetchone()
            counts = db.execute(
                "SELECT collection, COUNT(*) FROM page_record WHERE page_id=? GROUP BY collection",
                (page_id,),
            ).fetchall()
        row = self.page(page_id)
        if row is None:
            raise KeyError(page_id)
        document = json.loads(layout[2]) if layout else {"blocks": []}
        tools = self.page_tools(page_id)
        return {
            "route": row["route"],
            "title": row["title"],
            "create_mode": bool(row["create_mode"]),
            "layout": {
                "version": layout[0] if layout else None,
                "digest": layout[1] if layout else None,
                "blocks": [
                    {
                        key: block[key]
                        for key in ("type", "title", "tool", "collection")
                        if key in block
                    }
                    for block in document.get("blocks", [])
                ],
            },
            "tools": [
                {
                    "name": tool["name"],
                    "version": tool["version"],
                    "operations": [tool["implementation"]["operation"]],
                    "collection": tool["implementation"]["collection"],
                }
                for tool in tools
            ],
            "collections": {collection: count for collection, count in counts},
        }

    def records(
        self, page_id: str, collection: str, limit: int = 100
    ) -> tuple[list[dict[str, Any]], int]:
        with self._connect() as db:
            total = db.execute(
                "SELECT COUNT(*) FROM page_record WHERE page_id=? AND collection=?",
                (page_id, collection),
            ).fetchone()[0]
            rows = db.execute(
                "SELECT record_id, document, revision FROM page_record "
                "WHERE page_id=? AND collection=? ORDER BY created_at DESC, rowid DESC LIMIT ?",
                (page_id, collection, limit),
            ).fetchall()
        return (
            [{**json.loads(row[1]), "record_id": row[0], "revision": row[2]} for row in rows],
            total,
        )

    def set_create_mode(self, page_id: str, enabled: bool) -> sqlite3.Row:
        with self.transaction() as db:
            db.execute(
                "UPDATE page SET create_mode=?, updated_at=? WHERE id=?",
                (int(enabled), now(), page_id),
            )
        row = self.page(page_id)
        if row is None:
            raise KeyError(page_id)
        return row

    def pages(
        self, limit: int = 200, before: tuple[str, str] | None = None
    ) -> tuple[list[dict[str, Any]], tuple[str, str] | None]:
        with self._connect() as db:
            where = ""
            parameters: list[Any] = []
            if before is not None:
                updated_at, page_id = before
                where = "WHERE (p.updated_at < ? OR (p.updated_at = ? AND p.id < ?))"
                parameters.extend((updated_at, updated_at, page_id))
            rows = db.execute(
                "SELECT p.id,p.route,p.title,p.created_at,p.updated_at,p.create_mode,"
                "creator.route AS created_by_route,COUNT(c.session_id) AS chat_count "
                "FROM page p LEFT JOIN page creator ON creator.id=p.created_by_page_id "
                "LEFT JOIN chat c ON c.page_id=p.id "
                f"{where} GROUP BY p.id ORDER BY p.updated_at DESC,p.id DESC LIMIT ?",
                (*parameters, limit + 1),
            ).fetchall()
        page_rows = rows[:limit]
        next_cursor = None
        if len(rows) > limit:
            next_cursor = (page_rows[-1]["updated_at"], page_rows[-1]["id"])
        return [
            {
                "id": row["id"],
                "route": row["route"],
                "title": row["title"],
                "created_at": row["created_at"],
                "updated_at": row["updated_at"],
                "create_mode": bool(row["create_mode"]),
                "chat_count": row["chat_count"],
                "created_by_route": row["created_by_route"],
            }
            for row in page_rows
        ], next_cursor

    def chats(
        self,
        limit: int,
        before: tuple[str, str] | None = None,
        query: str | None = None,
    ) -> list[dict[str, Any]]:
        clauses: list[str] = []
        parameters: list[Any] = []
        with self._connect() as db:
            if before is not None:
                updated_at, session_id = before
                clauses.append("(c.updated_at < ? OR (c.updated_at = ? AND c.session_id < ?))")
                parameters.extend((updated_at, updated_at, session_id))
            if query is not None:
                escaped = query.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
                clauses.append("c.title LIKE ? ESCAPE '\\' COLLATE NOCASE")
                parameters.append(f"%{escaped}%")
            where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
            rows = db.execute(
                "SELECT c.session_id,c.page_id,p.route AS page_route,p.title AS page_title,"
                "c.title,c.created_at,c.updated_at,c.last_state FROM chat c "
                f"JOIN page p ON p.id=c.page_id {where} "
                "ORDER BY c.updated_at DESC,c.session_id DESC LIMIT ?",
                (*parameters, limit + 1),
            ).fetchall()
        return [dict(row) for row in rows]

    def approval_count(self) -> int:
        with self._connect() as db:
            return int(
                db.execute("SELECT COUNT(*) FROM chat WHERE last_state='approval'").fetchone()[0]
            )

    def register_chat(self, page_id: str, session_id: str) -> dict[str, Any]:
        with self.transaction() as db:
            if db.execute("SELECT 1 FROM page WHERE id=?", (page_id,)).fetchone() is None:
                raise KeyError(page_id)
            stamp = now()
            db.execute(
                "INSERT OR IGNORE INTO chat(session_id,page_id,created_at,updated_at) "
                "VALUES(?,?,?,?)",
                (session_id, page_id, stamp, stamp),
            )
            row = db.execute(
                "SELECT page_id FROM chat WHERE session_id=?", (session_id,)
            ).fetchone()
            if row["page_id"] != page_id:
                raise ValueError("session belongs to another page")
            db.execute("UPDATE chat SET updated_at=? WHERE session_id=?", (stamp, session_id))
        return self.chat(session_id)

    def chat(self, session_id: str) -> dict[str, Any]:
        with self._connect() as db:
            row = db.execute(
                "SELECT session_id,page_id,title,created_at,updated_at,last_state "
                "FROM chat WHERE session_id=?",
                (session_id,),
            ).fetchone()
        if row is None:
            raise KeyError(session_id)
        return dict(row)

    def update_chat(self, session_id: str, changes: dict[str, str | None]) -> dict[str, Any]:
        assignments = [f"{key}=?" for key in changes]
        with self.transaction() as db:
            updated = db.execute(
                f"UPDATE chat SET {','.join(assignments)},updated_at=? WHERE session_id=?",
                (*changes.values(), now(), session_id),
            ).rowcount
            if not updated:
                raise KeyError(session_id)
        return self.chat(session_id)

    def save_session(
        self, page_id: str, expected: str | None, session_id: str
    ) -> tuple[bool, str | None]:
        with self.transaction() as db:
            stamp = now()
            updated = db.execute(
                "UPDATE page SET zeta_session_id=?,updated_at=? WHERE id=? AND zeta_session_id IS ?",  # noqa: E501
                (session_id, stamp, page_id, expected),
            ).rowcount
            row = db.execute("SELECT zeta_session_id FROM page WHERE id=?", (page_id,)).fetchone()
            if row is None:
                raise KeyError(page_id)
            if updated:
                owner = db.execute(
                    "SELECT page_id FROM chat WHERE session_id=?", (session_id,)
                ).fetchone()
                if owner is not None and owner["page_id"] != page_id:
                    raise ValueError("session belongs to another page")
                db.execute(
                    "INSERT INTO chat(session_id,page_id,created_at,updated_at) VALUES(?,?,?,?) "
                    "ON CONFLICT(session_id) DO UPDATE SET updated_at=excluded.updated_at",
                    (session_id, page_id, stamp, stamp),
                )
            return updated == 1, row[0]

    def create_page(
        self,
        route: str,
        title: str,
        layout: Any,
        principal_id: str = "home",
        tools: Any = None,
    ) -> tuple[sqlite3.Row, str, bool]:
        bundles = [] if tools is None else tools
        value = {"route": route, "title": title, "layout": layout, "tools": bundles}
        validate_schema(value, CREATE_PAGE_SCHEMA)
        bundles = [
            validate_bundle(bundle, f"/tools/{index}", reject_conflicting_output=True)
            for index, bundle in enumerate(bundles)
        ]
        validate_layout(
            layout,
            {bundle["name"] for bundle in bundles},
            {bundle["implementation"]["collection"] for bundle in bundles},
            "/layout",
        )
        encoded = json.dumps(layout, sort_keys=True, separators=(",", ":"))
        digest = hashlib.sha256(encoded.encode()).hexdigest()
        created_paths: set[Path] = set()
        page_id: str | None = None
        try:
            with self.transaction() as db:
                principal = db.execute(
                    "SELECT create_mode FROM page WHERE id=?", (principal_id,)
                ).fetchone()
                if principal is None or not principal[0]:
                    raise PermissionError("forbidden: create mode is off")
                existing = db.execute("SELECT * FROM page WHERE route=?", (route,)).fetchone()
                if existing is not None:
                    existing_layout = db.execute(
                        "SELECT document FROM layout_version WHERE page_id=? "
                        "ORDER BY version DESC LIMIT 1",
                        (existing["id"],),
                    ).fetchone()
                    existing_tools = db.execute(
                        "SELECT v.bundle FROM page_tool pt JOIN tool t ON t.id=pt.tool_id "
                        "JOIN tool_version v ON v.tool_id=t.id AND v.version=pt.active_version "
                        "WHERE pt.page_id=? ORDER BY t.name",
                        (existing["id"],),
                    ).fetchall()
                    requested_tools = [
                        canonical_bundle(bundle)
                        for bundle in sorted(bundles, key=lambda item: item["name"])
                    ]
                    if (
                        existing["title"] == title
                        and existing_layout is not None
                        and existing_layout[0] == encoded
                        and [row[0] for row in existing_tools] == requested_tools
                    ):
                        return existing, digest, True
                    raise ValidationError(
                        "/route", "unused route or equivalent request", "conflict"
                    )
                hook = getattr(self, "before_create_commit", None)
                if hook is not None:
                    hook()
                principal = db.execute(
                    "SELECT create_mode FROM page WHERE id=?", (principal_id,)
                ).fetchone()
                if principal is None or not principal[0]:
                    raise PermissionError("forbidden: create mode is off")
                page_id = secrets.token_hex(12)
                workspace = self.root / "pages" / page_id / "workspace"
                workspace.mkdir(mode=0o700, parents=True)
                workspace.chmod(0o700)
                created_paths.add(workspace.parent)
                files = [(self.root / "bundles" / f"{digest}.json", (encoded + "\n").encode())]
                files.extend(
                    (
                        self.root / "bundles" / f"{bundle_digest(bundle)}.json",
                        (canonical_bundle(bundle) + "\n").encode(),
                    )
                    for bundle in bundles
                )
                for path, content in files:
                    existed = path.exists()
                    try:
                        self._atomic_private_write(path, content)
                    finally:
                        if not existed and path.exists():
                            created_paths.add(path)
                token = secrets.token_urlsafe(32)
                credential = self.root / "credentials" / page_id
                try:
                    self._atomic_private_write(credential, token.encode())
                finally:
                    if credential.exists():
                        created_paths.add(credential)
                stamp = now()
                db.execute(
                    "INSERT INTO page(id,route,title,active_layout_version,created_at,"
                    "updated_at,credential_hash,created_by_page_id) VALUES(?,?,?,?,?,?,?,?)",
                    (
                        page_id,
                        route,
                        title,
                        1,
                        stamp,
                        stamp,
                        hashlib.sha256(token.encode()).hexdigest(),
                        principal_id,
                    ),
                )
                db.execute(
                    "INSERT INTO layout_version VALUES(?,?,?,?,?)",
                    (page_id, 1, digest, encoded, stamp),
                )
                db.execute(
                    "INSERT INTO audit(page_id,action,version_digest,created_at) VALUES(?,?,?,?)",
                    (page_id, "create_page", digest, stamp),
                )
                for bundle in bundles:
                    tool_id = secrets.token_hex(12)
                    tool_digest = bundle_digest(bundle)
                    db.execute(
                        "INSERT INTO tool VALUES(?,?,?,?)",
                        (tool_id, page_id, bundle["name"], stamp),
                    )
                    db.execute(
                        "INSERT INTO tool_version VALUES(?,?,?,?,?)",
                        (tool_id, 1, tool_digest, canonical_bundle(bundle), stamp),
                    )
                    db.execute(
                        "INSERT INTO page_tool VALUES(?,?,?,?)", (page_id, tool_id, 1, stamp)
                    )
                    db.execute(
                        "INSERT INTO audit(page_id,action,version_digest,created_at) "
                        "VALUES(?,?,?,?)",
                        (page_id, "create_tool", tool_digest, stamp),
                    )
        except (ValidationError, PermissionError):
            self._cleanup_create_paths(created_paths)
            raise
        except Exception as exc:
            self._cleanup_create_paths(created_paths)
            raise ValidationError("", "atomic page creation", "create_failed") from exc
        row = self.page(page_id or "")
        assert row is not None
        return row, digest, False

    @staticmethod
    def _cleanup_create_paths(paths: set[Path]) -> None:
        for path in sorted(paths, key=lambda item: len(item.parts), reverse=True):
            if path.is_dir():
                shutil.rmtree(path, ignore_errors=True)
            else:
                path.unlink(missing_ok=True)

    def create_tool(
        self, page_id: str, bundle: Any, validation_prefix: str = ""
    ) -> tuple[dict[str, Any], str]:
        bundle = validate_bundle(bundle, validation_prefix, reject_conflicting_output=True)
        encoded = canonical_bundle(bundle)
        digest = bundle_digest(bundle)
        stamp = now()
        try:
            with self.transaction() as db:
                principal = db.execute(
                    "SELECT create_mode FROM page WHERE id=?", (page_id,)
                ).fetchone()
                if principal is None or not principal[0]:
                    raise PermissionError("forbidden: create mode is off")
                tool = db.execute(
                    "SELECT id FROM tool WHERE owner_page_id=? AND name=?",
                    (page_id, bundle["name"]),
                ).fetchone()
                if tool is None:
                    tool_id = secrets.token_hex(12)
                    version = 1
                    db.execute(
                        "INSERT INTO tool VALUES(?,?,?,?)",
                        (tool_id, page_id, bundle["name"], stamp),
                    )
                else:
                    tool_id = tool[0]
                    version = db.execute(
                        "SELECT COALESCE(MAX(version), 0) + 1 FROM tool_version WHERE tool_id=?",
                        (tool_id,),
                    ).fetchone()[0]
                self._atomic_private_write(
                    self.root / "bundles" / f"{digest}.json", (encoded + "\n").encode()
                )
                db.execute(
                    "INSERT INTO tool_version VALUES(?,?,?,?,?)",
                    (tool_id, version, digest, encoded, stamp),
                )
                db.execute(
                    "INSERT INTO page_tool VALUES(?,?,?,?) ON CONFLICT(page_id,tool_id) "
                    "DO UPDATE SET active_version=excluded.active_version, "
                    "assigned_at=excluded.assigned_at",
                    (page_id, tool_id, version, stamp),
                )
                db.execute(
                    "INSERT INTO audit(page_id,action,version_digest,created_at) VALUES(?,?,?,?)",
                    (page_id, "create_tool", digest, stamp),
                )
            return {"tool_id": tool_id, "name": bundle["name"], "version": version}, digest
        except Exception:
            raise

    def page_tools(self, page_id: str) -> list[dict[str, Any]]:
        with self._connect() as db:
            rows = db.execute(
                """SELECT t.name, v.bundle, v.version FROM page_tool pt
                JOIN tool t ON t.id=pt.tool_id JOIN tool_version v ON v.tool_id=t.id
                AND v.version=pt.active_version
                WHERE pt.page_id=? ORDER BY t.name""",
                (page_id,),
            ).fetchall()
        return [{"name": r[0], **validate_bundle(json.loads(r[1])), "version": r[2]} for r in rows]

    def rollback_tool(self, page_id: str, name: str, version: int) -> None:
        with self.transaction() as db:
            row = db.execute(
                """SELECT pt.tool_id FROM page_tool pt JOIN tool t ON t.id=pt.tool_id
                WHERE pt.page_id=? AND t.name=? AND EXISTS (
                  SELECT 1 FROM tool_version v WHERE v.tool_id=pt.tool_id AND v.version=?
                )""",
                (page_id, name, version),
            ).fetchone()
            if row is None:
                raise ValueError("unknown tool version")
            db.execute(
                "UPDATE page_tool SET active_version=? WHERE page_id=? AND tool_id=?",
                (version, page_id, row[0]),
            )

    def tool_bundle(self, page_id: str, name: str) -> dict[str, Any] | None:
        with self._connect() as db:
            row = db.execute(
                """SELECT v.bundle FROM page_tool pt JOIN tool t ON t.id=pt.tool_id
                JOIN tool_version v ON v.tool_id=t.id AND v.version=pt.active_version
                WHERE pt.page_id=? AND t.name=?""",
                (page_id, name),
            ).fetchone()
        return validate_bundle(json.loads(row[0])) if row else None
