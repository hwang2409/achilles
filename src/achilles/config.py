from __future__ import annotations

import tomllib
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class JudgeConfig:
    id: str
    version: int
    kind: str
    urgent: str


@dataclass(frozen=True)
class Manifest:
    product: str
    judge: JudgeConfig


def load_manifest(path: Path) -> Manifest:
    data = tomllib.loads(path.read_text())
    if (
        set(data) != {"schema", "product", "trace_sources", "judges"}
        or data["schema"] != 1
        or data["trace_sources"] != ["fixture"]
        or not isinstance(data["judges"], list)
        or len(data["judges"]) != 1
    ):
        raise ValueError("invalid manifest")
    judge = data["judges"][0]
    if (
        not isinstance(data["product"], str)
        or not data["product"]
        or type(data["schema"]) is not int
        or set(judge) != {"id", "version", "kind", "urgent"}
        or not isinstance(judge["id"], str)
        or not judge["id"]
        or type(judge["version"]) is not int
        or judge["version"] < 0
        or judge["kind"] != "fixture"
        or judge["urgent"] != "always"
    ):
        raise ValueError("invalid judge")
    return Manifest(data["product"], JudgeConfig(**judge))
