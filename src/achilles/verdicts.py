from __future__ import annotations

import hashlib
import json
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

from .config import Manifest
from .judges import judge
from .trace import TraceBundle, digest


def connect(path: Path) -> sqlite3.Connection:
    db = sqlite3.connect(path)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA foreign_keys=ON")
    db.execute("PRAGMA journal_mode=WAL")
    db.execute("PRAGMA user_version=1")
    db.executescript(
        """CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, source_schema TEXT NOT NULL, source_run_id TEXT NOT NULL, trace_digest TEXT NOT NULL, trace_json TEXT NOT NULL, completed_at TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(source_schema,source_run_id)); CREATE TABLE IF NOT EXISTS verdicts (id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), product TEXT NOT NULL, judge_id TEXT NOT NULL, judge_version INTEGER NOT NULL, kind TEXT NOT NULL CHECK(kind='fixture'), verdict_json TEXT NOT NULL, urgent INTEGER NOT NULL CHECK(urgent IN (0,1)), created_at TEXT NOT NULL, UNIQUE(product,run_id,judge_id,judge_version)); CREATE TABLE IF NOT EXISTS deliveries (id TEXT PRIMARY KEY, verdict_id TEXT NOT NULL REFERENCES verdicts(id), notify_key TEXT NOT NULL UNIQUE, request_json TEXT NOT NULL, outcome TEXT NOT NULL, response_json TEXT, attempted_at TEXT, UNIQUE(verdict_id));"""  # noqa: E501
    )
    return db


def prepare(path: Path, manifest: Manifest, bundle: TraceBundle) -> tuple[dict, bool]:
    db = connect(path)
    now = datetime.now(timezone.utc).isoformat()
    run_id = hashlib.sha256(
        (bundle.schema + "\0" + bundle.root["source_run_id"]).encode()
    ).hexdigest()
    td = digest(bundle)
    canonical = json.dumps(bundle.as_dict(), sort_keys=True, separators=(",", ":"))
    db.execute("BEGIN IMMEDIATE")
    row = db.execute("SELECT * FROM runs WHERE id=?", (run_id,)).fetchone()
    if row and row["trace_digest"] != td:
        raise ValueError("source run changed")
    if not row:
        db.execute(
            "INSERT INTO runs VALUES (?,?,?,?,?,?,?)",
            (
                run_id,
                bundle.schema,
                bundle.root["source_run_id"],
                td,
                canonical,
                bundle.root["completed_at"],
                now,
            ),
        )
    verdict = judge(manifest, bundle)
    vid = hashlib.sha256(
        f"{manifest.product}\0{run_id}\0{manifest.judge.id}\0{manifest.judge.version}".encode()
    ).hexdigest()
    vrow = db.execute("SELECT * FROM verdicts WHERE id=?", (vid,)).fetchone()
    if not vrow:
        db.execute(
            "INSERT INTO verdicts VALUES (?,?,?,?,?,?,?,?,?)",
            (
                vid,
                run_id,
                manifest.product,
                manifest.judge.id,
                manifest.judge.version,
                manifest.judge.kind,
                json.dumps(verdict),
                int(verdict["urgent"]),
                now,
            ),
        )
    key = "verdict:" + vid
    drow = db.execute("SELECT * FROM deliveries WHERE verdict_id=?", (vid,)).fetchone()
    if not drow:
        db.execute(
            "INSERT INTO deliveries(id,verdict_id,notify_key,request_json,outcome) VALUES(?,?,?,?,?)",  # noqa: E501
            (
                vid,
                vid,
                key,
                json.dumps(
                    {
                        "version": 1,
                        "key": key,
                        "text": verdict["label"] + ": " + bundle.root["source_run_id"],
                        "not_after": 1794450000,
                        "priority": "normal",
                    }
                ),
                "pending",
            ),
        )
    db.commit()
    return {
        "run_id": run_id,
        "verdict_id": vid,
        "request": json.loads(
            (drow or db.execute("SELECT * FROM deliveries WHERE verdict_id=?", (vid,)).fetchone())[
                "request_json"
            ]
        ),
        "outcome": (
            drow or db.execute("SELECT * FROM deliveries WHERE verdict_id=?", (vid,)).fetchone()
        )["outcome"],
    }, drow is None or (drow and drow["outcome"] == "pending")


def complete(path: Path, vid: str, outcome: str, response: dict) -> None:
    db = connect(path)
    db.execute("BEGIN IMMEDIATE")
    db.execute(
        "UPDATE deliveries SET outcome=?,response_json=?,attempted_at=? WHERE verdict_id=? AND outcome='pending'",  # noqa: E501
        (outcome, json.dumps(response), datetime.now(timezone.utc).isoformat(), vid),
    )
    db.commit()


def counts(path: Path) -> tuple[int, int, int]:
    db = connect(path)
    return tuple(db.execute("SELECT COUNT(*) FROM runs").fetchone()[0] for _ in [0]) + (
        db.execute("SELECT COUNT(*) FROM verdicts").fetchone()[0],
        db.execute(
            "SELECT COUNT(*) FROM deliveries WHERE outcome IN ('sent','duplicate')"
        ).fetchone()[0],
    )


def list_verdicts(path: Path) -> list[dict]:
    db = connect(path)
    rows = db.execute(
        "SELECT v.*,d.outcome,d.response_json,r.trace_json FROM verdicts v JOIN deliveries d ON d.verdict_id=v.id JOIN runs r ON r.id=v.run_id ORDER BY v.created_at DESC"  # noqa: E501
    ).fetchall()
    out = []
    for r in rows:
        x = dict(r)
        x["verdict"] = json.loads(x.pop("verdict_json"))
        x.pop("trace_json")
        out.append(
            {
                "id": x["id"],
                "product": x["product"],
                "judge_id": x["judge_id"],
                "judge_version": x["judge_version"],
                "run_id": x["run_id"],
                "delivery_outcome": x["outcome"],
                **x["verdict"],
            }
        )
    return out


def detail(path: Path, vid: str) -> dict | None:
    db = connect(path)
    r = db.execute(
        "SELECT v.*,d.outcome,d.response_json,r.trace_json FROM verdicts v JOIN deliveries d ON d.verdict_id=v.id JOIN runs r ON r.id=v.run_id WHERE v.id=?",  # noqa: E501
        (vid,),
    ).fetchone()
    if not r:
        return None
    x = dict(r)
    verdict = json.loads(x.pop("verdict_json"))
    x["trace"] = json.loads(x.pop("trace_json"))
    x["delivery_outcome"] = x.pop("outcome")
    x.pop("response_json")
    return {**x, **verdict}
