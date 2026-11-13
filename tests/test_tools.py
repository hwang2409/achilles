import json
from concurrent.futures import ThreadPoolExecutor, wait

import pytest

from achilles.pages import PageStore
from achilles.records import call_record

BUNDLE = {
    "format_version": 1,
    "kind": "data_operation",
    "name": "annotate_trace",
    "description": "add an annotation",
    "input_schema": {
        "type": "object",
        "properties": {"text": {"type": "string"}},
        "required": ["text"],
        "additionalProperties": False,
    },
    "output_schema": {"type": "object"},
    "implementation": {
        "operation": "insert",
        "collection": "annotations",
        "data_schema": {
            "type": "object",
            "properties": {"text": {"type": "string"}},
            "required": ["text"],
            "additionalProperties": False,
        },
    },
}


def test_sqlite_is_owned_by_pages_module():
    source_root = __import__("pathlib").Path(__file__).parents[1] / "src"
    offenders = [
        path
        for path in source_root.rglob("*.py")
        if path.name != "pages.py" and "import sqlite3" in path.read_text()
    ]
    assert not offenders, "keep sqlite3 ownership in src/achilles/pages.py"


def test_generated_tool_versions_and_page_scope(tmp_path):
    store = PageStore(tmp_path)
    store.set_create_mode("home", True)
    created, _ = store.create_tool("home", BUNDLE)
    assert created["version"] == 1
    assert call_record(store, "home", "annotate_trace", {"text": "one"})["text"] == "one"
    with store._connect() as db:
        assert len(db.execute("SELECT * FROM page_record").fetchall()) == 1
    version_two = {
        **BUNDLE,
        "input_schema": {
            "type": "object",
            "properties": {"label": {"type": "string"}},
            "required": ["label"],
            "additionalProperties": False,
        },
    }
    updated, _ = store.create_tool("home", version_two)
    assert updated["version"] == 2
    store.rollback_tool("home", "annotate_trace", 1)
    assert store.page_tools("home")[0]["version"] == 1
    store.set_create_mode("home", False)
    with pytest.raises(PermissionError):
        call_record(store, "home", "annotate_trace", {"text": "late"})


def test_concurrent_record_and_page_writes_are_isolated(tmp_path):
    store = PageStore(tmp_path)
    store.set_create_mode("home", True)
    store.create_tool("home", BUNDLE)

    def write_record(index):
        return call_record(store, "home", "annotate_trace", {"text": str(index)})

    def write_page(index):
        return store.save_session(
            "home", None if index == 0 else f"session-{index - 1}", f"session-{index}"
        )

    with ThreadPoolExecutor(max_workers=8) as pool:
        futures = [
            pool.submit(operation, index)
            for operation, index in [(write_record, i) for i in range(20)]
            + [(write_page, i) for i in range(20)]
        ]
        done, pending = wait(futures, timeout=10)
        if pending:
            for future in pending:
                future.cancel()
            # sqlite's five-second busy timeout drains workers after a bounded wait.
            pool.shutdown(wait=True, cancel_futures=True)
            pytest.fail("concurrent operation exceeded 10-second deadline")
        outcomes = [future.exception() for future in done]
    assert not [error for error in outcomes if error], f"worker failed: {outcomes}"
    assert len(done) == 40, "expected 40 successful operations"
    with store._connect() as db:
        assert db.execute("SELECT COUNT(*) FROM page_record").fetchone()[0] == 20

    store.set_create_mode("home", False)
    with pytest.raises(PermissionError):
        call_record(store, "home", "annotate_trace", {"text": "late"})
    with store._connect() as db:
        assert db.execute("SELECT COUNT(*) FROM page_record").fetchone()[0] == 20


def test_reserved_bundle_names_are_rejected(tmp_path):
    store = PageStore(tmp_path)
    store.set_create_mode("home", True)
    for name in ("create_page", "create_tool"):
        with pytest.raises(ValueError, match="reserved"):
            store.create_tool("home", {**BUNDLE, "name": name})


def test_record_id_is_authoritative(tmp_path):
    store = PageStore(tmp_path)
    store.set_create_mode("home", True)
    bundle = {
        **BUNDLE,
        "input_schema": {
            **BUNDLE["input_schema"],
            "properties": {
                "text": {"type": "string"},
                "record_id": {"type": "string"},
            },
        },
        "implementation": {
            **BUNDLE["implementation"],
            "data_schema": {
                **BUNDLE["implementation"]["data_schema"],
                "properties": {
                    "text": {"type": "string"},
                    "record_id": {"type": "string"},
                },
            },
        },
    }
    store.create_tool("home", bundle)
    result = call_record(store, "home", "annotate_trace", {"text": "x", "record_id": "forged"})
    assert result["record_id"] != "forged"
    second = call_record(store, "home", "annotate_trace", {"text": "y", "record_id": "forged"})
    assert second["record_id"] != "forged"


def test_bundle_publish_cleans_stale_temp(tmp_path):
    store = PageStore(tmp_path)
    store.set_create_mode("home", True)
    digest = __import__("achilles.tools", fromlist=["bundle_digest"]).bundle_digest(BUNDLE)
    (tmp_path / "bundles" / f"{digest}.tmp").write_text("stale")
    error = None
    try:
        store.create_tool("home", BUNDLE)
    except Exception as exc:  # assert the old failure at a behavior boundary
        error = exc
    assert error is None, f"bundle publication failed: {error}"
    assert (tmp_path / "bundles" / f"{digest}.json").exists()


def test_bundle_is_canonical_and_private(tmp_path):
    store = PageStore(tmp_path)
    store.set_create_mode("home", True)
    _, digest = store.create_tool("home", BUNDLE)
    path = tmp_path / "bundles" / f"{digest}.json"
    assert path.stat().st_mode & 0o777 == 0o600
    assert json.loads(path.read_text())["name"] == "annotate_trace"
