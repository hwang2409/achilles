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
from typing import Any, Callable

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

_BLOCK_FIELDS_SCHEMA = {"type": "array", "items": {"type": "string"}, "uniqueItems": True}

_LAYOUT_BLOCK_SCHEMA = {
    "oneOf": [
        {
            "type": "object",
            "properties": {
                "type": {"const": "list"},
                "title": {"type": "string"},
                "collection": {"type": "string"},
                "fields": {
                    **_BLOCK_FIELDS_SCHEMA,
                    "description": (
                        "Columns, in order, from the collection's data schema. Leave it out "
                        "to show required fields first, then the rest sorted."
                    ),
                },
            },
            "required": ["type", "title", "collection"],
            "additionalProperties": False,
        },
        {
            "type": "object",
            "description": (
                "Shows field labels only unless filter selects records from collection, for "
                'example {"field":"run_id","equals":"run-002"}. One match shows its '
                "values; multiple matches show the highest creation time, with ties resolved "
                "by highest record id. Get field names from an assigned tool's schema."
            ),
            "properties": {
                "type": {"const": "detail"},
                "title": {"type": "string"},
                "collection": {"type": "string"},
                "fields": {"type": "array", "items": {"type": "string"}},
                "filter": _EQUALITY_FILTER_SCHEMA,
            },
            "required": ["type", "title", "fields"],
            "dependentRequired": {"filter": ["collection"]},
            "additionalProperties": False,
        },
        {
            "type": "object",
            "properties": {
                "type": {"const": "form"},
                "title": {"type": "string"},
                "tool": {"type": "string"},
                "fields": {
                    **_BLOCK_FIELDS_SCHEMA,
                    "description": (
                        "Input order, from the tool's input schema; inputs you leave out "
                        "follow, required first."
                    ),
                },
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
        {
            "type": "object",
            "properties": {
                "type": {"const": "metric"},
                "label": {"type": "string"},
                "collection": {"type": "string"},
                "count": {"const": True},
                "where": _EQUALITY_FILTER_SCHEMA,
            },
            "required": ["type", "label", "collection", "count"],
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
UPDATE_LAYOUT_SCHEMA = {
    "type": "object",
    "properties": {
        "layout": {
            **LAYOUT_SCHEMA,
            "description": (
                "When achilles__inspect_page reports layout_complete true, copy its complete "
                "stored layout; any block you leave out is deleted. When layout_complete is "
                "false, do not change the page; tell the user it is too large to edit from chat."
            ),
            "properties": {
                "blocks": {
                    **LAYOUT_SCHEMA["properties"]["blocks"],
                    "description": (
                        "The full ordered block list; insert, reorder, or remove blocks "
                        "from the inspected list."
                    ),
                }
            },
        },
        "expected_version": {
            "type": "integer",
            "minimum": 1,
            "description": (
                "The layout_version from achilles__inspect_page; pass it as "
                "expected_version. On a conflict, inspect again and retry."
            ),
        },
    },
    "required": ["layout", "expected_version"],
    "additionalProperties": False,
}
_VERSION_NUMBER = {"type": "integer", "minimum": 1}
RESTORE_VERSION_SCHEMA = {
    "type": "object",
    "properties": {
        "kind": {"enum": ["layout", "tool"]},
        "name": {"type": "string", "description": "The tool name; required when kind is tool."},
        "version": {
            **_VERSION_NUMBER,
            "description": (
                "The version to restore: a layout_versions entry or an earlier tool version "
                "from achilles__inspect_page."
            ),
        },
        "expected_version": {
            **_VERSION_NUMBER,
            "description": (
                "The current version from achilles__inspect_page: layout_version for a layout, "
                "the tool's version for a tool. On a conflict, inspect again and retry."
            ),
        },
        "route": {
            "type": "string",
            "description": "Optional; must be this page's route.",
        },
    },
    "required": ["kind", "version", "expected_version"],
    "additionalProperties": False,
}
_RESTORE_ARGS_SCHEMA = {
    "type": "object",
    "properties": {"version": _VERSION_NUMBER, "expected_version": _VERSION_NUMBER},
    "required": ["version", "expected_version"],
}
LAYOUT_HISTORY_LIMIT = 20
INSPECT_MAX_BYTES = 8 * 1024
DETAIL_SUGGESTION_RECORD_LIMIT = 200

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


def bounded_inspect(value: dict[str, Any]) -> tuple[dict[str, Any], str]:
    result = {
        **value,
        "layout": {**value["layout"], "blocks": list(value["layout"]["blocks"])},
        "layout_complete": True,
        "metric_values": list(value["metric_values"]),
        "detail_filter_matches": list(value["detail_filter_matches"]),
        "tools": list(value["tools"]),
        "collections": dict(value["collections"]),
        "layout_versions": list(value["layout_versions"]),
    }

    def serialize() -> str:
        return json.dumps(result, sort_keys=True, separators=(",", ":"))

    encoded = serialize()
    if len(encoded.encode()) <= INSPECT_MAX_BYTES:
        return result, encoded

    result["truncated"] = True
    result["omitted"] = {}
    for key in (
        "layout_versions",
        "metric_values",
        "detail_filter_matches",
        "tools",
        "collections",
        "title",
    ):
        omitted = result.pop(key)
        result["omitted"][key] = len(omitted) if not isinstance(omitted, str) else 1
        encoded = serialize()
        if len(encoded.encode()) <= INSPECT_MAX_BYTES:
            return result, encoded

    result["layout"] = None
    result["layout_complete"] = False
    result["message"] = "do not change this page; tell the user it is too large to edit from chat"
    return result, serialize()


def require_inspectable(value: dict[str, Any]) -> None:
    bounded, _ = bounded_inspect(value)
    if not bounded["layout_complete"]:
        raise ValidationError(
            "/layout",
            f"inspect_page result no larger than {INSPECT_MAX_BYTES} bytes",
            "layout_too_large",
            "Keep the page smaller, e.g. use fewer or shorter blocks.",
        )


def validate_page_route(route: str) -> None:
    validate_schema(route, CREATE_PAGE_SCHEMA["properties"]["route"], "/route")


def now() -> str:
    return datetime.now(UTC).isoformat()


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


def validate_layout(
    layout: Any,
    assigned_tools: set[str] | None = None,
    assigned_collections: set[str] | None = None,
    prefix: str = "",
    collection_fields: dict[str, set[str]] | None = None,
    suggest_field: Callable[[str, str, Any, set[str]], str | None] | None = None,
    tool_fields: dict[str, set[str]] | None = None,
) -> dict[str, Any]:
    validate_schema(layout, LAYOUT_SCHEMA, prefix)
    tools = assigned_tools or set()
    for index, block in enumerate(layout["blocks"]):
        if block["type"] == "form" and block["tool"] not in tools:
            raise ValidationError(
                f"{prefix}/blocks/{index}/tool",
                "assigned tool name",
                hint=(
                    "Add a tool with this name to create_page.tools (or call create_tool first), "
                    "then retry."
                ),
            )
        if (
            block["type"] in {"list", "detail"}
            and "collection" in block
            and assigned_collections is not None
            and block["collection"] not in assigned_collections
        ):
            raise ValidationError(
                f"{prefix}/blocks/{index}/collection",
                "assigned collection",
                hint=(
                    "Add a tool for this collection in create_page.tools (or call create_tool "
                    'first), for example: {"format_version":1,"kind":"data_operation",'
                    '"name":"list_collection_name","description":"list records",'
                    '"input_schema":{"type":"object","properties":{}},'
                    '"implementation":{"operation":"list",'
                    '"collection":"collection_name","data_schema":{"type":'
                    '"object","properties":{}}}}. A simple inferred input_schema is fine.'
                ),
            )
        _validate_layout_filter(block, index, prefix, collection_fields, suggest_field)
        _validate_block_fields(block, index, prefix, collection_fields, tool_fields)
    return layout


def _validate_block_fields(
    block: dict[str, Any],
    index: int,
    prefix: str,
    collection_fields: dict[str, set[str]] | None,
    tool_fields: dict[str, set[str]] | None,
) -> None:
    if "fields" not in block:
        return
    if block["type"] == "list" and collection_fields is not None:
        known = collection_fields.get(block["collection"], set())
        source = f"the {block['collection']} collection schema"
    elif block["type"] == "form" and tool_fields is not None:
        known = tool_fields.get(block["tool"], set())
        source = f"the {block['tool']} tool input schema"
    else:
        return
    for position, field in enumerate(block["fields"]):
        if field in known:
            continue
        raise ValidationError(
            f"{prefix}/blocks/{index}/fields/{position}",
            f"field in {source}",
            hint=unknown_field_hint(source, field, known),
        )


def _validate_layout_filter(
    block: dict[str, Any],
    index: int,
    prefix: str,
    collection_fields: dict[str, set[str]] | None,
    suggest_field: Callable[[str, str, Any, set[str]], str | None] | None,
) -> None:
    if block["type"] == "detail" and "filter" in block:
        filter_name = "filter"
    elif block["type"] == "metric" and "where" in block:
        filter_name = "where"
    else:
        return
    if collection_fields is None:
        return

    field_filter = block[filter_name]
    fields = collection_fields.get(block["collection"], set())
    field = field_filter["field"]
    if field in fields:
        return

    suggestion = (
        suggest_field(block["collection"], field, field_filter["equals"], fields)
        if suggest_field is not None
        else None
    )
    raise ValidationError(
        f"{prefix}/blocks/{index}/{filter_name}/field",
        "field in collection schema",
        hint=unknown_field_hint(
            f"the {block['collection']} collection schema", field, fields, suggestion
        ),
    )


def unknown_field_hint(
    source: str, field: str, fields: set[str], suggestion: str | None = None
) -> str:
    listed = ", ".join(sorted(fields)) or "(none)"
    hint = f"Use a field from {source}. Unknown field: {field}. Fields: {listed}."
    if suggestion is not None:
        hint += f" Did you mean {suggestion}?"
    return hint


def _tool_fields(bundles: list[dict[str, Any]]) -> dict[str, set[str]]:
    return {bundle["name"]: set(bundle["input_schema"].get("properties", {})) for bundle in bundles}


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


def _filter_value_text(value: Any) -> str:
    if value is None:
        return "null"
    if isinstance(value, bool):
        return str(value).lower()
    return str(value)


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


def detail_filter_result(
    db: sqlite3.Connection,
    page_id: str,
    collection: str,
    field_filter: dict[str, Any],
    collection_fields: set[str],
) -> dict[str, Any]:
    field_filter = validate_record_filter(field_filter)
    field = field_filter["field"]
    expected = field_filter["equals"]
    predicate, parameters = _json_scalar_match(field, expected)
    matched = db.execute(
        "SELECT COUNT(*) FROM page_record WHERE page_id=? AND collection=? AND " + predicate,
        (page_id, collection, *parameters),
    ).fetchone()[0]
    result: dict[str, Any] = {"matched": matched}
    if matched:
        return result

    hint = f"no record has {field} = {_filter_value_text(expected)}"
    suggestion = _suggest_filter_field(db, page_id, collection, field, expected, collection_fields)
    if suggestion is not None:
        hint += f"; did you mean {suggestion}?"
    elif field not in collection_fields:
        hint += f"; {field} is not in the {collection} collection schema"
    result["hint"] = hint
    return result


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
        ensure_column(db, "chat", "titled_by_user", "INTEGER NOT NULL DEFAULT 0")
        # default 1: rows from before this column, or written by older code, count as sent and
        # stay listed; only register_chat/save_session insert a new chat as 0 until its first send.
        ensure_column(db, "chat", "message_sent", "INTEGER NOT NULL DEFAULT 1")
        # the first message's title, kept apart from `title` so clearing a rename falls back to it;
        # an older chat's automatic title is its best first-message title.
        ensure_column(
            db,
            "chat",
            "first_title",
            "TEXT",
            "UPDATE chat SET first_title=title WHERE NOT titled_by_user",
        )
        # who wrote a record and which one; older rows and older code leave both NULL.
        ensure_column(db, "audit", "actor", "TEXT")
        ensure_column(db, "audit", "record_id", "TEXT")
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

    @staticmethod
    def _active_layout(
        db: sqlite3.Connection, page_id: str
    ) -> tuple[int, str | None, dict[str, Any]] | None:
        row = db.execute(
            "SELECT COALESCE(p.active_layout_version, 1),lv.digest,lv.document FROM page p "
            "LEFT JOIN layout_version lv ON lv.page_id=p.id "
            "AND lv.version=COALESCE(p.active_layout_version, 1) WHERE p.id=?",
            (page_id,),
        ).fetchone()
        if row is None:
            return None
        document = json.loads(row[2]) if row[2] else {"blocks": []}
        return row[0], row[1], document

    @staticmethod
    def _computed_layout(
        db: sqlite3.Connection, page_id: str, document: dict[str, Any]
    ) -> dict[str, Any]:
        for block in document.get("blocks", []):
            if block.get("type") != "metric" or block.get("count") is not True:
                continue
            where = block.get("where")
            if where is None:
                count = db.execute(
                    "SELECT COUNT(*) FROM page_record WHERE page_id=? AND collection=?",
                    (page_id, block["collection"]),
                ).fetchone()[0]
            else:
                predicate, parameters = _json_scalar_match(where["field"], where["equals"])
                count = db.execute(
                    "SELECT COUNT(*) FROM page_record WHERE page_id=? AND collection=? AND "
                    + predicate,
                    (page_id, block["collection"], *parameters),
                ).fetchone()[0]
            block["value"] = count
        return document

    def layout(self, page_id: str) -> dict[str, Any]:
        with self._connect() as db:
            active = self._active_layout(db, page_id)
            return self._computed_layout(db, page_id, active[2]) if active else {"blocks": []}

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

    @staticmethod
    def _inspect_projection(
        page: Any,
        active: tuple[int, str | None, dict[str, Any]],
        metric_values: list[dict[str, Any]],
        detail_filter_matches: list[dict[str, Any]],
        tools: list[dict[str, Any]],
        collections: dict[str, int],
        layout_versions: list[dict[str, Any]],
    ) -> dict[str, Any]:
        version, digest, document = active
        return {
            "route": page["route"],
            "title": page["title"],
            "create_mode": bool(page["create_mode"]),
            "layout": document,
            "layout_version": version,
            "layout_digest": digest,
            "metric_values": metric_values,
            "detail_filter_matches": detail_filter_matches,
            "tools": [
                {
                    "name": tool["name"],
                    "version": tool["version"],
                    "operations": [tool["implementation"]["operation"]],
                    "collection": tool["implementation"]["collection"],
                }
                for tool in tools
            ],
            "collections": collections,
            "layout_versions": layout_versions,
        }

    @staticmethod
    def _detail_filter_matches(
        db: sqlite3.Connection,
        page_id: str,
        layout: dict[str, Any],
        collection_fields: dict[str, set[str]],
    ) -> list[dict[str, Any]]:
        return [
            {
                "block": index,
                **detail_filter_result(
                    db,
                    page_id,
                    block["collection"],
                    block["filter"],
                    collection_fields.get(block["collection"], set()),
                ),
            }
            for index, block in enumerate(layout.get("blocks", []))
            if block.get("type") == "detail" and "filter" in block
        ]

    def _inspect_page(
        self,
        db: sqlite3.Connection,
        page_id: str,
        active: tuple[int, str | None, dict[str, Any]] | None = None,
    ) -> dict[str, Any]:
        row = db.execute("SELECT * FROM page WHERE id=?", (page_id,)).fetchone()
        if row is None:
            raise KeyError(page_id)
        if active is None:
            active = self._active_layout(db, page_id)
        assert active is not None
        version, digest, document = active
        computed = self._computed_layout(
            db,
            page_id,
            {"blocks": [dict(block) for block in document.get("blocks", [])]},
        )
        metric_values = [
            {"block": index, "value": block["value"]}
            for index, block in enumerate(computed["blocks"])
            if block.get("type") == "metric" and block.get("count") is True
        ]
        counts = db.execute(
            "SELECT collection, COUNT(*) FROM page_record WHERE page_id=? GROUP BY collection",
            (page_id,),
        ).fetchall()
        tools = self._page_tools(db, page_id)
        detail_filter_matches = self._detail_filter_matches(
            db, page_id, document, _collection_fields(tools)
        )
        history = db.execute(
            "SELECT version, created_at, document FROM layout_version WHERE page_id=? "
            "ORDER BY version DESC LIMIT ?",
            (page_id, LAYOUT_HISTORY_LIMIT),
        ).fetchall()
        layout_versions = [
            {
                "version": row[0],
                "created_at": row[1],
                "block_types": [block["type"] for block in json.loads(row[2])["blocks"]],
            }
            for row in history
        ]
        return self._inspect_projection(
            row,
            (version, digest, document),
            metric_values,
            detail_filter_matches,
            tools,
            {collection: count for collection, count in counts},
            layout_versions,
        )

    def inspect_page(self, page_id: str) -> dict[str, Any]:
        with self._connect() as db:
            return self._inspect_page(db, page_id)

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
                + " ORDER BY created_at DESC, record_id DESC LIMIT 1",
                query_parameters,
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
            # a stable order (home, then newest created first): a setting toggle never moves navigation
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
                "c.message_sent FROM chat c "
                f"JOIN page p ON p.id=c.page_id {where} "
                "ORDER BY c.updated_at DESC,c.session_id DESC LIMIT ?",
                (*parameters, limit + 1),
            ).fetchall()
        return [chat_row(row) for row in rows]

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
                "INSERT OR IGNORE INTO chat(session_id,page_id,created_at,updated_at,message_sent) "
                "VALUES(?,?,?,?,0)",
                (session_id, page_id, stamp, stamp),
            )
            row = db.execute(
                "SELECT page_id FROM chat WHERE session_id=?", (session_id,)
            ).fetchone()
            if row["page_id"] != page_id:
                raise ValueError("session belongs to another page")
        return self.chat(session_id)

    def chat(self, session_id: str) -> dict[str, Any]:
        with self._connect() as db:
            row = db.execute(
                "SELECT session_id,page_id,title,first_title,created_at,updated_at,last_state,"
                "titled_by_user,message_sent FROM chat WHERE session_id=?",
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
        layout: Any,
        principal_id: str = "home",
        tools: Any = None,
    ) -> tuple[sqlite3.Row, str, bool, list[dict[str, Any]], str | None]:
        bundles = [] if tools is None else tools
        value = {"route": route, "title": title, "layout": layout, "tools": bundles}
        validate_schema(value, CREATE_PAGE_SCHEMA)
        bundles = [
            validate_bundle(bundle, f"/tools/{index}", reject_conflicting_output=True)
            for index, bundle in enumerate(bundles)
        ]
        fields = _collection_fields(bundles)
        validate_layout(
            layout,
            {bundle["name"] for bundle in bundles},
            {bundle["implementation"]["collection"] for bundle in bundles},
            "/layout",
            fields,
            tool_fields=_tool_fields(bundles),
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
                        summary = self._inspect_page(db, existing["id"])["detail_filter_matches"]
                        return existing, digest, True, summary, _missing_update_note(bundles)
                    raise ValidationError(
                        "/route", "unused route or equivalent request", "conflict"
                    )
                detail_summary = self._detail_filter_matches(db, "", layout, fields)
                require_inspectable(
                    self._inspect_projection(
                        {"route": route, "title": title, "create_mode": False},
                        (1, digest, layout),
                        [
                            {"block": index, "value": 0}
                            for index, block in enumerate(layout["blocks"])
                            if block.get("type") == "metric" and block.get("count") is True
                        ],
                        detail_summary,
                        [
                            {**bundle, "version": 1}
                            for bundle in sorted(bundles, key=lambda item: item["name"])
                        ],
                        {},
                        [],
                    )
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
                note = _missing_update_note(bundles)
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
        return row, digest, False, detail_summary, note

    @staticmethod
    def _cleanup_create_paths(paths: set[Path]) -> None:
        for path in sorted(paths, key=lambda item: len(item.parts), reverse=True):
            if path.is_dir():
                shutil.rmtree(path, ignore_errors=True)
            else:
                path.unlink(missing_ok=True)

    def update_layout(
        self, page_id: str, layout: Any, expected_version: int
    ) -> tuple[int, str, list[dict[str, Any]]]:
        validate_schema(
            {"layout": layout, "expected_version": expected_version}, UPDATE_LAYOUT_SCHEMA
        )
        return self._append_layout(page_id, layout, expected_version, "update_layout")

    def restore_layout(
        self, page_id: str, version: Any, expected_version: Any
    ) -> tuple[int, str, list[dict[str, Any]]]:
        """Append a copy of an old layout version; history is never rewritten."""
        validate_schema(
            {"version": version, "expected_version": expected_version}, _RESTORE_ARGS_SCHEMA
        )
        with self._connect() as db:
            row = db.execute(
                "SELECT document FROM layout_version WHERE page_id=? AND version=?",
                (page_id, version),
            ).fetchone()
        if row is None:
            raise ValidationError(
                "/version",
                "an existing layout version",
                "not_found",
                "Call inspect_page and pick a version from layout_versions.",
            )
        return self._append_layout(page_id, json.loads(row[0]), expected_version, "restore_layout")

    def _append_layout(
        self, page_id: str, layout: dict[str, Any], expected_version: int, action: str
    ) -> tuple[int, str, list[dict[str, Any]]]:
        encoded = json.dumps(layout, sort_keys=True, separators=(",", ":"))
        digest = hashlib.sha256(encoded.encode()).hexdigest()
        with self.transaction() as db:
            page = db.execute("SELECT create_mode FROM page WHERE id=?", (page_id,)).fetchone()
            if page is None or not page["create_mode"]:
                raise PermissionError("forbidden: create mode is off")
            active = self._active_layout(db, page_id)
            assert active is not None
            require_inspectable(self._inspect_page(db, page_id, active))
            active_version = active[0]
            tools = db.execute(
                "SELECT t.name, v.bundle FROM page_tool pt "
                "JOIN tool t ON t.id=pt.tool_id JOIN tool_version v ON v.tool_id=t.id "
                "AND v.version=pt.active_version WHERE pt.page_id=?",
                (page_id,),
            ).fetchall()
            bundles = [validate_bundle(json.loads(tool["bundle"])) for tool in tools]
            fields = _collection_fields(bundles)
            validate_layout(
                layout,
                {tool["name"] for tool in tools},
                {bundle["implementation"]["collection"] for bundle in bundles},
                "/layout",
                fields,
                lambda collection, field, value, collection_fields: _suggest_filter_field(
                    db, page_id, collection, field, value, collection_fields
                ),
                _tool_fields(bundles),
            )
            if expected_version != active_version:
                raise ValidationError(
                    "/expected_version",
                    "current active layout version",
                    "conflict",
                    "Call inspect_page, set expected_version to layout.version, and retry.",
                )
            version = active_version + 1
            proposed = self._inspect_page(db, page_id, (version, digest, layout))
            require_inspectable(proposed)
            detail_summary = proposed["detail_filter_matches"]
            stamp = now()
            db.execute(
                "UPDATE page SET active_layout_version=?,updated_at=? WHERE id=?",
                (version, stamp, page_id),
            )
            db.execute(
                "INSERT INTO layout_version VALUES(?,?,?,?,?)",
                (page_id, version, digest, encoded, stamp),
            )
            db.execute(
                "INSERT INTO audit(page_id,action,version_digest,created_at) VALUES(?,?,?,?)",
                (page_id, action, digest, stamp),
            )
        return version, digest, detail_summary

    def create_tool(
        self, page_id: str, bundle: Any, validation_prefix: str = ""
    ) -> tuple[dict[str, Any], str, str | None]:
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
                note = _missing_update_note(self._page_tools(db, page_id))
            return {"tool_id": tool_id, "name": bundle["name"], "version": version}, digest, note
        except Exception:
            raise

    def page_tools(self, page_id: str) -> list[dict[str, Any]]:
        with self._connect() as db:
            return self._page_tools(db, page_id)

    def rollback_tool(
        self, page_id: str, name: str, version: Any, expected_version: Any
    ) -> dict[str, Any]:
        """Make an earlier tool version active if the active one is still expected_version."""
        validate_schema(
            {"version": version, "expected_version": expected_version}, _RESTORE_ARGS_SCHEMA
        )
        with self.transaction() as db:
            row = db.execute(
                """SELECT pt.tool_id, pt.active_version, v.digest FROM page_tool pt
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
            stamp = now()
            db.execute(
                "UPDATE page_tool SET active_version=? WHERE page_id=? AND tool_id=?",
                (version, page_id, row["tool_id"]),
            )
            db.execute(
                "INSERT INTO audit(page_id,action,version_digest,created_at) VALUES(?,?,?,?)",
                (page_id, "restore_tool", row["digest"], stamp),
            )
        return {"name": name, "version": version}

    def tool_bundle(self, page_id: str, name: str) -> dict[str, Any] | None:
        with self._connect() as db:
            row = db.execute(
                """SELECT v.bundle FROM page_tool pt JOIN tool t ON t.id=pt.tool_id
                JOIN tool_version v ON v.tool_id=t.id AND v.version=pt.active_version
                WHERE pt.page_id=? AND t.name=?""",
                (page_id, name),
            ).fetchone()
        return validate_bundle(json.loads(row[0])) if row else None
