from __future__ import annotations

import hashlib
import json
import secrets
import sqlite3
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


def now() -> str:
    return datetime.now(UTC).isoformat()


def validate_layout(layout: Any) -> dict[str, Any]:
    if (
        not isinstance(layout, dict)
        or set(layout) != {"blocks"}
        or not isinstance(layout["blocks"], list)
    ):
        raise ValueError("layout must contain only a blocks list")
    for block in layout["blocks"]:
        if not isinstance(block, dict) or not isinstance(block.get("type"), str):
            raise ValueError("each block must have a type")
        kind = block["type"]
        if kind not in BLOCK_KEYS:
            raise ValueError(f"unknown layout block: {kind}")
        if set(block) != BLOCK_KEYS[kind]:
            raise ValueError(f"invalid keys for {kind} block")
        if kind == "form":
            raise ValueError("unknown tool reference")
        if kind == "list" and not isinstance(block.get("collection"), str):
            raise ValueError("list reference must be a string")
        if kind == "detail" and (
            not isinstance(block["fields"], list)
            or not all(isinstance(field, str) for field in block["fields"])
        ):
            raise ValueError("detail fields must be strings")
    return layout


class PageStore:
    def __init__(self, root: Path):
        self.root = root
        self.root.mkdir(mode=0o700, parents=True, exist_ok=True)
        self.root.chmod(0o700)
        for directory in (root / "pages", root / "bundles", root / "credentials"):
            directory.mkdir(mode=0o700, exist_ok=True)
            directory.chmod(0o700)
        database = root / "achilles.sqlite3"
        self.db = sqlite3.connect(database, check_same_thread=False)
        database.chmod(0o600)
        self.db.row_factory = sqlite3.Row
        self.db.execute("PRAGMA foreign_keys=ON")
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute("PRAGMA busy_timeout=5000")
        for sidecar in (root / "achilles.sqlite3-wal", root / "achilles.sqlite3-shm"):
            if sidecar.exists():
                sidecar.chmod(0o600)
        self.db.executescript(
            """
            CREATE TABLE IF NOT EXISTS page (
              id TEXT PRIMARY KEY, route TEXT NOT NULL UNIQUE, title TEXT NOT NULL,
              zeta_session_id TEXT, active_layout_version INTEGER, created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL, create_mode INTEGER NOT NULL DEFAULT 0,
              credential_hash TEXT
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
              name TEXT NOT NULL, created_at TEXT NOT NULL,
              UNIQUE(owner_page_id, name)
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
            """
        )
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
        self.db.execute("PRAGMA user_version = 2")
        self.db.commit()
        for private_path in (
            root / "achilles.sqlite3",
            root / "achilles.sqlite3-wal",
            root / "achilles.sqlite3-shm",
        ):
            if private_path.exists():
                private_path.chmod(0o600)
        self.ensure_credential("home")

    def ensure_credential(self, page_id: str) -> str:
        row = self.db.execute("SELECT credential_hash FROM page WHERE id=?", (page_id,)).fetchone()
        if row is None:
            raise KeyError(page_id)
        path = self.root / "credentials" / page_id
        if row["credential_hash"] and path.exists():
            return path.read_text().strip()
        token = secrets.token_urlsafe(32)
        digest = hashlib.sha256(token.encode()).hexdigest()
        self.db.execute("UPDATE page SET credential_hash=? WHERE id=?", (digest, page_id))
        self.db.commit()
        path.write_text(token)
        path.chmod(0o600)
        return token

    def authenticate(self, token: str) -> sqlite3.Row | None:
        digest = hashlib.sha256(token.encode()).hexdigest()
        return self.db.execute("SELECT * FROM page WHERE credential_hash=?", (digest,)).fetchone()

    def page(self, key: str) -> sqlite3.Row | None:
        return self.db.execute("SELECT * FROM page WHERE id=? OR route=?", (key, key)).fetchone()

    def set_create_mode(self, page_id: str, enabled: bool) -> sqlite3.Row:
        self.db.execute(
            "UPDATE page SET create_mode=?, updated_at=? WHERE id=?", (enabled, now(), page_id)
        )
        self.db.commit()
        row = self.page(page_id)
        if row is None:
            raise KeyError(page_id)
        return row

    def create_page(self, route: str, title: str, layout: Any) -> tuple[sqlite3.Row, str]:
        if not route.startswith("/") or route == "/" or not title:
            raise ValueError("invalid page route or title")
        document = validate_layout(layout)
        encoded = json.dumps(document, sort_keys=True, separators=(",", ":"))
        digest = hashlib.sha256(encoded.encode()).hexdigest()
        bundle_path = self.root / "bundles" / f"{digest}.json"
        bundle_path.write_text(encoded + "\n")
        bundle_path.chmod(0o600)
        page_id = secrets.token_hex(12)
        stamp = now()
        try:
            self.db.execute("BEGIN")
            self.db.execute(
                "INSERT INTO page(id,route,title,zeta_session_id,active_layout_version,created_at,updated_at) VALUES(?,?,?,?,?,?,?)",  # noqa: E501
                (page_id, route, title, secrets.token_hex(16), 1, stamp, stamp),
            )
            self.db.execute(
                "INSERT INTO layout_version VALUES(?,?,?,?,?)", (page_id, 1, digest, encoded, stamp)
            )
            self.db.execute(
                "INSERT INTO audit(page_id,action,version_digest,created_at) VALUES(?,?,?,?)",
                (page_id, "create_page", digest, stamp),
            )
            self.db.commit()
        except Exception:
            self.db.rollback()
            raise
        self.ensure_credential(page_id)
        row = self.page(page_id)
        assert row is not None
        return row, digest

    def create_tool(self, page_id: str, bundle: Any) -> tuple[dict[str, Any], str]:
        bundle = validate_bundle(bundle)
        encoded = canonical_bundle(bundle)
        digest = bundle_digest(bundle)
        bundle_path = self.root / "bundles" / f"{digest}.json"
        encoded_file = (encoded + "\n").encode()
        if bundle_path.exists() and bundle_path.read_bytes() != encoded_file:
            raise ValueError("bundle digest already exists with different content")
        if not bundle_path.exists():
            bundle_path.write_bytes(encoded_file)
            bundle_path.chmod(0o600)
        stamp = now()
        try:
            self.db.execute("BEGIN")
            page = self.db.execute("SELECT id FROM page WHERE id=?", (page_id,)).fetchone()
            if page is None:
                raise ValueError("page not found")
            tool = self.db.execute(
                "SELECT id FROM tool WHERE owner_page_id=? AND name=?", (page_id, bundle["name"])
            ).fetchone()
            if tool is None:
                tool_id = secrets.token_hex(12)
                version = 1
                self.db.execute(
                    "INSERT INTO tool(id,owner_page_id,name,created_at) VALUES(?,?,?,?)",
                    (tool_id, page_id, bundle["name"], stamp),
                )
            else:
                tool_id = tool["id"]
                version = self.db.execute(
                    "SELECT COALESCE(MAX(version), 0) + 1 FROM tool_version WHERE tool_id=?",
                    (tool_id,),
                ).fetchone()[0]
            self.db.execute(
                "INSERT INTO tool_version VALUES(?,?,?,?,?)",
                (tool_id, version, digest, encoded, stamp),
            )
            self.db.execute(
                "INSERT INTO page_tool VALUES(?,?,?,?) ON CONFLICT(page_id, tool_id) "
                "DO UPDATE SET active_version=excluded.active_version, "
                "assigned_at=excluded.assigned_at",
                (page_id, tool_id, version, stamp),
            )
            self.db.execute(
                "INSERT INTO audit(page_id,action,version_digest,created_at) VALUES(?,?,?,?)",
                (page_id, "create_tool", digest, stamp),
            )
            self.db.commit()
        except Exception:
            self.db.rollback()
            raise
        return {"id": tool_id, "name": bundle["name"], "version": version}, digest

    def rollback_tool(self, page_id: str, tool_name: str, version: int) -> None:
        result = self.db.execute(
            """UPDATE page_tool SET active_version=? WHERE page_id=? AND tool_id=(
               SELECT id FROM tool WHERE owner_page_id=? AND name=?)
            AND EXISTS (SELECT 1 FROM tool_version WHERE tool_id=page_tool.tool_id """
            "AND version=?)"
            "",
            (version, page_id, page_id, tool_name, version),
        )
        if result.rowcount == 0:
            self.db.rollback()
            raise ValueError("tool version not found")
        self.db.commit()

    def records(self, page_id: str, collection: str) -> list[dict[str, Any]]:
        rows = self.db.execute(
            "SELECT record_id, document FROM page_record "
            "WHERE page_id=? AND collection=? ORDER BY created_at",
            (page_id, collection),
        ).fetchall()
        return [{"record_id": row["record_id"], **json.loads(row["document"])} for row in rows]

    def page_tools(self, page_id: str) -> list[dict[str, Any]]:
        rows = self.db.execute(
            "SELECT t.name,v.bundle FROM tool t JOIN page_tool pt ON pt.tool_id=t.id "
            "JOIN tool_version v ON v.tool_id=t.id AND v.version=pt.active_version "
            "WHERE pt.page_id=?",
            (page_id,),
        ).fetchall()
        return [json.loads(row["bundle"]) for row in rows]
