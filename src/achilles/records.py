from __future__ import annotations

import json
import secrets
from typing import Any, Literal

from jsonschema import Draft202012Validator

from .pages import (
    _EQUALITY_FILTER_SCHEMA,
    PageStore,
    _collection_fields,
    _json_scalar_match,
    _suggest_filter_field,
    now,
    unknown_field_hint,
)
from .tools import validate_bundle
from .validation import ValidationError, validate_schema

LIST_LIMIT = 500


def _check(validator: Draft202012Validator, value: Any) -> None:
    validate_schema(value, validator.schema)


def _insert(db, page_id, collection, version, schema, arguments):
    document = arguments
    _check(schema, document)
    record_id = str(arguments.get("id") or secrets.token_hex(12))
    stamp = now()
    db.execute(
        "INSERT INTO page_record(page_id,collection,record_id,version,revision,document,created_at,"
        "updated_at) "
        "VALUES(?,?,?,?,?,?,?,?)",
        (
            page_id,
            collection,
            record_id,
            version,
            1,
            json.dumps(document, sort_keys=True),
            stamp,
            stamp,
        ),
    )
    return {**document, "record_id": record_id, "revision": 1}


def _get(db, page_id, collection, arguments):
    found = db.execute(
        "SELECT record_id, document, revision FROM page_record "
        "WHERE page_id=? AND collection=? AND record_id=?",
        (page_id, collection, arguments.get("record_id")),
    ).fetchone()
    if found is None:
        return None
    return {**json.loads(found[1]), "record_id": found[0], "revision": found[2]}


def list_input_schema(input_schema: dict[str, Any]) -> dict[str, Any]:
    """Every list tool accepts where and limit on top of its own input schema."""
    return {
        **input_schema,
        "properties": {
            **input_schema.get("properties", {}),
            "where": _EQUALITY_FILTER_SCHEMA,
            "limit": {
                "type": "integer",
                "minimum": 1,
                "maximum": LIST_LIMIT,
                "description": f"Default {LIST_LIMIT}.",
            },
        },
    }


def _check_list_field(db, page_id, collection, where):
    field = where["field"]
    fields = _collection_fields(PageStore._page_tools(db, page_id)).get(collection, set())
    if field in fields:
        return
    # free-form collections have no schema properties; a field stored on a record is real too
    stored = db.execute(
        "SELECT 1 FROM page_record WHERE page_id=? AND collection=? "
        "AND json_type(document, ?) IS NOT NULL LIMIT 1",
        (page_id, collection, f'$."{field}"'),
    ).fetchone()
    if stored is not None:
        return
    suggestion = _suggest_filter_field(db, page_id, collection, field, where["equals"], fields)
    raise ValidationError(
        "/where/field",
        "field in collection schema",
        hint=unknown_field_hint(f"the {collection} collection schema", field, fields, suggestion),
    )


def _list(db, page_id, collection, arguments):
    query = "SELECT record_id,document,revision FROM page_record WHERE page_id=? AND collection=?"
    parameters: tuple[Any, ...] = (page_id, collection)
    where = arguments.get("where")
    if where is not None:
        _check_list_field(db, page_id, collection, where)
        # the field reaches SQL only as a bound json path parameter, never as SQL text
        predicate, filter_parameters = _json_scalar_match(where["field"], where["equals"])
        query += " AND " + predicate
        parameters += filter_parameters
    found = db.execute(
        query + " ORDER BY created_at DESC, rowid DESC LIMIT ?",
        (*parameters, arguments.get("limit", LIST_LIMIT)),
    ).fetchall()
    return [{**json.loads(item[1]), "record_id": item[0], "revision": item[2]} for item in found]


def _update(db, page_id, collection, version, schema, arguments):
    record_id = arguments.get("record_id")
    found = db.execute(
        "SELECT document FROM page_record WHERE page_id=? AND collection=? AND record_id=?",
        (page_id, collection, record_id),
    ).fetchone()
    if found is None:
        raise ValueError("record not found")
    revision = arguments.get("revision")
    document = json.loads(found[0])
    document.update({k: v for k, v in arguments.items() if k not in {"record_id", "revision"}})
    _check(schema, document)
    updated = db.execute(
        "UPDATE page_record SET version=?, revision=revision+1, document=?, updated_at=? "
        "WHERE page_id=? AND collection=? AND record_id=? AND revision=?",
        (
            version,
            json.dumps(document, sort_keys=True),
            now(),
            page_id,
            collection,
            record_id,
            revision,
        ),
    )
    if updated.rowcount != 1:
        # record the live revision so a caller can retry without a separate read
        live = db.execute(
            "SELECT revision FROM page_record WHERE page_id=? AND collection=? AND record_id=?",
            (page_id, collection, record_id),
        ).fetchone()
        current = {"record_id": record_id, "revision": live[0]} if live else None
        raise VersionConflict("/revision", "current record revision", current)
    return {**document, "record_id": record_id, "revision": revision + 1}


class VersionConflict(ValidationError):
    def __init__(self, path: str, expected: str, current: dict[str, Any] | None = None):
        super().__init__(path, expected, "conflict")
        self.current = current


def call_record(
    store,
    page_id: str,
    tool_name: str,
    arguments: dict[str, Any],
    expected_version: int,
    actor: Literal["form", "agent"],
) -> Any:
    if not isinstance(arguments, dict):
        raise ValueError("tool arguments must be an object")
    with store.transaction() as db:
        row = db.execute(
            """SELECT t.id, t.owner_page_id, v.version, v.digest, v.bundle FROM tool t
               JOIN page_tool pt ON pt.tool_id=t.id JOIN tool_version v
               ON v.tool_id=t.id AND v.version=pt.active_version
               WHERE t.owner_page_id=? AND t.name=? AND pt.page_id=?""",
            (page_id, tool_name, page_id),
        ).fetchone()
        if row is None:
            raise PermissionError("forbidden: tool is not assigned to this page")
        if expected_version != row["version"]:
            raise VersionConflict("/version", "active tool version")
        bundle = validate_bundle(json.loads(row["bundle"]))
        implementation = bundle["implementation"]
        operation = implementation["operation"]
        input_schema = bundle["input_schema"]
        if operation == "list":
            input_schema = list_input_schema(input_schema)
        _check(Draft202012Validator(input_schema), arguments)
        collection = implementation["collection"]
        schema = Draft202012Validator(implementation["data_schema"])
        if operation == "insert":
            result = _insert(db, page_id, collection, row["version"], schema, arguments)
        elif operation == "get":
            result = _get(db, page_id, collection, arguments)
        elif operation == "list":
            result = _list(db, page_id, collection, arguments)
        else:
            result = _update(db, page_id, collection, row["version"], schema, arguments)
        _check(Draft202012Validator(bundle["output_schema"]), result)
        record_id = result.get("record_id") if isinstance(result, dict) else None
        db.execute(
            "INSERT INTO audit(page_id,action,version_digest,created_at,actor,record_id) "
            "VALUES(?,?,?,?,?,?)",
            (page_id, f"invoke:{tool_name}", row["digest"], now(), actor, record_id),
        )
        return result
