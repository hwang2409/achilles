from __future__ import annotations

import hashlib
import json
import os
import re
import secrets
import sqlite3
import tempfile
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from .tools import bundle_digest, canonical_bundle, validate_bundle

BLOCK_KEYS: dict[str, frozenset[str]] = {
    "chat": frozenset({"type"}),
    "timeline": frozenset({"type"}),
    "list": frozenset({"type", "title", "collection"}),
    "detail": frozenset({"type", "title", "fields"}),
    "form": frozenset({"type", "title", "tool"}),
    "text": frozenset({"type", "text"}),
    "metric": frozenset({"type", "label", "value"}),
}

_PAGE_ROUTE = re.compile(r"^/(?:[a-z0-9][a-z0-9-]{0,62})(?:/(?:[a-z0-9][a-z0-9-]{0,62})){0,7}$")
_RESERVED_ROUTES = {"api", "assets", "mcp"}


def validate_page_route(route: str) -> None:
    if not isinstance(route, str) or not _PAGE_ROUTE.fullmatch(route):
        raise ValueError("invalid page route")
    if route.split("/")[1] in _RESERVED_ROUTES:
        raise ValueError("reserved page route")


def _validate_block(block: Any, assigned_tools: set[str]) -> None:
    if not isinstance(block, dict) or not isinstance(block.get("type"), str):
        raise ValueError("each block must have a type")
    kind = block["type"]
    if kind not in BLOCK_KEYS or set(block) != BLOCK_KEYS[kind]:
        raise ValueError(
            f"invalid keys for {kind} block"
            if kind in BLOCK_KEYS
            else f"unknown layout block: {kind}"
        )
    if kind == "form" and (
        not isinstance(block["title"], str) or block["tool"] not in assigned_tools
    ):
        raise ValueError("unknown tool reference")
    if kind == "text" and not isinstance(block["text"], str):
        raise ValueError("text must be a string")
    if kind == "metric" and not all(isinstance(block[x], str) for x in ("label", "value")):
        raise ValueError("metric fields must be strings")
    if kind == "list" and not all(isinstance(block[x], str) for x in ("title", "collection")):
        raise ValueError("list fields must be strings")
    if kind == "detail" and (
        not isinstance(block["title"], str)
        or not isinstance(block["fields"], list)
        or not all(isinstance(x, str) for x in block["fields"])
    ):
        raise ValueError("detail fields must be strings")


def now() -> str:
    return datetime.now(UTC).isoformat()


def validate_layout(layout: Any, assigned_tools: set[str] | None = None) -> dict[str, Any]:
    if (
        not isinstance(layout, dict)
        or set(layout) != {"blocks"}
        or not isinstance(layout["blocks"], list)
    ):
        raise ValueError("layout must contain only a blocks list")
    tools = assigned_tools or set()
    for block in layout["blocks"]:
        _validate_block(block, tools)
    return layout


class PageStore:
    def __init__(self, root: Path):
        self.root = root
        for directory in (root, root / "pages", root / "bundles", root / "credentials"):
            directory.mkdir(mode=0o700, parents=True, exist_ok=True)
            directory.chmod(0o700)
        self._database = root / "achilles.sqlite3"
        self.db = self._connect()
        version = self.db.execute("PRAGMA user_version").fetchone()[0]
        if version not in (0, 1, 2, 3):
            raise RuntimeError(f"unsupported Achilles database version: {version}")
        self.db.executescript("""
        CREATE TABLE IF NOT EXISTS page (
          id TEXT PRIMARY KEY, route TEXT NOT NULL UNIQUE, title TEXT NOT NULL,
          zeta_session_id TEXT, active_layout_version INTEGER,
          created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
          create_mode INTEGER NOT NULL DEFAULT 0, credential_hash TEXT
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
          record_id TEXT NOT NULL, version INTEGER NOT NULL, document TEXT NOT NULL,
          created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
          PRIMARY KEY(page_id, collection, record_id)
        );
        """)
        columns = {row[1] for row in self.db.execute("PRAGMA table_info(page)")}
        if "create_mode" not in columns:
            self.db.execute("ALTER TABLE page ADD COLUMN create_mode INTEGER NOT NULL DEFAULT 0")
        if "credential_hash" not in columns:
            self.db.execute("ALTER TABLE page ADD COLUMN credential_hash TEXT")
        stamp = now()
        self.db.execute(
            "INSERT OR IGNORE INTO page(id,route,title,created_at,updated_at) VALUES ('home','/','home',?,?)",  # noqa: E501
            (stamp, stamp),
        )
        self.db.execute("PRAGMA user_version = 3")
        self.db.commit()
        self._chmod_db()
        self.ensure_credential("home")
        workspace = self.root / "pages" / "home" / "workspace"
        workspace.mkdir(mode=0o700, parents=True, exist_ok=True)
        workspace.chmod(0o700)

    def _write_bundle(self, digest: str, encoded: str) -> None:
        path = self.root / "bundles" / f"{digest}.json"
        if path.exists():
            return
        temporary = path.with_suffix(".tmp")
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        try:
            os.write(fd, (encoded + "\n").encode())
        finally:
            os.close(fd)
        os.replace(temporary, path)
        path.chmod(0o600)

    def _connect(self):
        connection = sqlite3.connect(self._database, timeout=5)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys=ON")
        connection.execute("PRAGMA busy_timeout=5000")
        return connection

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
        with self._connect() as db:
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
            db.commit()
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

    def set_create_mode(self, page_id: str, enabled: bool) -> sqlite3.Row:
        with self._connect() as db:
            db.execute(
                "UPDATE page SET create_mode=?, updated_at=? WHERE id=?",
                (int(enabled), now(), page_id),
            )
            db.commit()
        row = self.page(page_id)
        if row is None:
            raise KeyError(page_id)
        return row

    def save_session(
        self, page_id: str, expected: str | None, session_id: str
    ) -> tuple[bool, str | None]:
        with self._connect() as db:
            row = db.execute("SELECT zeta_session_id FROM page WHERE id=?", (page_id,)).fetchone()
            if row is None:
                raise KeyError(page_id)
            if row[0] != expected:
                return False, row[0]
            db.execute(
                "UPDATE page SET zeta_session_id=?,updated_at=? WHERE id=? AND zeta_session_id IS ?",  # noqa: E501
                (session_id, now(), page_id, expected),
            )
            db.commit()
            return True, session_id

    def create_page(
        self, route: str, title: str, layout: Any, principal_id: str = "home"
    ) -> tuple[sqlite3.Row, str]:
        validate_page_route(route)
        if not title:
            raise ValueError("invalid page title")
        encoded = json.dumps(validate_layout(layout, set()), sort_keys=True, separators=(",", ":"))
        digest = hashlib.sha256(encoded.encode()).hexdigest()
        with self._connect() as db:
            principal = db.execute(
                "SELECT create_mode FROM page WHERE id=?", (principal_id,)
            ).fetchone()
            if principal is None or not principal[0]:
                raise PermissionError("forbidden: create mode is off")
            hook = getattr(self, "before_create_commit", None)
            if hook is not None:
                hook()
            db.execute("BEGIN IMMEDIATE")
            principal = db.execute(
                "SELECT create_mode FROM page WHERE id=?", (principal_id,)
            ).fetchone()
            if principal is None or not principal[0]:
                raise PermissionError("forbidden: create mode is off")
            path = self.root / "bundles" / f"{digest}.json"
            if not path.exists():
                self._atomic_private_write(path, (encoded + "\n").encode())
            page_id = secrets.token_hex(12)
            workspace = self.root / "pages" / page_id / "workspace"
            workspace.mkdir(mode=0o700, parents=True)
            workspace.chmod(0o700)
            token = secrets.token_urlsafe(32)
            self._atomic_private_write(self.root / "credentials" / page_id, token.encode())
            stamp = now()
            db.execute(
                "INSERT INTO page(id,route,title,active_layout_version,created_at,"
                "updated_at,credential_hash) VALUES(?,?,?,?,?,?,?)",
                (
                    page_id,
                    route,
                    title,
                    1,
                    stamp,
                    stamp,
                    hashlib.sha256(token.encode()).hexdigest(),
                ),
            )
            db.execute(
                "INSERT INTO layout_version VALUES(?,?,?,?,?)", (page_id, 1, digest, encoded, stamp)
            )
            db.execute(
                "INSERT INTO audit(page_id,action,version_digest,created_at) VALUES(?,?,?,?)",
                (page_id, "create_page", digest, stamp),
            )
            db.commit()
        row = self.page(page_id)
        assert row is not None
        return row, digest

    def create_tool(self, page_id: str, bundle: Any) -> tuple[dict[str, Any], str]:
        bundle = validate_bundle(bundle)
        encoded = canonical_bundle(bundle)
        digest = bundle_digest(bundle)
        stamp = now()
        try:
            with self._connect() as db:
                db.execute("BEGIN IMMEDIATE")
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
                self._write_bundle(digest, encoded)
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
        return [{"name": r[0], **json.loads(r[1]), "version": r[2]} for r in rows]

    def rollback_tool(self, page_id: str, name: str, version: int) -> None:
        with self._connect() as db:
            db.execute("BEGIN IMMEDIATE")
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
        return json.loads(row[0]) if row else None
