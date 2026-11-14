from __future__ import annotations

import json
import secrets
from typing import Any

from jsonschema import Draft202012Validator

from .pages import now
from .tools import validate_bundle


def _check(validator: Draft202012Validator, value: Any, label: str) -> None:
    error = next(validator.iter_errors(value), None)
    if error is not None:
        raise ValueError(f"invalid {label}: {error.message}")


def _insert(db, page_id, collection, version, schema, arguments):
    document = arguments
    _check(schema, document, "record")
    record_id = str(arguments.get("id") or secrets.token_hex(12))
    stamp = now()
    db.execute(
        "INSERT INTO page_record(page_id,collection,record_id,version,document,created_at,"
        "updated_at) "
        "VALUES(?,?,?,?,?,?,?)",
        (
            page_id,
            collection,
            record_id,
            version,
            json.dumps(document, sort_keys=True),
            stamp,
            stamp,
        ),
    )
    return {**document, "record_id": record_id}


def _get(db, page_id, collection, arguments):
    found = db.execute(
        "SELECT record_id, document FROM page_record "
        "WHERE page_id=? AND collection=? AND record_id=?",
        (page_id, collection, arguments.get("record_id")),
    ).fetchone()
    if found is None:
        return None
    return {**json.loads(found[1]), "record_id": found[0]}


def _list(db, page_id, collection):
    found = db.execute(
        "SELECT record_id,document FROM page_record "
        "WHERE page_id=? AND collection=? ORDER BY created_at",
        (page_id, collection),
    ).fetchall()
    return [{**json.loads(item[1]), "record_id": item[0]} for item in found]


def _update(db, page_id, collection, version, schema, arguments):
    record_id = arguments.get("record_id")
    found = db.execute(
        "SELECT document FROM page_record WHERE page_id=? AND collection=? AND record_id=?",
        (page_id, collection, record_id),
    ).fetchone()
    if found is None:
        raise ValueError("record not found")
    document = json.loads(found[0])
    document.update({k: v for k, v in arguments.items() if k != "record_id"})
    _check(schema, document, "record")
    db.execute(
        "UPDATE page_record SET version=?, document=?, updated_at=? "
        "WHERE page_id=? AND collection=? AND record_id=?",
        (
            version,
            json.dumps(document, sort_keys=True),
            now(),
            page_id,
            collection,
            record_id,
        ),
    )
    return {**document, "record_id": record_id}


def call_record(store, page_id: str, tool_name: str, arguments: dict[str, Any]) -> Any:
    if not isinstance(arguments, dict):
        raise ValueError("tool arguments must be an object")
    with store.transaction() as db:
        row = db.execute(
            """SELECT t.id, t.owner_page_id, v.version, v.bundle FROM tool t
               JOIN page_tool pt ON pt.tool_id=t.id JOIN tool_version v
               ON v.tool_id=t.id AND v.version=pt.active_version
               WHERE t.owner_page_id=? AND t.name=? AND pt.page_id=?""",
            (page_id, tool_name, page_id),
        ).fetchone()
        if row is None:
            raise PermissionError("forbidden: tool is not assigned to this page")
        bundle = validate_bundle(json.loads(row["bundle"]))
        _check(Draft202012Validator(bundle["input_schema"]), arguments, "tool input")
        implementation = bundle["implementation"]
        operation = implementation["operation"]
        collection = implementation["collection"]
        schema = Draft202012Validator(implementation["data_schema"])
        if operation == "insert":
            result = _insert(db, page_id, collection, row["version"], schema, arguments)
        elif operation == "get":
            result = _get(db, page_id, collection, arguments)
        elif operation == "list":
            result = _list(db, page_id, collection)
        else:
            result = _update(db, page_id, collection, row["version"], schema, arguments)
        _check(Draft202012Validator(bundle["output_schema"]), result, "tool output")
        return result
