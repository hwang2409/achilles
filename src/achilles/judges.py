from __future__ import annotations

from .config import Manifest
from .trace import TraceBundle


def judge(manifest: Manifest, bundle: TraceBundle) -> dict:
    if manifest.judge.kind != "fixture":
        raise ValueError("unsupported judge")
    if bundle.root["outcome"] != "failed":
        return {"label": "fixture pass", "score": 0, "urgent": False, "evidence_ids": []}
    return {
        "label": "fixture failure",
        "score": 1,
        "urgent": True,
        "evidence_ids": [r["source_run_id"] for r in bundle.runs],
    }
