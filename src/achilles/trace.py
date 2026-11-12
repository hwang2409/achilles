from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any


@dataclass(frozen=True)
class TraceBundle:
    schema: str
    runs: tuple[dict[str, Any], ...]
    root: dict[str, Any]

    def as_dict(self) -> dict[str, Any]:
        return {"schema": self.schema, "runs": list(self.runs)}


def _str(value: Any, name: str) -> str:
    if not isinstance(value, str) or not value:
        raise ValueError(f"invalid {name}")
    return value


def _int(value: Any, name: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise ValueError(f"invalid {name}")
    return value


def _timestamp(value: Any) -> str:
    text = _str(value, "timestamp")
    try:
        datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError as exc:
        raise ValueError("invalid timestamp") from exc
    return text


def _message(message: Any) -> list[int]:
    if not isinstance(message, dict) or set(message) != {"sequence", "id", "role", "content"}:
        raise ValueError("invalid message")
    seq = _int(message["sequence"], "sequence")
    if message["role"] not in {"user", "assistant", "system", "tool"}:
        raise ValueError("invalid role")
    _str(message["id"], "message id")
    if not isinstance(message["content"], list) or not message["content"]:
        raise ValueError("invalid content")
    for block in message["content"]:
        if not isinstance(block, dict) or set(block) != {"type", "text"} or block["type"] != "text":
            raise ValueError("invalid content block")
        _str(block["text"], "text")
    return [seq]


def _tool(tool: Any) -> list[int]:
    if not isinstance(tool, dict) or set(tool) != {"sequence", "id", "name", "arguments", "result"}:
        raise ValueError("invalid tool")
    seq = _int(tool["sequence"], "sequence")
    _str(tool["id"], "tool id")
    _str(tool["name"], "tool name")
    if not isinstance(tool["arguments"], dict):
        raise ValueError("invalid arguments")
    result = tool["result"]
    if not isinstance(result, dict) or set(result) != {"sequence", "content", "is_error"}:
        raise ValueError("invalid result")
    rseq = _int(result["sequence"], "result sequence")
    _str(result["content"], "result content")
    if not isinstance(result["is_error"], bool):
        raise ValueError("invalid result error")
    return [seq, rseq]


def _run(run: Any) -> dict[str, Any]:
    keys = {
        "source_run_id",
        "parent_run_id",
        "started_at",
        "completed_at",
        "messages",
        "tool_calls",
        "usage",
        "outcome",
    }
    if not isinstance(run, dict) or set(run) != keys:
        raise ValueError("invalid trace run")
    _str(run["source_run_id"], "run id")
    if run["parent_run_id"] is not None:
        _str(run["parent_run_id"], "parent")
    start, end = _timestamp(run["started_at"]), _timestamp(run["completed_at"])
    if datetime.fromisoformat(end.replace("Z", "+00:00")) < datetime.fromisoformat(
        start.replace("Z", "+00:00")
    ):
        raise ValueError("invalid timestamps")
    if run["outcome"] not in {"failed", "completed"}:
        raise ValueError("invalid outcome")
    usage = run["usage"]
    if not isinstance(usage, dict) or set(usage) != {"input_tokens", "output_tokens"}:
        raise ValueError("invalid usage")
    _int(usage["input_tokens"], "input tokens")
    _int(usage["output_tokens"], "output tokens")
    if not isinstance(run["messages"], list) or not isinstance(run["tool_calls"], list):
        raise ValueError("invalid events")
    seqs = [s for item in run["messages"] for s in _message(item)] + [
        s for item in run["tool_calls"] for s in _tool(item)
    ]
    if len(seqs) != len(set(seqs)) or sorted(seqs) != list(range(1, len(seqs) + 1)):
        raise ValueError("sequences must increase")
    return run


def load_fixture(path: Path) -> TraceBundle:
    data = json.loads(path.read_text())
    if (
        not isinstance(data, dict)
        or set(data) != {"schema", "runs"}
        or data["schema"] != "zeta.trace.v1"
        or not isinstance(data["runs"], list)
        or not data["runs"]
    ):
        raise ValueError("invalid trace envelope")
    runs = tuple(_run(run) for run in data["runs"])
    ids = {run["source_run_id"] for run in runs}
    if len(ids) != len(runs):
        raise ValueError("duplicate run id")
    roots = [run for run in runs if run["parent_run_id"] is None]
    if len(roots) != 1 or any(
        run["parent_run_id"] is not None and run["parent_run_id"] not in ids for run in runs
    ):
        raise ValueError("invalid roots")
    for run in runs:
        seen: set[str] = set()
        current = run
        while current["parent_run_id"] is not None:
            if current["source_run_id"] in seen:
                raise ValueError("cyclic parent")
            seen.add(current["source_run_id"])
            current = next(
                item for item in runs if item["source_run_id"] == current["parent_run_id"]
            )
        if current is not roots[0]:
            raise ValueError("disconnected run")
    return TraceBundle(data["schema"], runs, roots[0])


def digest(bundle: TraceBundle) -> str:
    return hashlib.sha256(
        json.dumps(bundle.as_dict(), sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()
