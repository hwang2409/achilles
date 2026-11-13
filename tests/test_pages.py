import pytest

from achilles.pages import PageStore, validate_layout


def test_layout_rejects_unknown_key() -> None:
    with pytest.raises(ValueError, match="invalid keys"):
        validate_layout({"blocks": [{"type": "text", "text": "ok", "extra": True}]})


def test_layout_rejects_unknown_tool_reference() -> None:
    with pytest.raises(ValueError, match="unknown tool reference"):
        validate_layout({"blocks": [{"type": "form", "title": "x", "tool": "other-page"}]})


def test_create_page_commits_layout_and_audit(tmp_path) -> None:
    store = PageStore(tmp_path)
    store.set_create_mode("home", True)
    page, digest = store.create_page(
        "/reports", "reports", {"blocks": [{"type": "text", "text": "hello"}]}
    )
    assert page["route"] == "/reports"
    assert store.db.execute("SELECT digest FROM layout_version").fetchone()[0] == digest
    assert store.db.execute("SELECT action FROM audit").fetchone()[0] == "create_page"
    assert (tmp_path / "bundles" / f"{digest}.json").exists()


def test_save_session_compare_and_set_has_one_winner(tmp_path, monkeypatch):
    import threading

    store = PageStore(tmp_path)
    barrier = threading.Barrier(2)
    original = store._connect

    def connect():
        db = original()
        db.set_trace_callback(
            lambda statement: (
                barrier.wait(timeout=5) if statement.startswith("SELECT zeta_session_id") else None
            )
        )
        return db

    monkeypatch.setattr(store, "_connect", connect)
    results = []
    threads = [
        threading.Thread(
            target=lambda sid: results.append(store.save_session("home", None, sid)),
            args=(sid,),
        )
        for sid in ("a", "b")
    ]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    assert sorted(result[0] for result in results) == [False, True]
