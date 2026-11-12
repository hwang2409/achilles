import pytest

from achilles.pages import PageStore, validate_layout
from achilles.records import call_record


def test_layout_rejects_unknown_key() -> None:
    with pytest.raises(ValueError, match="invalid keys"):
        validate_layout({"blocks": [{"type": "text", "text": "ok", "extra": True}]})


def test_layout_rejects_unknown_tool_reference() -> None:
    with pytest.raises(ValueError, match="unknown tool reference"):
        validate_layout({"blocks": [{"type": "form", "title": "x", "tool": "other-page"}]})


def test_create_tool_inserts_page_scoped_record(tmp_path) -> None:
    store = PageStore(tmp_path)
    bundle = {
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
            "collection": "trace_annotations",
            "data_schema": {
                "type": "object",
                "properties": {"text": {"type": "string"}},
                "required": ["text"],
                "additionalProperties": False,
            },
        },
    }
    created, digest = store.create_tool("home", bundle)
    assert created["name"] == "annotate_trace"
    assert len(digest) == 64
    result = call_record(store, "home", "annotate_trace", {"text": "note"})
    assert result["text"] == "note"
    assert store.db.execute("SELECT COUNT(*) FROM page_record").fetchone()[0] == 1
    with pytest.raises(PermissionError):
        call_record(store, "other", "annotate_trace", {"text": "no"})


def test_bundle_digest_cannot_overwrite_different_content(tmp_path) -> None:
    store = PageStore(tmp_path)
    bundle = {
        "format_version": 1,
        "kind": "data_operation",
        "name": "annotate_trace",
        "description": "add an annotation",
        "input_schema": {"type": "object"},
        "output_schema": {"type": "object"},
        "implementation": {
            "operation": "insert",
            "collection": "trace_annotations",
            "data_schema": {"type": "object"},
        },
    }
    _, digest = store.create_tool("home", bundle)
    path = tmp_path / "bundles" / f"{digest}.json"
    path.write_text("different content\n")
    with pytest.raises(ValueError, match="different content"):
        store.create_tool("home", bundle)


def test_create_page_commits_layout_and_audit(tmp_path) -> None:
    store = PageStore(tmp_path)
    page, digest = store.create_page(
        "/reports", "reports", {"blocks": [{"type": "text", "text": "hello"}]}
    )
    assert page["route"] == "/reports"
    assert store.db.execute("SELECT digest FROM layout_version").fetchone()[0] == digest
    assert store.db.execute("SELECT action FROM audit").fetchone()[0] == "create_page"
    assert (tmp_path / "bundles" / f"{digest}.json").exists()
