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


def call_record(store, page_id: str, tool_name: str, arguments: dict[str, Any]) -> Any:
    if not isinstance(arguments, dict):
        raise ValueError("tool arguments must be an object")
    db = store.db
    db.execute("BEGIN")
    try:
        principal = db.execute("SELECT create_mode FROM page WHERE id=?", (page_id,)).fetchone()
        if principal is None or not principal[0]:
            raise PermissionError("forbidden: create mode is off")
        row = db.execute(
            """SELECT t.id, t.owner_page_id, v.version, v.bundle
               FROM tool t JOIN page_tool pt ON pt.tool_id=t.id
               JOIN tool_version v ON v.tool_id=t.id AND v.version=pt.active_version
               WHERE t.owner_page_id=? AND t.name=? AND pt.page_id=?""",
            (page_id, tool_name, page_id),
        ).fetchone()
        if row is None:
            raise PermissionError("forbidden: tool is not assigned to this page")
        bundle = validate_bundle(json.loads(row["bundle"]))
        _check(Draft202012Validator(bundle["input_schema"]), arguments, "tool input")
        implementation = bundle["implementation"]
        collection = implementation["collection"]
        operation = implementation["operation"]
        schema = Draft202012Validator(implementation["data_schema"])
        if operation == "insert":
            document = arguments
            _check(schema, document, "record")
            record_id = str(arguments.get("id") or secrets.token_hex(12))
            db.execute(
                "INSERT INTO page_record(page_id,collection,record_id,version,document,"
                "created_at,updated_at) VALUES(?,?,?,?,?,?,?)",
                (
                    page_id,
                    collection,
                    record_id,
                    row["version"],
                    json.dumps(document, sort_keys=True),
                    now(),
                    now(),
                ),
            )
            result = {"record_id": record_id, **document}
        elif operation == "get":
            record_id = arguments.get("record_id")
            found = db.execute(
                "SELECT document FROM page_record WHERE page_id=? AND collection=? AND record_id=?",
                (page_id, collection, record_id),
            ).fetchone()
            result = json.loads(found[0]) if found else None
        elif operation == "list":
            found = db.execute(
                "SELECT record_id,document FROM page_record WHERE page_id=? "
                "AND collection=? ORDER BY created_at",
                (page_id, collection),
            ).fetchall()
            result = [{"record_id": item[0], **json.loads(item[1])} for item in found]
        else:
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
                    row["version"],
                    json.dumps(document, sort_keys=True),
                    now(),
                    page_id,
                    collection,
                    record_id,
                ),
            )
            result = {"record_id": record_id, **document}
        _check(Draft202012Validator(bundle["output_schema"]), result, "tool output")
        db.commit()
        return result
    except Exception:
        db.rollback()
        raise
