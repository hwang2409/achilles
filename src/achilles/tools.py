from __future__ import annotations

import hashlib
import json
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
    "output_schema": _JSON_SCHEMA,
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
    "required": list(_TOOL_BUNDLE_PROPERTIES),
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


def validate_bundle(bundle: Any, prefix: str = "") -> dict[str, Any]:
    validate_schema(bundle, TOOL_BUNDLE_SCHEMA, prefix)
    for key in ("input_schema", "output_schema"):
        _validate_json_schema(bundle[key], f"{prefix}/{key}")
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
    if len(canonical_bundle(bundle)) > MAX_BUNDLE_BYTES:
        raise ValidationError(prefix, f"serialized size <= {MAX_BUNDLE_BYTES} bytes")
    return bundle


def canonical_bundle(bundle: dict[str, Any]) -> str:
    return json.dumps(bundle, sort_keys=True, separators=(",", ":"))


def bundle_digest(bundle: dict[str, Any]) -> str:
    return hashlib.sha256(canonical_bundle(bundle).encode()).hexdigest()
