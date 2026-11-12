import pytest

from achilles.pages import PageStore, validate_layout


def test_layout_rejects_unknown_key() -> None:
    with pytest.raises(ValueError, match="invalid keys"):
        validate_layout({"blocks": [{"type": "text", "text": "ok", "extra": True}]})


def test_create_page_commits_layout_and_audit(tmp_path) -> None:
    store = PageStore(tmp_path)
    page, digest = store.create_page(
        "/reports", "reports", {"blocks": [{"type": "text", "text": "hello"}]}
    )
    assert page["route"] == "/reports"
    assert store.db.execute("SELECT digest FROM layout_version").fetchone()[0] == digest
    assert store.db.execute("SELECT action FROM audit").fetchone()[0] == "create_page"
    assert (tmp_path / "bundles" / f"{digest}.json").exists()
