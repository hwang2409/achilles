import json
from concurrent.futures import ThreadPoolExecutor

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
        results = list(
            pool.map(
                lambda item: item[0](item[1]),
                [(write_record, i) for i in range(20)] + [(write_page, i) for i in range(20)],
            )
        )
    assert len(results) == 40
    with store._connect() as db:
        assert db.execute("SELECT COUNT(*) FROM page_record").fetchone()[0] == 20

    store.set_create_mode("home", False)
    with pytest.raises(PermissionError):
        call_record(store, "home", "annotate_trace", {"text": "late"})
    with store._connect() as db:
        assert db.execute("SELECT COUNT(*) FROM page_record").fetchone()[0] == 20


def test_bundle_is_canonical_and_private(tmp_path):
    store = PageStore(tmp_path)
    store.set_create_mode("home", True)
    _, digest = store.create_tool("home", BUNDLE)
    path = tmp_path / "bundles" / f"{digest}.json"
    assert path.stat().st_mode & 0o777 == 0o600
    assert json.loads(path.read_text())["name"] == "annotate_trace"
