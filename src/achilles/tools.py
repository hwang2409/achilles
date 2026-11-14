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
BUILTIN_TOOL_NAMES = ("inspect_page", "create_page", "create_tool")
_RESERVED_NAMES = BUILTIN_TOOL_NAMES

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


def derived_output_schema(bundle: dict[str, Any]) -> tuple[dict[str, Any], bool]:
    operation = bundle["implementation"]["operation"]
    record = deepcopy(bundle["implementation"]["data_schema"])
    record["type"] = "object"
    record["properties"] = {
        **record.get("properties", {}),
        "record_id": {"type": "string"},
        "revision": {"type": "integer"},
    }
    record["required"] = [
        *[key for key in record.get("required", []) if key not in {"record_id", "revision"}],
        "record_id",
        "revision",
    ]
    if operation == "list":
        return {"type": "array", "items": record}, False
    if operation == "get":
        return {"anyOf": [record, {"type": "null"}]}, False
    return record, True


def _derived_output_expectation(operation: str) -> str:
    if operation == "list":
        return "derived list result: array of records with required record_id and revision"
    if operation == "get":
        return "derived get result: record with required record_id and revision, or null"
    return f"derived {operation} result: record with required record_id and revision"


def _normalize_schema(schema: Any) -> Any:
    if not isinstance(schema, dict):
        return schema
    normalized = {**schema}
    required = schema.get("required")
    if isinstance(required, list) and all(isinstance(item, str) for item in required):
        normalized["required"] = frozenset(required)
    properties = schema.get("properties")
    if isinstance(properties, dict):
        normalized["properties"] = {
            name: _normalize_schema(child) for name, child in properties.items()
        }
    for key in ("items", "additionalProperties"):
        child = schema.get(key)
        if isinstance(child, dict):
            normalized[key] = _normalize_schema(child)
    for key in ("allOf", "anyOf", "oneOf"):
        children = schema.get(key)
        if isinstance(children, list):
            normalized[key] = [_normalize_schema(child) for child in children]
    return normalized


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
    if bundle["implementation"]["operation"] == "update":
        input_schema = bundle["input_schema"]
        revision = input_schema.get("properties", {}).get("revision", {})
        if (
            not isinstance(revision, dict)
            or revision.get("type") != "integer"
            or "revision" not in input_schema.get("required", [])
        ):
            raise ValidationError(f"{prefix}/input_schema", "required integer property: revision")
    output_schema, _ = derived_output_schema(bundle)
    if reject_conflicting_output and _normalize_schema(
        bundle.get("output_schema", output_schema)
    ) != _normalize_schema(output_schema):
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
