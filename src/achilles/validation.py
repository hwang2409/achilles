from __future__ import annotations

import re
from collections.abc import Mapping, Sequence
from typing import Any

from jsonschema import Draft202012Validator
from jsonschema.exceptions import ValidationError as JsonSchemaError

_SAFE_KEY = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")


class ValidationError(ValueError):
    def __init__(self, path: str, expected: str):
        self.code = "invalid_input"
        self.path = path
        self.expected = expected
        super().__init__(expected)


def _pointer(parts: Sequence[Any], schema: Mapping[str, Any]) -> str:
    safe = []
    current: Mapping[str, Any] = schema
    for part in parts:
        if isinstance(part, int):
            safe.append(str(part))
            current = current.get("items", {}) if isinstance(current, Mapping) else {}
            continue
        if not isinstance(part, str) or not _SAFE_KEY.fullmatch(part):
            break
        properties = current.get("properties", {})
        if part not in properties:
            alternatives = current.get("oneOf", current.get("anyOf", ()))
            branch = next(
                (
                    candidate
                    for candidate in alternatives
                    if part in candidate.get("properties", {})
                ),
                None,
            )
            if branch is None:
                break
            current = branch
            properties = current.get("properties", {})
        if part not in properties:
            break
        safe.append(part.replace("~", "~0").replace("/", "~1"))
        current = properties[part]
    return "/" + "/".join(safe) if safe else ""


_FIXED_EXPECTATIONS = {
    "oneOf": "one valid schema variant",
    "additionalProperties": "additional properties not allowed",
}


def _expected(error: JsonSchemaError) -> str:
    keyword = error.validator
    rule = error.validator_value
    if keyword in _FIXED_EXPECTATIONS:
        if keyword == "additionalProperties":
            properties = error.schema.get("properties", {})
            allowed = ", ".join(properties)
            return f"only properties: {allowed}" if allowed else _FIXED_EXPECTATIONS[keyword]
        return _FIXED_EXPECTATIONS[keyword]
    if keyword == "enum":
        return "one of: " + ",".join(str(value) for value in rule)
    if keyword == "const":
        return f"value: {rule}"
    if keyword == "pattern":
        return f"pattern {rule}"
    if keyword == "required":
        return "required property"
    if keyword in {"type", "minLength", "maxLength", "minItems", "maxItems"}:
        return f"{keyword}: {rule}"
    if keyword == "not":
        values = rule.get("enum", []) if isinstance(rule, Mapping) else []
        return "not one of: " + ",".join(str(value) for value in values)
    return str(keyword)


def validate_schema(instance: Any, schema: Mapping[str, Any], prefix: str = "") -> None:
    error = next(iter(Draft202012Validator(schema).iter_errors(instance)), None)
    if error is not None:
        path = prefix.rstrip("/") + _pointer(tuple(error.absolute_path), schema)
        raise ValidationError(path, _expected(error))
