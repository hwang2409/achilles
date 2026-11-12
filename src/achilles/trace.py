from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any


@dataclass(frozen=True)
class TraceBundle:
    schema: str
    runs: tuple[dict[str, Any], ...]
    root: dict[str, Any]

    def as_dict(self) -> dict[str, Any]:
        return {"schema": self.schema, "runs": list(self.runs)}


def load_fixture(path: Path) -> TraceBundle:
    data = json.loads(path.read_text())
    if (
        not isinstance(data, dict)
        or set(data) != {"schema", "runs"}
        or data["schema"] != "zeta.trace.v1"
    ):
        raise ValueError("invalid trace envelope")
    runs = data["runs"]
    if not isinstance(runs, list) or not runs:
        raise ValueError("trace runs must be nonempty")
    ids: set[str] = set()
    for run in runs:
        if not isinstance(run, dict) or set(run) != {
            "source_run_id",
            "parent_run_id",
            "started_at",
            "completed_at",
            "messages",
            "tool_calls",
            "usage",
            "outcome",
        }:
            raise ValueError("invalid trace run")
        rid = run["source_run_id"]
        if not isinstance(rid, str) or not rid or rid in ids:
            raise ValueError("invalid run id")
        ids.add(rid)
        if (
            not isinstance(run["started_at"], str)
            or not isinstance(run["completed_at"], str)
            or run["completed_at"] < run["started_at"]
        ):
            raise ValueError("invalid timestamps")
        if run["parent_run_id"] is not None and run["parent_run_id"] not in ids | {
            r["source_run_id"] for r in runs
        }:
            raise ValueError("invalid parent")
        if (
            run["outcome"] not in {"failed", "completed"}
            or not isinstance(run["usage"], dict)
            or set(run["usage"]) != {"input_tokens", "output_tokens"}
            or any(not isinstance(v, int) or v < 0 for v in run["usage"].values())
        ):
            raise ValueError("invalid run fields")
        seqs: list[int] = []
        for msg in run["messages"]:
            if (
                not isinstance(msg, dict)
                or set(msg) != {"sequence", "id", "role", "content"}
                or not isinstance(msg["sequence"], int)
                or not msg["id"]
                or not isinstance(msg["content"], list)
            ):
                raise ValueError("invalid message")
            for block in msg["content"]:
                if (
                    not isinstance(block, dict)
                    or set(block) != {"type", "text"}
                    or not isinstance(block["text"], str)
                ):
                    raise ValueError("invalid content")
            seqs.append(msg["sequence"])
        for tool in run["tool_calls"]:
            if (
                not isinstance(tool, dict)
                or set(tool) != {"sequence", "id", "name", "arguments", "result"}
                or not isinstance(tool["sequence"], int)
                or not tool["id"]
                or not isinstance(tool["arguments"], dict)
                or not isinstance(tool["result"], dict)
                or set(tool["result"]) != {"sequence", "content", "is_error"}
            ):
                raise ValueError("invalid tool")
            seqs.extend([tool["sequence"], tool["result"]["sequence"]])
        if len(seqs) != len(set(seqs)):
            raise ValueError("sequences must be unique")
    roots = [r for r in runs if r["parent_run_id"] is None]
    if len(roots) != 1 or any(
        r["parent_run_id"] not in ids for r in runs if r["parent_run_id"] is not None
    ):
        raise ValueError("invalid roots")
    return TraceBundle(data["schema"], tuple(runs), roots[0])


def digest(bundle: TraceBundle) -> str:
    return hashlib.sha256(
        json.dumps(bundle.as_dict(), sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()
