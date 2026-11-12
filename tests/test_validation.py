from __future__ import annotations

import copy
import json
from pathlib import Path

import pytest

from achilles.trace import load_fixture

FIXTURE = Path("fixtures/one-trace/trace.json")


@pytest.mark.parametrize(
    "mutation",
    [
        lambda x: x["runs"][0].__setitem__("started_at", "not-a-time"),
        lambda x: x["runs"][0]["messages"][0].__setitem__("role", 1),
        lambda x: x["runs"][0]["usage"].__setitem__("input_tokens", True),
        lambda x: x["runs"][1].__setitem__("parent_run_id", "missing"),
        lambda x: x["runs"][0]["tool_calls"][0]["result"].__setitem__("is_error", "no"),
    ],
    ids=["timestamp", "role", "bool-int", "parent", "result"],
)
def test_trace_loader_rejects_minimal_mutations(tmp_path: Path, mutation) -> None:
    changed = copy.deepcopy(json.loads(FIXTURE.read_text()))
    mutation(changed)
    path = tmp_path / "trace.json"
    path.write_text(json.dumps(changed))
    with pytest.raises(ValueError):
        load_fixture(path)
