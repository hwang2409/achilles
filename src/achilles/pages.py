from __future__ import annotations

import hashlib
import json
import secrets
import sqlite3
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

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
        (root / "pages").mkdir(mode=0o700, exist_ok=True)
        (root / "bundles").mkdir(mode=0o700, exist_ok=True)
        (root / "credentials").mkdir(mode=0o700, exist_ok=True)
        self.db = sqlite3.connect(root / "achilles.sqlite3", check_same_thread=False)
        self.db.row_factory = sqlite3.Row
        self.db.execute("PRAGMA foreign_keys=ON")
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute("PRAGMA busy_timeout=5000")
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
        self.db.commit()
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
        (self.root / "bundles" / f"{digest}.json").write_text(encoded + "\n")
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
