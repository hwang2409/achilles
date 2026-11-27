import shutil
import sqlite3
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest

import achilles.pages as pages
from achilles.pages import PageStore
from achilles.tools import ValidationError

_BUNDLE = {
    "format_version": 1,
    "kind": "data_operation",
    "name": "add_book",
    "description": "add a book",
    "input_schema": {
        "type": "object",
        "properties": {"title": {"type": "string"}},
        "required": ["title"],
        "additionalProperties": False,
    },
    "implementation": {
        "operation": "insert",
        "collection": "books",
        "data_schema": {
            "type": "object",
            "properties": {"title": {"type": "string"}},
            "required": ["title"],
            "additionalProperties": False,
        },
    },
}


def _update_page(store: PageStore) -> str:
    store.set_create_mode("home", True)
    page, _, _, _, _ = store.create_page(
        "/reading",
        "reading",
        {"blocks": [{"type": "list", "title": "books", "collection": "books"}]},
        tools=[_BUNDLE],
    )
    store.set_create_mode(page["id"], True)
    return page["id"]


def test_old_chat_table_defaults_to_chat_purpose(tmp_path) -> None:
    with sqlite3.connect(tmp_path / "achilles.sqlite3") as db:
        db.execute(
            "CREATE TABLE chat (session_id TEXT PRIMARY KEY, page_id TEXT NOT NULL, "
            "title TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_state TEXT, "
            "titled_by_user INTEGER NOT NULL DEFAULT 0, "
            "message_sent INTEGER NOT NULL DEFAULT 1, first_title TEXT)"
        )
        db.execute(
            "INSERT INTO chat(session_id,page_id,created_at,updated_at) "
            "VALUES('old-chat','home','then','then')"
        )
        db.execute("PRAGMA user_version = 3")
    store = PageStore(tmp_path)
    assert store.chat("old-chat").get("purpose") == "chat"
    assert store.chats(1)[0]["purpose"] == "chat"
    with store.transaction() as db:
        assert db.execute("PRAGMA user_version").fetchone()[0] == 4


def test_old_audit_table_gains_actor_and_record_id(tmp_path) -> None:
    with sqlite3.connect(tmp_path / "achilles.sqlite3") as db:
        db.execute(
            "CREATE TABLE audit (id INTEGER PRIMARY KEY, page_id TEXT NOT NULL, "
            "action TEXT NOT NULL, version_digest TEXT, created_at TEXT NOT NULL)"
        )
        db.execute("INSERT INTO audit(page_id,action,created_at) VALUES('home','old','then')")
    store = PageStore(tmp_path)
    with store.transaction() as db:
        # the insert older code runs still works on the new columns.
        db.execute("INSERT INTO audit(page_id,action,created_at) VALUES('home','older','now')")
        rows = db.execute(
            "SELECT action, actor, record_id FROM audit WHERE action LIKE 'old%' ORDER BY id"
        ).fetchall()
    assert [tuple(row) for row in rows] == [("old", None, None), ("older", None, None)]


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


def _built(source: str = "ok") -> dict:
    return {
        "digest": f"digest-{source}",
        "size": len(source),
        "dependencies": {"react": "19.0.0", "react-dom": "19.0.0", "nanoid": "^5"},
        "resolved_dependencies": {"react": "19.0.0", "react-dom": "19.0.0", "nanoid": "5.1.6"},
        "lockfile": "exact lockfile",
    }


def test_code_build_failure_keeps_previous_revision_active(monkeypatch, tmp_path):
    import achilles.pages as pages
    from achilles.page_build import PageBuildError

    store = PageStore(tmp_path)
    monkeypatch.setattr(pages, "build_page", lambda *_: _built())
    first = store.write_page("home", "first", {"nanoid": "^5"}, 0)
    monkeypatch.setattr(
        pages,
        "build_page",
        lambda *_: (_ for _ in ()).throw(PageBuildError("src/Page.tsx:2:3: bad")),
    )

    with pytest.raises(ValidationError) as failure:
        store.write_page("home", "broken", {}, 1)

    assert failure.value.hint == "src/Page.tsx:2:3: bad"
    assert store.page_code("home")["version"] == first["revision"]
    failed = store.inspect_code("home")["revisions"][0]
    assert failed["digest"] is None and failed["diagnostics"] == "src/Page.tsx:2:3: bad"


def test_overlapping_build_cannot_activate_after_expected_revision_changes(monkeypatch, tmp_path):
    from threading import Event

    import achilles.pages as pages

    store = PageStore(tmp_path)
    slow_started, release_slow = Event(), Event()

    def build(_root, _page_id, source, _dependencies):
        if source == "slow":
            slow_started.set()
            assert release_slow.wait(10)
        return _built(source)

    monkeypatch.setattr(pages, "build_page", build)
    with ThreadPoolExecutor(max_workers=2) as pool:
        slow = pool.submit(store.write_page, "home", "slow", {}, 0)
        assert slow_started.wait(10)
        fast = store.write_page("home", "fast", {}, 0)
        release_slow.set()
        with pytest.raises(ValidationError) as failure:
            slow.result()
        assert failure.value.hint == "build started at revision 0, but revision 1 is now active"

    assert store.page_code("home")["digest"] == fast["digest"]
    revisions = store.inspect_code("home")["revisions"]
    assert revisions[0]["digest"] is None
    assert (
        revisions[0]["diagnostics"] == "build started at revision 0, but revision 1 is now active"
    )


def test_code_revision_returns_exact_versions_and_lockfile(monkeypatch, tmp_path):
    import achilles.pages as pages

    store = PageStore(tmp_path)
    monkeypatch.setattr(pages, "build_page", lambda *_: _built())
    result = store.write_page("home", "ok", {"nanoid": "^5"}, 0)

    assert result["resolved_dependencies"]["nanoid"] == "5.1.6"
    assert result["lockfile"] == "exact lockfile"
    revision = store.inspect_code("home")["revisions"][0]
    assert revision["resolved_dependencies"] == {
        "nanoid": "5.1.6",
        "react": "19.0.0",
        "react-dom": "19.0.0",
    }
    assert revision["lockfile"] == "exact lockfile"


@pytest.fixture
def built(monkeypatch):
    counter = 0

    def build(_root, _page_id, source, dependencies):
        nonlocal counter
        counter += 1
        return {
            "digest": f"digest-{counter}",
            "size": len(source),
            "dependencies": {"react": "19.0.0", "react-dom": "19.0.0", **dependencies},
            "resolved_dependencies": {
                "react": "19.0.0",
                "react-dom": "19.0.0",
                **{name: "1.0.0" for name in dependencies},
            },
            "lockfile": f"lock-{counter}",
        }

    monkeypatch.setattr(pages, "build_page", build)


def test_old_database_migrates_in_place_with_backup_and_non_page_data(tmp_path, capsys):
    database = tmp_path / "achilles.sqlite3"
    shutil.copy(Path(__file__).parent / "fixtures/old-block-achilles.sqlite3", database)

    store = PageStore(tmp_path)

    backup = Path(str(database) + ".pre-block-model-v3.backup")
    assert capsys.readouterr().out.strip() == f"Achilles database backup: {backup}"
    assert backup.is_file()
    with sqlite3.connect(database) as db:
        assert db.execute("PRAGMA user_version").fetchone()[0] == 4
        assert (
            db.execute("SELECT name FROM sqlite_master WHERE name='layout_version'").fetchone()
            is None
        )
        assert "active_layout_version" not in {
            row[1] for row in db.execute("PRAGMA table_info(page)")
        }
        assert db.execute("SELECT document FROM page_record").fetchone()[0] == '{"text": "keep me"}'
        assert (
            db.execute("SELECT title FROM chat WHERE session_id='chat-1'").fetchone()[0]
            == "kept chat"
        )
        assert (
            db.execute("SELECT source FROM code_revision")
            .fetchone()[0]
            .startswith("export default")
        )
        assert db.execute("SELECT COUNT(*) FROM audit").fetchone()[0] >= 0
    assert store.page_code("home")["digest"] == "code-digest"

    PageStore(tmp_path)
    assert capsys.readouterr().out == ""
    with sqlite3.connect(backup) as db:
        assert db.execute("SELECT document FROM layout_version").fetchone() is not None


def test_create_write_inspect_history_and_restore_code(built, tmp_path):
    store = PageStore(tmp_path)
    store.set_create_mode("home", True)
    source = "export default function Page(){return <main>one</main>}"
    page, digest, existing, _, _ = store.create_page(
        "/notes", "notes", {"source": source, "dependencies": {}}
    )
    assert not existing
    assert digest == "digest-1"
    page_id = page["id"]

    written = store.write_page(
        page_id,
        "export default function Page(){return <main>two</main>}",
        {},
        expected_revision=1,
    )
    inspected = store.inspect_page(page_id)
    assert written["revision"] == 2
    assert inspected["code"]["revision"] == 2
    assert [row["version"] for row in store.versions(page_id)["code"]] == [2, 1]

    store.set_create_mode(page_id, True)
    restored = store.restore_code(page_id, 1, 2)
    assert restored == {"revision": 3, "restored_from": 1, "digest": "digest-1"}
    assert store.page_code(page_id)["source"] == source
    assert store.versions(page_id)["code"][0]["restored_from"] == 1


def test_create_page_without_package_builds_minimal_react_shell(built, tmp_path):
    store = PageStore(tmp_path)
    store.set_create_mode("home", True)
    page, _, _, _, _ = store.create_page("/empty", "empty")
    code = store.page_code(page["id"])
    assert 'createRoot(document.getElementById("root")!)' in code["source"]
    assert code["version"] == 1
