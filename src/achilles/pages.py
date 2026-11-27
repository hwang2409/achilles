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

from .page_build import PageBuildError, build_page, effective_dependencies
from .tools import TOOL_BUNDLE_SCHEMA, bundle_digest, canonical_bundle, validate_bundle
from .validation import ValidationError, validate_schema

_COLLECTION_KEY_PATTERN = TOOL_BUNDLE_SCHEMA["properties"]["implementation"]["properties"][
    "collection"
]["pattern"]

_EQUALITY_FILTER_SCHEMA = {
    "type": "object",
    "properties": {
        "field": {"type": "string", "pattern": _COLLECTION_KEY_PATTERN},
        "equals": {
            "type": ["string", "number", "boolean", "null"],
            "description": "Exact JSON scalar match. Null also matches a missing field.",
        },
    },
    "required": ["field", "equals"],
    "additionalProperties": False,
}

PAGE_PACKAGE_SCHEMA = {
    "type": "object",
    "properties": {
        "source": {"type": "string", "minLength": 1},
        "dependencies": {"type": "object", "additionalProperties": {"type": "string"}},
    },
    "required": ["source", "dependencies"],
    "additionalProperties": False,
}
_VERSION_NUMBER = {"type": "integer", "minimum": 1}
RESTORE_VERSION_SCHEMA = {
    "type": "object",
    "properties": {
        "kind": {"enum": ["code", "tool"]},
        "name": {"type": "string", "description": "The tool name; required when kind is tool."},
        "version": _VERSION_NUMBER,
        "expected_version": _VERSION_NUMBER,
        "route": {"type": "string", "description": "Optional; must be this page's route."},
    },
    "required": ["kind", "version", "expected_version"],
    "additionalProperties": False,
}
_RESTORE_ARGS_SCHEMA = {
    "type": "object",
    "properties": {"version": _VERSION_NUMBER, "expected_version": _VERSION_NUMBER},
    "required": ["version", "expected_version"],
}
STALE_BUILD = "build started at revision"
INSPECT_MAX_BYTES = 8 * 1024
DETAIL_SUGGESTION_RECORD_LIMIT = 200

_RESERVED_PAGE_ROUTE_SEGMENTS = (
    "chats",
    "pages",
    "agents",
    "sessions",
    "projects",
    "telemetry",
    "skills",
    "agent-profiles",
    "settings",
    "accounts",
    "mcp",
    "connections",
    "create",
    "api",
    "assets",
)

CREATE_PAGE_SCHEMA = {
    "type": "object",
    "properties": {
        "route": {
            "type": "string",
            "pattern": (
                rf"^/(?!(?:{'|'.join(_RESERVED_PAGE_ROUTE_SEGMENTS)})(?:/|$))"
                r"(?:[a-z0-9][a-z0-9-]{0,62})"
                r"(?:/(?:[a-z0-9][a-z0-9-]{0,62})){0,7}$"
            ),
        },
        "title": {"type": "string", "minLength": 1},
        "package": PAGE_PACKAGE_SCHEMA,
        "tools": {"type": "array", "items": TOOL_BUNDLE_SCHEMA},
    },
    "required": ["route", "title"],
    "additionalProperties": False,
}

_MINIMAL_PAGE_SOURCE = """import { createRoot } from "react-dom/client";
function Page() { return <main />; }
createRoot(document.getElementById("root")!).render(<Page />);
"""


def bounded_inspect(value: dict[str, Any]) -> tuple[dict[str, Any], str]:
    result = json.loads(json.dumps(value))
    encoded = json.dumps(result, sort_keys=True, separators=(",", ":"))
    if len(encoded.encode()) <= INSPECT_MAX_BYTES:
        return result, encoded
    code = result.get("code")
    if isinstance(code, dict):
        code.pop("source", None)
        code.pop("lockfile", None)
        code.pop("revisions", None)
    result["truncated"] = True
    encoded = json.dumps(result, sort_keys=True, separators=(",", ":"))
    if len(encoded.encode()) > INSPECT_MAX_BYTES:
        raise ValidationError("", f"inspectable page <= {INSPECT_MAX_BYTES} bytes", "too_large")
    return result, encoded


def validate_page_route(route: str) -> None:
    validate_schema(route, CREATE_PAGE_SCHEMA["properties"]["route"], "/route")


def edits_own_page(page: sqlite3.Row) -> bool:
    """A page's own chat may rewrite and restore that page's code; the home chat needs create
    mode for that, and creating pages or tools always needs it."""
    return page["id"] != "home" or bool(page["create_mode"])


def now() -> str:
    return datetime.now(UTC).isoformat()


CHAT_PURPOSES = ("chat", "page_build")


def chat_row(row) -> dict[str, Any]:
    return {
        **dict(row),
        "titled_by_user": bool(row["titled_by_user"]),
        "message_sent": bool(row["message_sent"]),
    }


def ensure_column(conn, table: str, column: str, ddl: str, backfill: str | None = None) -> None:
    conn.execute("BEGIN IMMEDIATE")
    try:
        columns = {row[1] for row in conn.execute(f"PRAGMA table_info({table})")}
        if column not in columns:
            conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {ddl}")
            if backfill is not None:
                conn.execute(backfill)
        conn.commit()
    except BaseException:
        conn.rollback()
        raise


def unknown_field_hint(
    source: str, field: str, fields: set[str], suggestion: str | None = None
) -> str:
    listed = ", ".join(sorted(fields)) or "(none)"
    hint = f"Use a field from {source}. Unknown field: {field}. Fields: {listed}."
    if suggestion is not None:
        hint += f" Did you mean {suggestion}?"
    return hint


def _collection_fields(bundles: list[dict[str, Any]]) -> dict[str, set[str]]:
    fields: dict[str, set[str]] = {}
    for bundle in bundles:
        implementation = bundle["implementation"]
        fields.setdefault(implementation["collection"], set()).update(
            implementation["data_schema"].get("properties", {})
        )
    return fields


def _missing_update_note(bundles: list[dict[str, Any]]) -> str | None:
    operations: dict[str, set[str]] = {}
    for bundle in bundles:
        implementation = bundle["implementation"]
        operations.setdefault(implementation["collection"], set()).add(implementation["operation"])
    missing = sorted(
        collection
        for collection, collection_operations in operations.items()
        if "insert" in collection_operations and "update" not in collection_operations
    )
    if not missing:
        return None
    return " ".join(
        f"collection {collection} has no update tool; rows cannot be changed after insert"
        for collection in missing
    )


def _json_scalar_match(
    field: str, value: str | int | float | bool | None
) -> tuple[str, tuple[Any, ...]]:
    path = f'$."{field}"'
    if value is None:
        value_type = "null"
    elif isinstance(value, bool):
        value_type = "boolean"
    elif isinstance(value, (int, float)):
        value_type = "number"
    else:
        value_type = "text"
    return (
        "json_extract(document, ?) IS json_extract(?, '$') "
        "AND CASE COALESCE(json_type(document, ?), 'null') "
        "WHEN 'true' THEN 'boolean' WHEN 'false' THEN 'boolean' "
        "WHEN 'integer' THEN 'number' WHEN 'real' THEN 'number' "
        "ELSE COALESCE(json_type(document, ?), 'null') END = ?",
        (path, json.dumps(value), path, path, value_type),
    )


def validate_record_filter(value: Any) -> dict[str, Any]:
    validate_schema(value, _EQUALITY_FILTER_SCHEMA)
    return value


def _same_json_scalar(left: Any, right: Any) -> bool:
    if isinstance(left, bool) or isinstance(right, bool):
        return isinstance(left, bool) and isinstance(right, bool) and left == right
    if isinstance(left, (int, float)) and isinstance(right, (int, float)):
        return left == right
    return type(left) is type(right) and left == right


def _suggest_filter_field(
    db: sqlite3.Connection,
    page_id: str,
    collection: str,
    field: str,
    expected: Any,
    collection_fields: set[str],
) -> str | None:
    # shortcut: suggestions inspect the newest 200 records, raise the cap only with evidence.
    rows = db.execute(
        "SELECT document FROM page_record WHERE page_id=? AND collection=? "
        "ORDER BY created_at DESC, rowid DESC LIMIT ?",
        (page_id, collection, DETAIL_SUGGESTION_RECORD_LIMIT),
    ).fetchall()
    documents = [json.loads(row[0]) for row in rows]
    candidate_fields = set(collection_fields)
    for document in documents:
        candidate_fields.update(document)
    return next(
        (
            candidate
            for candidate in sorted(candidate_fields - {field})
            if any(
                candidate in document and _same_json_scalar(document[candidate], expected)
                for document in documents
            )
        ),
        None,
    )


class _RouteTaken(Exception):
    """A concurrent create_page committed the same route first."""


def _drop_block_model(db: sqlite3.Connection, database: Path) -> None:
    """Migrate v1-v3 to v4: back up the database once, then drop the block layout model."""
    backup = Path(str(database) + ".pre-block-model-v3.backup")
    if not backup.exists():
        # a unique name per process, so two first opens cannot collide on one temporary file
        fd, temporary = tempfile.mkstemp(
            prefix=f".{backup.name}.", suffix=".tmp", dir=backup.parent
        )
        os.close(fd)
        created = False
        try:
            destination = sqlite3.connect(temporary)
            try:
                db.backup(destination)
            finally:
                destination.close()
            # link, never replace: a racing first open may already have migrated, and its
            # copy would overwrite the real v3 backup with a v4 one
            os.link(temporary, backup)
            created = True
        except FileExistsError:
            pass
        finally:
            Path(temporary).unlink(missing_ok=True)
        if created:
            directory = os.open(backup.parent, os.O_RDONLY)
            try:
                os.fsync(directory)
            finally:
                os.close(directory)
            print(f"Achilles database backup: {backup}")
    db.execute("BEGIN IMMEDIATE")
    if db.execute("PRAGMA user_version").fetchone()[0] != 4:
        if "active_layout_version" in {row[1] for row in db.execute("PRAGMA table_info(page)")}:
            db.execute("ALTER TABLE page DROP COLUMN active_layout_version")
        db.execute("DROP TABLE IF EXISTS layout_version")
        db.execute("PRAGMA user_version = 4")
    db.commit()


class PageStore:
    def __init__(self, root: Path):
        self.root = root
        for directory in (root, root / "pages", root / "bundles", root / "credentials"):
            directory.mkdir(mode=0o700, parents=True, exist_ok=True)
            directory.chmod(0o700)
        self._database = root / "achilles.sqlite3"
        db = self._connect()
        version = db.execute("PRAGMA user_version").fetchone()[0]
        if version not in (0, 1, 2, 3, 4):
            raise RuntimeError(f"unsupported Achilles database version: {version}")
        if version in (1, 2, 3):
            _drop_block_model(db, self._database)
        db.executescript("""
        CREATE TABLE IF NOT EXISTS page (
          id TEXT PRIMARY KEY, route TEXT NOT NULL UNIQUE, title TEXT NOT NULL,
          zeta_session_id TEXT, active_code_revision INTEGER,
          created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
          create_mode INTEGER NOT NULL DEFAULT 0, credential_hash TEXT,
          created_by_page_id TEXT REFERENCES page(id)
        );
        CREATE TABLE IF NOT EXISTS code_revision (
          page_id TEXT NOT NULL REFERENCES page(id), version INTEGER NOT NULL,
          source TEXT NOT NULL, dependencies TEXT NOT NULL,
          resolved_dependencies TEXT NOT NULL DEFAULT '{}', lockfile TEXT NOT NULL DEFAULT '',
          digest TEXT, artifact_size INTEGER, diagnostics TEXT, runtime_error TEXT,
          created_at TEXT NOT NULL,
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
        CREATE INDEX IF NOT EXISTS audit_page_digest ON audit(page_id, version_digest);
        """)
        columns = {row[1] for row in db.execute("PRAGMA table_info(page)")}
        if "create_mode" not in columns:
            db.execute("ALTER TABLE page ADD COLUMN create_mode INTEGER NOT NULL DEFAULT 0")
        if "credential_hash" not in columns:
            db.execute("ALTER TABLE page ADD COLUMN credential_hash TEXT")
        ensure_column(db, "page", "created_by_page_id", "TEXT REFERENCES page(id)")
        ensure_column(db, "page", "active_code_revision", "INTEGER")
        ensure_column(db, "code_revision", "resolved_dependencies", "TEXT NOT NULL DEFAULT '{}'")
        ensure_column(db, "code_revision", "lockfile", "TEXT NOT NULL DEFAULT ''")
        ensure_column(db, "page_record", "revision", "INTEGER NOT NULL DEFAULT 1")
        ensure_column(db, "chat", "purpose", "TEXT NOT NULL DEFAULT 'chat'")
        ensure_column(db, "chat", "titled_by_user", "INTEGER NOT NULL DEFAULT 0")
        ensure_column(db, "chat", "message_sent", "INTEGER NOT NULL DEFAULT 1")
        ensure_column(
            db,
            "chat",
            "first_title",
            "TEXT",
            "UPDATE chat SET first_title=title WHERE NOT titled_by_user",
        )
        ensure_column(db, "audit", "actor", "TEXT")
        ensure_column(db, "audit", "record_id", "TEXT")
        stamp = now()
        db.execute(
            "INSERT OR IGNORE INTO page(id,route,title,created_at,updated_at) VALUES ('home','/','home',?,?)",  # noqa: E501
            (stamp, stamp),
        )
        db.execute(
            "INSERT OR IGNORE INTO chat(session_id,page_id,created_at,updated_at) SELECT zeta_session_id,id,created_at,updated_at FROM page WHERE zeta_session_id IS NOT NULL"  # noqa: E501
        )
        db.execute("PRAGMA user_version = 4")
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

    @staticmethod
    def _page_tools(db: sqlite3.Connection, page_id: str) -> list[dict[str, Any]]:
        rows = db.execute(
            """SELECT t.name, v.bundle, v.version FROM page_tool pt
            JOIN tool t ON t.id=pt.tool_id JOIN tool_version v ON v.tool_id=t.id
            AND v.version=pt.active_version
            WHERE pt.page_id=? ORDER BY t.name""",
            (page_id,),
        ).fetchall()
        return [
            {"name": row[0], **validate_bundle(json.loads(row[1])), "version": row[2]}
            for row in rows
        ]

    def _inspect_page(self, db: sqlite3.Connection, page_id: str) -> dict[str, Any]:
        page = db.execute("SELECT * FROM page WHERE id=?", (page_id,)).fetchone()
        if page is None:
            raise KeyError(page_id)
        counts = db.execute(
            "SELECT collection, COUNT(*) FROM page_record WHERE page_id=? GROUP BY collection",
            (page_id,),
        ).fetchall()
        tools = self._page_tools(db, page_id)
        active = (
            db.execute(
                "SELECT * FROM code_revision WHERE page_id=? AND version=?",
                (page_id, page["active_code_revision"]),
            ).fetchone()
            if page["active_code_revision"] is not None
            else None
        )
        revisions = db.execute(
            "SELECT version,created_at,digest,diagnostics,runtime_error FROM code_revision "
            "WHERE page_id=? ORDER BY version DESC LIMIT 100",
            (page_id,),
        ).fetchall()
        code = (
            None
            if active is None
            else {
                "revision": active["version"],
                "source": active["source"],
                "dependencies": json.loads(active["dependencies"]),
                "resolved_dependencies": json.loads(active["resolved_dependencies"]),
                "lockfile": active["lockfile"],
                "digest": active["digest"],
                "runtime_error": active["runtime_error"],
                "revisions": [
                    {
                        "version": row[0],
                        "created_at": row[1],
                        "digest": row[2],
                        "failed": row[3] is not None and not row[3].startswith(STALE_BUILD),
                        "stale": row[3] is not None and row[3].startswith(STALE_BUILD),
                        "runtime_error": row[4],
                    }
                    for row in revisions
                ],
            }
        )
        return {
            "route": page["route"],
            "title": page["title"],
            "create_mode": bool(page["create_mode"]),
            "code": code,
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

    def inspect_page(self, page_id: str) -> dict[str, Any]:
        with self._connect() as db:
            return self._inspect_page(db, page_id)

    def versions(self, page_id: str) -> dict[str, Any]:
        """The page's code and tool versions, newest first, for the user's history list."""
        with self._connect() as db:
            tools = db.execute(
                "SELECT t.name, v.version, v.created_at, v.version=pt.active_version, "
                "CASE WHEN EXISTS(SELECT 1 FROM audit a WHERE a.action='restore_tool' "
                "AND a.version_digest=v.digest AND a.created_at=v.created_at) "
                "THEN (SELECT MAX(o.version) FROM tool_version o WHERE o.tool_id=v.tool_id "
                "AND o.digest=v.digest AND o.version<v.version) END "
                "FROM page_tool pt JOIN tool t ON t.id=pt.tool_id "
                "JOIN tool_version v ON v.tool_id=t.id WHERE pt.page_id=? "
                "AND (v.version=pt.active_version OR v.version > "
                "(SELECT MAX(version) FROM tool_version WHERE tool_id=t.id) - 100) "
                "ORDER BY t.name, v.version DESC",
                (page_id,),
            ).fetchall()
            code = db.execute(
                "SELECT c.version,c.created_at,c.version=p.active_code_revision,c.diagnostics,"
                "CASE WHEN EXISTS(SELECT 1 FROM audit a WHERE a.action='restore_code' "
                "AND a.version_digest=c.digest AND a.created_at=c.created_at) "
                "THEN (SELECT MAX(o.version) FROM code_revision o WHERE o.page_id=c.page_id "
                "AND o.digest=c.digest AND o.version<c.version) END "
                "FROM code_revision c JOIN page p ON p.id=c.page_id WHERE c.page_id=? "
                "ORDER BY c.version DESC LIMIT 100",
                (page_id,),
            ).fetchall()
        return {
            "code": [
                {
                    "version": r[0],
                    "created_at": r[1],
                    "active": bool(r[2]),
                    "failed": r[3] is not None and not r[3].startswith(STALE_BUILD),
                    "stale": r[3] is not None and r[3].startswith(STALE_BUILD),
                    "restored_from": r[4],
                }
                for r in code
            ],
            "tools": [
                {
                    "name": r[0],
                    "version": r[1],
                    "created_at": r[2],
                    "active": bool(r[3]),
                    "restored_from": r[4],
                }
                for r in tools
            ],
        }

    def insert_record(
        self, page_id: str, collection: str, document: dict[str, Any]
    ) -> dict[str, Any]:
        record_id = str(document.get("record_id") or secrets.token_hex(12))
        stamp = now()
        with self.transaction() as db:
            db.execute(
                (
                    "INSERT INTO page_record(page_id,collection,record_id,version,revision,"
                    "document,created_at,updated_at) "
                    "VALUES(?,?,?,?,?,?,?,?)"
                ),
                (
                    page_id,
                    collection,
                    record_id,
                    1,
                    1,
                    json.dumps(document, sort_keys=True),
                    stamp,
                    stamp,
                ),
            )
            db.execute(
                "INSERT INTO audit(page_id,action,created_at,actor,record_id) VALUES(?,?,?,?,?)",
                (page_id, "insert_record", stamp, "page", record_id),
            )
        return {**document, "record_id": record_id, "revision": 1}

    def update_record(
        self, page_id: str, collection: str, record_id: str, fields: dict[str, Any]
    ) -> dict[str, Any] | None:
        """Merge fields into one of this page's records; None when it has no such record."""
        fields = {k: v for k, v in fields.items() if k not in {"record_id", "revision"}}
        with self.transaction() as db:
            found = db.execute(
                "SELECT document, revision FROM page_record "
                "WHERE page_id=? AND collection=? AND record_id=?",
                (page_id, collection, record_id),
            ).fetchone()
            if found is None:
                return None
            document = {**json.loads(found[0]), **fields}
            stamp = now()
            db.execute(
                "UPDATE page_record SET revision=revision+1, document=?, updated_at=? "
                "WHERE page_id=? AND collection=? AND record_id=?",
                (json.dumps(document, sort_keys=True), stamp, page_id, collection, record_id),
            )
            db.execute(
                "INSERT INTO audit(page_id,action,created_at,actor,record_id) VALUES(?,?,?,?,?)",
                (page_id, "update_record", stamp, "page", record_id),
            )
        return {**document, "record_id": record_id, "revision": found[1] + 1}

    def delete_record(self, page_id: str, collection: str, record_id: str) -> bool:
        with self.transaction() as db:
            deleted = db.execute(
                "DELETE FROM page_record WHERE page_id=? AND collection=? AND record_id=?",
                (page_id, collection, record_id),
            ).rowcount
            if deleted:
                db.execute(
                    "INSERT INTO audit(page_id,action,created_at,actor,record_id) "
                    "VALUES(?,?,?,?,?)",
                    (page_id, "delete_record", now(), "page", record_id),
                )
        return bool(deleted)

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

    def matching_records(
        self,
        page_id: str,
        collection: str,
        field_filter: dict[str, Any],
        limit: int,
    ) -> tuple[list[dict[str, Any]], int]:
        field_filter = validate_record_filter(field_filter)
        predicate, parameters = _json_scalar_match(field_filter["field"], field_filter["equals"])
        with self._connect() as db:
            base = "FROM page_record WHERE page_id=? AND collection=? AND " + predicate
            query_parameters = (page_id, collection, *parameters)
            total = db.execute("SELECT COUNT(*) " + base, query_parameters).fetchone()[0]
            rows = db.execute(
                "SELECT record_id, document, revision "
                + base
                + " ORDER BY created_at DESC, record_id DESC LIMIT ?",
                (*query_parameters, limit),
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
            # stable order (home, then newest created): a setting toggle never moves navigation
            where = ""
            parameters: list[Any] = []
            if before is not None:
                created_at, page_id = before
                where = "WHERE p.id<>'home'"
                if page_id != "home":
                    where += " AND (p.created_at < ? OR (p.created_at = ? AND p.id < ?))"
                    parameters.extend((created_at, created_at, page_id))
            rows = db.execute(
                "SELECT p.id,p.route,p.title,p.created_at,p.updated_at,p.create_mode,"
                "creator.route AS created_by_route,COUNT(c.session_id) AS chat_count "
                "FROM page p LEFT JOIN page creator ON creator.id=p.created_by_page_id "
                "LEFT JOIN chat c ON c.page_id=p.id "
                f"{where} GROUP BY p.id ORDER BY p.id<>'home',p.created_at DESC,p.id DESC LIMIT ?",
                (*parameters, limit + 1),
            ).fetchall()
        page_rows = rows[:limit]
        next_cursor = None
        if len(rows) > limit:
            next_cursor = (page_rows[-1]["created_at"], page_rows[-1]["id"])
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
        include: str | None = None,
    ) -> list[dict[str, Any]]:
        # a chat with no message sent is listed only when the caller names it (the open chat)
        clauses: list[str] = ["(c.message_sent OR c.session_id IS ?)"]
        parameters: list[Any] = [include]
        with self._connect() as db:
            if before is not None:
                updated_at, session_id = before
                clauses.append("(c.updated_at < ? OR (c.updated_at = ? AND c.session_id < ?))")
                parameters.extend((updated_at, updated_at, session_id))
            if query is not None:
                escaped = query.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
                clauses.append("COALESCE(c.title, c.first_title) LIKE ? ESCAPE '\\' COLLATE NOCASE")
                parameters.append(f"%{escaped}%")
            where = f"WHERE {' AND '.join(clauses)}"
            rows = db.execute(
                "SELECT c.session_id,c.page_id,p.route AS page_route,p.title AS page_title,"
                "c.title,c.first_title,c.created_at,c.updated_at,c.last_state,c.titled_by_user,"
                "c.message_sent,c.purpose FROM chat c "
                f"JOIN page p ON p.id=c.page_id {where} "
                "ORDER BY c.updated_at DESC,c.session_id DESC LIMIT ?",
                (*parameters, limit + 1),
            ).fetchall()
        return [chat_row(row) for row in rows]

    def approval_count(self) -> int:
        with self._connect() as db:
            return int(
                # a page build's state belongs to the web client's build owner, not to last_state
                db.execute(
                    "SELECT COUNT(*) FROM chat "
                    "WHERE last_state='approval' AND purpose<>'page_build'"
                ).fetchone()[0]
            )

    def register_chat(self, page_id: str, session_id: str, purpose: str = "chat") -> dict[str, Any]:
        if purpose not in CHAT_PURPOSES:
            raise ValueError("purpose must be chat or page_build")
        with self.transaction() as db:
            if db.execute("SELECT 1 FROM page WHERE id=?", (page_id,)).fetchone() is None:
                raise KeyError(page_id)
            stamp = now()
            db.execute(
                "INSERT OR IGNORE INTO chat"
                "(session_id,page_id,created_at,updated_at,message_sent,purpose) "
                "VALUES(?,?,?,?,0,?)",
                (session_id, page_id, stamp, stamp, purpose),
            )
            row = db.execute(
                "SELECT page_id,purpose FROM chat WHERE session_id=?", (session_id,)
            ).fetchone()
            if row["page_id"] != page_id:
                raise ValueError("session belongs to another page")
            if row["purpose"] != purpose:
                raise ValueError("session already registered with a different purpose")
        return self.chat(session_id)

    def chat(self, session_id: str) -> dict[str, Any]:
        with self._connect() as db:
            row = db.execute(
                "SELECT session_id,page_id,title,first_title,created_at,updated_at,last_state,"
                "titled_by_user,message_sent,purpose FROM chat WHERE session_id=?",
                (session_id,),
            ).fetchone()
        if row is None:
            raise KeyError(session_id)
        return chat_row(row)

    def update_chat(self, session_id: str, changes: dict[str, Any]) -> dict[str, Any]:
        # a title-only write is an automatic name; it never replaces a title the user chose
        changes = dict(changes)
        sent = "first_message" in changes
        first_title = changes.pop("first_message", None)
        keep_user_title = "title" in changes and "titled_by_user" not in changes
        assignments = [
            "title=CASE WHEN titled_by_user THEN title ELSE ? END"
            if key == "title" and keep_user_title
            else f"{key}=?"
            for key in changes
        ]
        # updated_at is the last message time, so the list order and time follow messages only:
        # renames, automatic titles and re-reported states (an attach) never move a chat
        active = changes.get("last_state") in ("running", "approval", "failed")
        message = "NOT message_sent" if sent else "0"
        if active:
            message += " OR last_state IS NOT ?"
        assignments.append(f"updated_at=CASE WHEN {message} THEN ? ELSE updated_at END")
        if sent:
            # the first send marks the chat sent and keeps the first title; repeats change nothing
            assignments.append("message_sent=1,first_title=COALESCE(first_title,?)")
        elif active:
            # a turn ran, so the chat was sent even when the client never recorded its first message
            assignments.append("message_sent=1")
        with self.transaction() as db:
            updated = db.execute(
                f"UPDATE chat SET {','.join(assignments)} WHERE session_id=?",
                (
                    *changes.values(),
                    *([changes["last_state"]] if active else []),
                    now(),
                    *([first_title] if sent else []),
                    session_id,
                ),
            ).rowcount
            if not updated:
                raise KeyError(session_id)
            if sent:
                # older code reads only `title`, so an unnamed chat also takes the first title there
                db.execute(
                    "UPDATE chat SET title=first_title "
                    "WHERE session_id=? AND title IS NULL AND NOT titled_by_user",
                    (session_id,),
                )
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
                    "INSERT INTO chat(session_id,page_id,created_at,updated_at,message_sent) "
                    "VALUES(?,?,?,?,0) ON CONFLICT(session_id) DO NOTHING",
                    (session_id, page_id, stamp, stamp),
                )
            return updated == 1, row[0]

    def create_page(
        self,
        route: str,
        title: str,
        package: Any = None,
        principal_id: str = "home",
        tools: Any = None,
    ) -> tuple[sqlite3.Row, str, bool, str | None]:
        package = package or {"source": _MINIMAL_PAGE_SOURCE, "dependencies": {}}
        bundles = [] if tools is None else tools
        validate_schema(
            {"route": route, "title": title, "package": package, "tools": bundles},
            CREATE_PAGE_SCHEMA,
        )
        bundles = [
            validate_bundle(bundle, f"/tools/{index}", reject_conflicting_output=True)
            for index, bundle in enumerate(bundles)
        ]
        with self._connect() as db:
            principal = db.execute(
                "SELECT create_mode FROM page WHERE id=?", (principal_id,)
            ).fetchone()
            if principal is None or not principal[0]:
                raise PermissionError("forbidden: create mode is off")
            existing = db.execute("SELECT * FROM page WHERE route=?", (route,)).fetchone()
            if existing is not None:
                active = db.execute(
                    "SELECT source,dependencies,digest FROM code_revision WHERE page_id=? AND version=?",  # noqa: E501
                    (existing["id"], existing["active_code_revision"]),
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
                    and active is not None
                    and active["source"] == package["source"]
                    and json.loads(active["dependencies"])
                    == effective_dependencies(package["dependencies"])
                    and [row[0] for row in existing_tools] == requested_tools
                ):
                    return existing, active["digest"], True, _missing_update_note(bundles)
                raise ValidationError("/route", "unused route or equivalent request", "conflict")
        page_id = secrets.token_hex(12)
        try:
            built = build_page(self.root, page_id, package["source"], package["dependencies"])
        except PageBuildError as exc:
            raise ValidationError(
                "/package/source", "a valid build", exc.code, exc.diagnostics
            ) from exc
        stamp = now()
        token = secrets.token_urlsafe(32)
        created_paths: set[Path] = set()
        try:
            workspace = self.root / "pages" / page_id / "workspace"
            workspace.mkdir(mode=0o700, parents=True)
            workspace.chmod(0o700)
            created_paths.add(workspace.parent)
            credential = self.root / "credentials" / page_id
            created_paths.add(credential)
            self._atomic_private_write(credential, token.encode())
            with self.transaction() as db:
                principal = db.execute(
                    "SELECT create_mode FROM page WHERE id=?", (principal_id,)
                ).fetchone()
                if principal is None or not principal[0]:
                    raise PermissionError("forbidden: create mode is off")
                if db.execute("SELECT 1 FROM page WHERE route=?", (route,)).fetchone():
                    raise _RouteTaken
                # bundle files are shared by digest and never removed on failure: once the lock
                # is released, another committed call may own the same file
                for bundle in bundles:
                    path = self.root / "bundles" / f"{bundle_digest(bundle)}.json"
                    self._atomic_private_write(path, (canonical_bundle(bundle) + "\n").encode())
                hook = getattr(self, "before_create_commit", None)
                if hook is not None:
                    hook()
                db.execute(
                    "INSERT INTO page(id,route,title,active_code_revision,created_at,updated_at,credential_hash,created_by_page_id) "  # noqa: E501
                    "VALUES(?,?,?,?,?,?,?,?)",
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
                    "INSERT INTO code_revision(page_id,version,source,dependencies,resolved_dependencies,lockfile,digest,artifact_size,diagnostics,runtime_error,created_at) "  # noqa: E501
                    "VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                    (
                        page_id,
                        1,
                        package["source"],
                        json.dumps(built["dependencies"], sort_keys=True),
                        json.dumps(built["resolved_dependencies"], sort_keys=True),
                        built["lockfile"],
                        built["digest"],
                        built["size"],
                        None,
                        None,
                        stamp,
                    ),
                )
                db.execute(
                    "INSERT INTO audit(page_id,action,version_digest,created_at) VALUES(?,?,?,?)",
                    (page_id, "create_page", built["digest"], stamp),
                )
                for bundle in bundles:
                    tool_id = secrets.token_hex(12)
                    digest = bundle_digest(bundle)
                    db.execute(
                        "INSERT INTO tool VALUES(?,?,?,?)",
                        (tool_id, page_id, bundle["name"], stamp),
                    )
                    db.execute(
                        "INSERT INTO tool_version VALUES(?,?,?,?,?)",
                        (tool_id, 1, digest, canonical_bundle(bundle), stamp),
                    )
                    db.execute(
                        "INSERT INTO page_tool VALUES(?,?,?,?)", (page_id, tool_id, 1, stamp)
                    )
                    db.execute(
                        "INSERT INTO audit(page_id,action,version_digest,created_at) VALUES(?,?,?,?)",  # noqa: E501
                        (page_id, "create_tool", digest, stamp),
                    )
        except _RouteTaken:
            self._cleanup_create_paths(created_paths)
            # another call took the route while this one built: answer as that page now decides
            return self.create_page(route, title, package, principal_id, tools)
        except (ValidationError, PermissionError):
            self._cleanup_create_paths(created_paths)
            raise
        except Exception as exc:
            self._cleanup_create_paths(created_paths)
            raise ValidationError("", "atomic page creation", "create_failed") from exc
        except BaseException:
            self._cleanup_create_paths(created_paths)
            raise
        row = self.page(page_id)
        assert row is not None
        return row, built["digest"], False, _missing_update_note(bundles)

    @staticmethod
    def _cleanup_create_paths(paths: set[Path]) -> None:
        for path in sorted(paths, key=lambda item: len(item.parts), reverse=True):
            if path.is_dir():
                shutil.rmtree(path, ignore_errors=True)
            else:
                path.unlink(missing_ok=True)

    def create_tool(
        self, page_id: str, bundle: Any, validation_prefix: str = "", target: str | None = None
    ) -> tuple[dict[str, Any], str, str | None]:
        """Add a tool version to target (route or id; default page_id) as principal page_id.

        target must be page_id itself or a page page_id created (created_by_page_id).
        """
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
                if target is not None:
                    owner = db.execute(
                        "SELECT id FROM page WHERE (id=? OR route=?) "
                        "AND (id=? OR created_by_page_id=?)",
                        (target, target, page_id, page_id),
                    ).fetchone()
                    if owner is None:
                        raise ValidationError(
                            "/page",
                            "this page or a page created from this page",
                            "forbidden",
                            "You can add tools only to this page or to a page created from "
                            "this page. To change another page, open that page's chat.",
                        )
                    page_id = owner[0]
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
                note = _missing_update_note(self._page_tools(db, page_id))
            created = {"tool_id": tool_id, "name": bundle["name"], "version": version}
            if target is not None:
                created["page_id"] = page_id
            return created, digest, note
        except Exception:
            raise

    def page_tools(self, page_id: str) -> list[dict[str, Any]]:
        with self._connect() as db:
            return self._page_tools(db, page_id)

    def rollback_tool(
        self, page_id: str, name: str, version: Any, expected_version: Any
    ) -> dict[str, Any]:
        """Append a copy of an earlier tool version and make it active, if the active one
        is still expected_version; the replaced version stays listed, so a restore can be undone."""
        validate_schema(
            {"version": version, "expected_version": expected_version}, _RESTORE_ARGS_SCHEMA
        )
        with self.transaction() as db:
            page = db.execute("SELECT create_mode FROM page WHERE id=?", (page_id,)).fetchone()
            if page is None or not page[0]:
                raise PermissionError("forbidden: create mode is off")
            row = db.execute(
                """SELECT pt.tool_id, pt.active_version, v.digest, v.bundle,
                (SELECT MAX(version) FROM tool_version WHERE tool_id=pt.tool_id)
                FROM page_tool pt
                JOIN tool t ON t.id=pt.tool_id
                JOIN tool_version v ON v.tool_id=pt.tool_id AND v.version=?
                WHERE pt.page_id=? AND t.name=?""",
                (version, page_id, name),
            ).fetchone()
            if row is None:
                raise ValidationError(
                    "/version",
                    "an existing version of a tool on this page",
                    "not_found",
                    "Call inspect_page and pick a tool name and an earlier version.",
                )
            if row["active_version"] != expected_version:
                raise ValidationError(
                    "/expected_version",
                    "current active tool version",
                    "conflict",
                    "Call inspect_page, set expected_version to the tool's version, and retry.",
                )
            restored = row[4] + 1
            stamp = now()
            db.execute(
                "INSERT INTO tool_version VALUES(?,?,?,?,?)",
                (row["tool_id"], restored, row["digest"], row["bundle"], stamp),
            )
            db.execute(
                "UPDATE page_tool SET active_version=?,assigned_at=? WHERE page_id=? AND tool_id=?",
                (restored, stamp, page_id, row["tool_id"]),
            )
            db.execute(
                "INSERT INTO audit(page_id,action,version_digest,created_at) VALUES(?,?,?,?)",
                (page_id, "restore_tool", row["digest"], stamp),
            )
        return {"name": name, "version": restored, "restored_from": version}

    def write_page(
        self,
        page_id: str,
        source: str,
        dependencies: dict[str, str],
        expected_revision: int | None = None,
    ) -> dict[str, Any]:
        page = self.page(page_id)
        if page is None:
            raise ValidationError("/page", "an existing page", "not_found")
        current = page["active_code_revision"] or 0
        if expected_revision is not None and expected_revision != current:
            raise ValidationError("/expected_revision", "current code revision", "conflict")
        stamp = now()
        error_code = "compile_error"
        try:
            result = build_page(self.root, page_id, source, dependencies)
            diagnostics = None
            digest = result["digest"]
            size = result["size"]
        except PageBuildError as exc:
            result = {
                "dependencies": dependencies,
                "resolved_dependencies": {},
                "lockfile": "",
            }
            diagnostics = exc.diagnostics
            error_code = exc.code
            digest = None
            size = None
        with self.transaction() as db:
            active = db.execute(
                "SELECT COALESCE(active_code_revision, 0) FROM page WHERE id=?", (page_id,)
            ).fetchone()[0]
            stale = active != current
            if stale:
                diagnostics = f"{STALE_BUILD} {current}, but revision {active} is now active"
                error_code = "conflict"
                digest = None
                size = None
            version = db.execute(
                "SELECT COALESCE(MAX(version), 0) + 1 FROM code_revision WHERE page_id=?",
                (page_id,),
            ).fetchone()[0]
            db.execute(
                (
                    "INSERT INTO code_revision(page_id,version,source,dependencies,"
                    "resolved_dependencies,lockfile,digest,artifact_size,diagnostics,"
                    "runtime_error,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)"
                ),
                (
                    page_id,
                    version,
                    source,
                    json.dumps(result.get("dependencies", dependencies), sort_keys=True),
                    json.dumps(result.get("resolved_dependencies", {}), sort_keys=True),
                    result.get("lockfile", ""),
                    digest,
                    size,
                    diagnostics,
                    None,
                    stamp,
                ),
            )
            if diagnostics is None:
                db.execute(
                    "UPDATE page SET active_code_revision=?,updated_at=? WHERE id=?",
                    (version, stamp, page_id),
                )
            db.execute(
                "INSERT INTO audit(page_id,action,version_digest,created_at,actor) "
                "VALUES(?,?,?,?,?)",
                (page_id, "write_page", digest, stamp, "page"),
            )
        if diagnostics:
            raise ValidationError("/source", "a current valid build", error_code, diagnostics)
        return {
            "page_id": page_id,
            "revision": version,
            "digest": digest,
            "size": size,
            "dependencies": result["dependencies"],
            "resolved_dependencies": result["resolved_dependencies"],
            "lockfile": result["lockfile"],
        }

    def restore_code(self, page_id: str, version: Any, expected_version: Any) -> dict[str, Any]:
        """Append a copy of an old code revision; history is never rewritten."""
        validate_schema(
            {"version": version, "expected_version": expected_version}, _RESTORE_ARGS_SCHEMA
        )
        with self.transaction() as db:
            page = db.execute(
                "SELECT id,create_mode,active_code_revision FROM page WHERE id=?", (page_id,)
            ).fetchone()
            if page is None or not edits_own_page(page):
                raise PermissionError("forbidden: create mode is off")
            if page["active_code_revision"] != expected_version:
                raise ValidationError("/expected_version", "current code revision", "conflict")
            source = db.execute(
                "SELECT * FROM code_revision WHERE page_id=? AND version=?", (page_id, version)
            ).fetchone()
            if source is None or source["digest"] is None:
                raise ValidationError("/version", "a successful code revision", "not_found")
            new_version = db.execute(
                "SELECT COALESCE(MAX(version),0)+1 FROM code_revision WHERE page_id=?", (page_id,)
            ).fetchone()[0]
            stamp = now()
            db.execute(
                "INSERT INTO code_revision(page_id,version,source,dependencies,resolved_dependencies,lockfile,digest,artifact_size,diagnostics,runtime_error,created_at) "  # noqa: E501
                "VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                (
                    page_id,
                    new_version,
                    source["source"],
                    source["dependencies"],
                    source["resolved_dependencies"],
                    source["lockfile"],
                    source["digest"],
                    source["artifact_size"],
                    None,
                    None,
                    stamp,
                ),
            )
            db.execute(
                "UPDATE page SET active_code_revision=?,updated_at=? WHERE id=?",
                (new_version, stamp, page_id),
            )
            db.execute(
                "INSERT INTO audit(page_id,action,version_digest,created_at,actor) VALUES(?,?,?,?,?)",  # noqa: E501
                (page_id, "restore_code", source["digest"], stamp, "page"),
            )
        return {"revision": new_version, "restored_from": version, "digest": source["digest"]}

    def page_code(self, page_id: str) -> dict[str, Any] | None:
        with self._connect() as db:
            row = db.execute(
                "SELECT active_code_revision FROM page WHERE id=?", (page_id,)
            ).fetchone()
            if row is None or row[0] is None:
                return None
            code = db.execute(
                "SELECT * FROM code_revision WHERE page_id=? AND version=?", (page_id, row[0])
            ).fetchone()
        return dict(code) if code else None

    def set_runtime_error(self, page_id: str, revision: int, error: str) -> None:
        with self.transaction() as db:
            db.execute(
                "UPDATE code_revision SET runtime_error=? WHERE page_id=? AND version=?",
                (error[:4000], page_id, revision),
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
