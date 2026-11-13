import sqlite3

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
    with store.transaction() as db:
        assert db.execute("SELECT digest FROM layout_version").fetchone()[0] == digest
        assert db.execute("SELECT action FROM audit").fetchone()[0] == "create_page"
    assert (tmp_path / "bundles" / f"{digest}.json").exists()


def test_existing_page_session_is_copied_to_chat_once(tmp_path) -> None:
    database = tmp_path / "achilles.sqlite3"
    with sqlite3.connect(database) as db:
        db.execute(
            "CREATE TABLE page (id TEXT PRIMARY KEY, route TEXT NOT NULL UNIQUE, "
            "title TEXT NOT NULL, zeta_session_id TEXT, active_layout_version INTEGER, "
            "created_at TEXT NOT NULL, updated_at TEXT NOT NULL, "
            "create_mode INTEGER NOT NULL DEFAULT 0, credential_hash TEXT)"
        )
        db.execute(
            "INSERT INTO page VALUES (?,?,?,?,?,?,?,?,?)",
            (
                "existing",
                "/existing",
                "existing",
                "session-old",
                None,
                "created",
                "updated",
                0,
                None,
            ),
        )
        db.execute("PRAGMA user_version = 3")
    PageStore(tmp_path)
    PageStore(tmp_path)
    with sqlite3.connect(database) as db:
        assert db.execute(
            "SELECT session_id,page_id,created_at,updated_at FROM chat "
            "WHERE session_id='session-old'"
        ).fetchall() == [("session-old", "existing", "created", "updated")]


def test_save_session_compare_and_set_has_one_winner(tmp_path):
    import threading

    for round_number in range(50):
        store = PageStore(tmp_path / str(round_number))
        barrier = threading.Barrier(2)
        results = []
        errors = []

        def save(session_id):
            try:
                barrier.wait(timeout=10)
                results.append((session_id, *store.save_session("home", None, session_id)))
            except BaseException as error:
                errors.append(error)

        threads = [threading.Thread(target=save, args=(sid,)) for sid in ("a", "b")]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=10)

        assert not any(thread.is_alive() for thread in threads), "save_session thread hung"
        assert not errors
        assert sorted(result[1] for result in results) == [False, True]
        winner = next(result for result in results if result[1])
        assert all(result[2] == winner[0] for result in results)
        with store.transaction() as db:
            assert [tuple(row) for row in db.execute("SELECT session_id,page_id FROM chat")] == [
                (winner[0], "home")
            ]
