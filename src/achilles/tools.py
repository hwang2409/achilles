from __future__ import annotations

import hashlib
import json
from copy import deepcopy
from typing import Any

from jsonschema import Draft202012Validator

from .validation import ValidationError, validate_schema

MAX_SCHEMA_BYTES = 16_384
MAX_BUNDLE_BYTES = 64 * 1024
MAX_DESCRIPTION = 2_000
_NAME_PATTERN = r"^[a-z][a-z0-9_]{0,63}$"
_OPERATIONS = ["list", "get", "insert", "update"]
_RESERVED_NAMES = ["create_page", "create_tool"]

_JSON_SCHEMA = {
    "type": "object",
    "description": f"valid JSON Schema; serialized size <= {MAX_SCHEMA_BYTES // 1024} KB",
}
_TOOL_BUNDLE_PROPERTIES = {
    "format_version": {"const": 1},
    "kind": {"const": "data_operation"},
    "name": {
        "type": "string",
        "pattern": _NAME_PATTERN,
        "not": {"enum": _RESERVED_NAMES},
    },
    "description": {"type": "string", "minLength": 1, "maxLength": MAX_DESCRIPTION},
    "input_schema": _JSON_SCHEMA,
    "output_schema": {
        **_JSON_SCHEMA,
        "description": (
            "optional; when present, must exactly match the result schema "
            "derived from the operation"
        ),
    },
    "implementation": {
        "type": "object",
        "properties": {
            "operation": {"enum": _OPERATIONS},
            "collection": {"type": "string", "pattern": _NAME_PATTERN},
            "data_schema": _JSON_SCHEMA,
        },
        "required": ["operation", "collection", "data_schema"],
        "additionalProperties": False,
    },
}
TOOL_BUNDLE_SCHEMA = {
    "type": "object",
    "properties": _TOOL_BUNDLE_PROPERTIES,
    "required": [key for key in _TOOL_BUNDLE_PROPERTIES if key != "output_schema"],
    "additionalProperties": False,
    "description": (
        f"immutable page-owned declarative tool; bundle <= {MAX_BUNDLE_BYTES // 1024} KB; "
        "nested schemas must be valid JSON Schema"
    ),
}
CREATE_TOOL_SCHEMA = {
    "type": "object",
    "properties": {"bundle": TOOL_BUNDLE_SCHEMA},
    "required": ["bundle"],
    "additionalProperties": False,
}


def _validate_json_schema(value: dict[str, Any], path: str) -> None:
    if len(json.dumps(value, separators=(",", ":"))) > MAX_SCHEMA_BYTES:
        raise ValidationError(path, f"serialized size <= {MAX_SCHEMA_BYTES} bytes")
    try:
        Draft202012Validator.check_schema(value)
    except Exception as exc:
        raise ValidationError(path, "valid JSON Schema") from exc


def derived_output_schema(bundle: dict[str, Any]) -> dict[str, Any]:
    operation = bundle["implementation"]["operation"]
    record = deepcopy(bundle["implementation"]["data_schema"])
    record["type"] = "object"
    record["properties"] = {
        **record.get("properties", {}),
        "record_id": {"type": "string"},
    }
    record["required"] = [
        *[key for key in record.get("required", []) if key != "record_id"],
        "record_id",
    ]
    if operation == "list":
        return {"type": "array", "items": record}
    if operation == "get":
        return {"anyOf": [record, {"type": "null"}]}
    return record


def _derived_output_expectation(operation: str) -> str:
    if operation == "list":
        return "derived list result: array of objects with required record_id and collection fields"
    if operation == "get":
        return "derived get result: object with required record_id and collection fields, or null"
    return f"derived {operation} result: object with required record_id and collection fields"


def validate_bundle(
    bundle: Any, prefix: str = "", *, reject_conflicting_output: bool = False
) -> dict[str, Any]:
    validate_schema(bundle, TOOL_BUNDLE_SCHEMA, prefix)
    _validate_json_schema(bundle["input_schema"], f"{prefix}/input_schema")
    if "output_schema" in bundle:
        _validate_json_schema(bundle["output_schema"], f"{prefix}/output_schema")
    _validate_json_schema(
        bundle["implementation"]["data_schema"], f"{prefix}/implementation/data_schema"
    )
    output_schema = derived_output_schema(bundle)
    if reject_conflicting_output and bundle.get("output_schema", output_schema) != output_schema:
        operation = bundle["implementation"]["operation"]
        raise ValidationError(f"{prefix}/output_schema", _derived_output_expectation(operation))
    bundle = {**bundle, "output_schema": output_schema}
    if len(canonical_bundle(bundle)) > MAX_BUNDLE_BYTES:
        raise ValidationError(prefix, f"serialized size <= {MAX_BUNDLE_BYTES} bytes")
    return bundle


def canonical_bundle(bundle: dict[str, Any]) -> str:
    return json.dumps(bundle, sort_keys=True, separators=(",", ":"))


def bundle_digest(bundle: dict[str, Any]) -> str:
    return hashlib.sha256(canonical_bundle(bundle).encode()).hexdigest()
