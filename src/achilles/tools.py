from __future__ import annotations

import hashlib
import json
import re
from typing import Any

from jsonschema import Draft202012Validator

MAX_SCHEMA_BYTES = 16_384
MAX_DESCRIPTION = 2_000
_COLLECTION = re.compile(r"^[a-z][a-z0-9_]{0,63}$")
_NAME = re.compile(r"^[a-z][a-z0-9_]{0,63}$")


class ValidationError(ValueError):
    def __init__(self, code: str, path: str, expected: str, message: str | None = None):
        self.code, self.path, self.expected = code, path, expected
        super().__init__(message or expected)


_JSON_SCHEMA = {
    "type": "object",
    "description": "a JSON Schema describing the fields and their types",
}
_TOOL_BUNDLE_PROPERTIES = {
    "format_version": {"const": 1},
    "kind": {"const": "data_operation"},
    "name": {"type": "string", "pattern": r"^[a-z][a-z0-9_]{0,63}$"},
    "description": {"type": "string", "minLength": 1, "maxLength": MAX_DESCRIPTION},
    "input_schema": _JSON_SCHEMA,
    "output_schema": _JSON_SCHEMA,
    "implementation": {
        "type": "object",
        "properties": {
            "operation": {"enum": ["list", "get", "insert", "update"]},
            "collection": {"type": "string", "pattern": r"^[a-z][a-z0-9_]{0,63}$"},
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
        "immutable page-owned versioned declarative data tool; "
        "operation is one of list, get, insert, update"
    ),
}
CREATE_TOOL_SCHEMA = {
    "type": "object",
    "properties": {"bundle": TOOL_BUNDLE_SCHEMA},
    "required": ["bundle"],
    "additionalProperties": False,
}


def _schema(value: Any, label: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ValueError(f"{label} must be an object")
    if len(json.dumps(value, separators=(",", ":"))) > MAX_SCHEMA_BYTES:
        raise ValueError(f"{label} is too large")
    try:
        Draft202012Validator.check_schema(value)
    except Exception as exc:
        raise ValueError(f"invalid {label}") from exc
    return value


def validate_bundle(bundle: Any) -> dict[str, Any]:
    if not isinstance(bundle, dict):
        raise ValueError("tool bundle must be an object")
    keys = {
        "format_version",
        "kind",
        "name",
        "description",
        "input_schema",
        "output_schema",
        "implementation",
    }
    if set(bundle) != keys:
        raise ValueError("tool bundle has invalid keys")
    if bundle["format_version"] != 1 or bundle["kind"] != "data_operation":
        raise ValueError("unsupported tool bundle")
    if (
        not isinstance(bundle["name"], str)
        or not _NAME.fullmatch(bundle["name"])
        or bundle["name"] in {"create_page", "create_tool"}
    ):
        raise ValueError("invalid or reserved tool name")
    if (
        not isinstance(bundle["description"], str)
        or not bundle["description"]
        or len(bundle["description"]) > MAX_DESCRIPTION
    ):
        raise ValueError("invalid tool description")
    input_schema = _schema(bundle["input_schema"], "input schema")
    output_schema = _schema(bundle["output_schema"], "output schema")
    implementation = bundle["implementation"]
    if not isinstance(implementation, dict) or set(implementation) != {
        "operation",
        "collection",
        "data_schema",
    }:
        raise ValueError("invalid implementation")
    if implementation["operation"] not in {"list", "get", "insert", "update"}:
        raise ValueError("unsupported operation")
    if not isinstance(implementation["collection"], str) or not _COLLECTION.fullmatch(
        implementation["collection"]
    ):
        raise ValueError("invalid collection")
    data_schema = _schema(implementation["data_schema"], "data schema")
    result = {
        "format_version": 1,
        "kind": "data_operation",
        "name": bundle["name"],
        "description": bundle["description"],
        "input_schema": input_schema,
        "output_schema": output_schema,
        "implementation": {
            "operation": implementation["operation"],
            "collection": implementation["collection"],
            "data_schema": data_schema,
        },
    }
    encoded = canonical_bundle(result)
    if len(encoded) > 64 * 1024:
        raise ValueError("tool bundle is too large")
    return result


def canonical_bundle(bundle: dict[str, Any]) -> str:
    return json.dumps(bundle, sort_keys=True, separators=(",", ":"))


def bundle_digest(bundle: dict[str, Any]) -> str:
    return hashlib.sha256(canonical_bundle(bundle).encode()).hexdigest()
