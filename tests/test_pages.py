import json
import shutil
import sqlite3
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest

import achilles.pages as pages
from achilles.pages import PageStore
from achilles.tools import ValidationError


def _revisions(store: PageStore) -> list[dict]:
    with store.transaction() as db:
        rows = db.execute(
            "SELECT digest, diagnostics, resolved_dependencies, lockfile FROM code_revision "
            "WHERE page_id='home' ORDER BY version DESC"
        ).fetchall()
    return [
        dict(row) | {"resolved_dependencies": json.loads(row["resolved_dependencies"])}
        for row in rows
    ]


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
        assert db.execute("PRAGMA user_version").fetchone()[0] == 5


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
    failed = _revisions(store)[0]
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
    revisions = _revisions(store)
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
    revision = _revisions(store)[0]
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
        assert db.execute("PRAGMA user_version").fetchone()[0] == 5
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
        # main's ensure_column runs after the v3 -> v4 drop and leaves old chats at version 0
        assert db.execute(
            "SELECT state_version FROM chat WHERE session_id='chat-1'"
        ).fetchone() == (0,)
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
    # the v3 backup already holds everything, so the v1-v3 path writes no second backup
    assert not Path(str(database) + ".pre-archive-v4.backup").exists()


def test_migration_after_another_process_migrated_is_a_no_op(monkeypatch, tmp_path):
    database = tmp_path / "achilles.sqlite3"
    shutil.copy(Path(__file__).parent / "fixtures/old-block-achilles.sqlite3", database)
    backup = Path(str(database) + ".pre-block-model-v3.backup")
    racing = sqlite3.connect(database)
    assert racing.execute("PRAGMA user_version").fetchone()[0] == 3
    try:
        PageStore(tmp_path)  # the other process wins the first open
        # the racing open checked for the backup before the winner wrote it
        real_exists = Path.exists
        monkeypatch.setattr(Path, "exists", lambda path: path != backup and real_exists(path))
        pages._drop_block_model(racing, database)
    finally:
        racing.close()

    with sqlite3.connect(database) as db:
        assert db.execute("PRAGMA user_version").fetchone()[0] == 5
    with sqlite3.connect(backup) as db:
        assert db.execute("PRAGMA user_version").fetchone()[0] == 3, "v3 backup was overwritten"
    assert [path.name for path in tmp_path.iterdir() if path.name.endswith(".tmp")] == []


_KEPT_TABLES = ("page", "page_record", "code_revision", "tool", "tool_version", "chat", "audit")


def _row_counts(database: Path) -> dict[str, int]:
    with sqlite3.connect(database) as db:
        return {
            table: db.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
            for table in _KEPT_TABLES
        }


def _v4_database(root: Path) -> Path:
    """A v4 home: today's schema without page.archived_at, holding records and versions."""
    PageStore(root)
    database = root / "achilles.sqlite3"
    with sqlite3.connect(database) as db:
        if "archived_at" in {row[1] for row in db.execute("PRAGMA table_info(page)")}:
            db.execute("ALTER TABLE page DROP COLUMN archived_at")
        db.execute(
            "INSERT INTO page(id,route,title,created_at,updated_at) "
            "VALUES('reading','/reading','reading','t','t')"
        )
        db.executemany(
            "INSERT INTO page_record(page_id,collection,record_id,version,document,"
            "created_at,updated_at) VALUES('reading','books',?,1,'{}','t','t')",
            [(f"book-{index}",) for index in range(3)],
        )
        db.executemany(
            "INSERT INTO code_revision(page_id,version,source,dependencies,created_at) "
            "VALUES('reading',?,'export default 1','{}','t')",
            [(1,), (2,)],
        )
        db.execute("INSERT INTO chat VALUES('chat-1','reading','kept','t','t',NULL,'chat',0,1,0,NULL)")
        db.execute("PRAGMA user_version = 4")
    return database


def test_v4_database_migrates_to_v5_with_a_backup_and_keeps_every_row(tmp_path, capsys):
    database = _v4_database(tmp_path)
    capsys.readouterr()
    before = _row_counts(database)
    backup = Path(str(database) + ".pre-archive-v4.backup")

    PageStore(tmp_path)

    assert capsys.readouterr().out.strip() == f"Achilles database backup: {backup}"
    assert backup.is_file(), "the v4 -> v5 migration wrote no backup"
    with sqlite3.connect(backup) as db:
        # the backup is the database as it was before any v5 write
        assert db.execute("PRAGMA user_version").fetchone()[0] == 4
        assert "archived_at" not in {row[1] for row in db.execute("PRAGMA table_info(page)")}
    assert _row_counts(backup) == before
    with sqlite3.connect(database) as db:
        assert db.execute("PRAGMA user_version").fetchone()[0] == 5
        assert db.execute("SELECT archived_at FROM page WHERE id='reading'").fetchone() == (None,)
    assert _row_counts(database) == before
    assert not Path(str(database) + ".pre-block-model-v3.backup").exists()

    written = backup.stat().st_mtime_ns
    PageStore(tmp_path)
    assert capsys.readouterr().out == "", "the second start migrated or backed up again"
    assert backup.stat().st_mtime_ns == written
    assert _row_counts(database) == before
    assert [path.name for path in tmp_path.iterdir() if path.name.endswith(".tmp")] == []


def test_fresh_database_starts_at_v5_without_a_backup(tmp_path, capsys):
    PageStore(tmp_path)
    database = tmp_path / "achilles.sqlite3"
    with sqlite3.connect(database) as db:
        assert db.execute("PRAGMA user_version").fetchone()[0] == 5
        assert "archived_at" in {row[1] for row in db.execute("PRAGMA table_info(page)")}
    assert capsys.readouterr().out == ""
    assert sorted(path.name for path in tmp_path.glob("*.backup")) == []


def test_newer_database_is_refused_before_any_write(tmp_path):
    database = tmp_path / "achilles.sqlite3"
    with sqlite3.connect(database) as db:
        db.execute("CREATE TABLE page (id TEXT PRIMARY KEY)")
        db.execute("PRAGMA user_version = 6")
    content = database.read_bytes()
    with pytest.raises(RuntimeError, match="unsupported Achilles database version: 6"):
        PageStore(tmp_path)
    assert database.read_bytes() == content
    assert sorted(path.name for path in tmp_path.glob("*.backup")) == []


def test_archive_hides_a_page_and_restore_returns_it_with_its_rows(tmp_path):
    database = _v4_database(tmp_path)
    store = PageStore(tmp_path)
    before = _row_counts(database)

    renamed = store.update_page("reading", title="books")
    assert renamed["title"] == "books"
    store.update_page("reading", archived=True)
    assert [page["id"] for page in store.pages()[0]] == ["home"]
    archived = store.pages(archived=True)[0]
    assert [(page["id"], page["title"]) for page in archived] == [("reading", "books")]
    first = archived[0]["archived_at"]
    assert first
    store.update_page("reading", archived=True)
    assert store.page("reading")["archived_at"] == first, "archiving twice moved the time"
    assert _row_counts(database) == before

    store.update_page("reading", archived=False)
    assert [page["id"] for page in store.pages()[0]] == ["home", "reading"]
    assert store.pages(archived=True)[0] == []
    assert store.page("reading")["archived_at"] is None
    assert _row_counts(database) == before

    with pytest.raises(ValueError, match="home cannot be archived"):
        store.update_page("home", archived=True)
    assert store.page("home")["archived_at"] is None
    with pytest.raises(KeyError):
        store.update_page("missing", title="x")


def test_create_write_inspect_history_and_restore_code(built, tmp_path):
    store = PageStore(tmp_path)
    store.set_create_mode("home", True)
    source = "export default function Page(){return <main>one</main>}"
    page, digest, existing, _ = store.create_page(
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


def test_inspect_bounds_non_ascii_candidate_diagnostics(built, monkeypatch, tmp_path):
    store = PageStore(tmp_path)
    store.set_create_mode("home", True)
    page, _, _, _ = store.create_page("/notes", "notes")

    def fail(*_args):
        raise pages.PageBuildError("書" * 3000)

    monkeypatch.setattr(pages, "build_page", fail)
    with pytest.raises(ValidationError):
        store.write_page(page["id"], "broken", {}, expected_revision=1)
    result, encoded = pages.bounded_inspect(store.inspect_page(page["id"]))
    assert result["candidate"]["revision"] == 2
    assert result["candidate"]["diagnostics"].startswith("書")
    assert len(encoded.encode()) <= pages.INSPECT_MAX_BYTES


def test_edit_page_conflicts_when_a_write_commits_between_its_reads(built, monkeypatch, tmp_path):
    store = PageStore(tmp_path)
    store.set_create_mode("home", True)
    page, _, _, _ = store.create_page(
        "/notes", "notes", {"source": "<main>one</main>", "dependencies": {}}
    )
    newest_code = store._newest_code
    injected = []

    def newest_then_write(db, page_id):
        row = newest_code(db, page_id)
        if not injected:
            injected.append(store.write_page(page_id, "<main>newer</main>", {}, 1))
        return row

    monkeypatch.setattr(store, "_newest_code", newest_then_write)
    with pytest.raises(ValidationError) as raised:
        store.edit_page(page["id"], "src/Page.tsx", [{"old_string": "one", "new_string": "two"}], 1)
    assert raised.value.code == "conflict"
    assert store.page_code(page["id"])["source"] == "<main>newer</main>"


def test_create_page_without_package_builds_minimal_react_shell(built, tmp_path):
    store = PageStore(tmp_path)
    store.set_create_mode("home", True)
    page, _, _, _ = store.create_page("/empty", "empty")
    code = store.page_code(page["id"])
    assert 'createRoot(document.getElementById("root")!)' in code["source"]
    assert code["version"] == 1


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


def test_page_list_order_survives_setting_toggles(built, tmp_path) -> None:
    store = PageStore(tmp_path / "achilles")
    store.set_create_mode("home", True)
    reading = store.create_page("/reading", "reading")[0]["id"]
    order = [page["route"] for page in store.pages()[0]]
    assert order == ["/", "/reading"]
    store.set_create_mode(reading, True)
    store.set_create_mode("home", False)
    store.set_create_mode(reading, False)
    assert [page["route"] for page in store.pages()[0]] == order
    first, cursor = store.pages(limit=1)
    assert [page["route"] for page in first] == ["/"]
    assert [page["route"] for page in store.pages(limit=1, before=cursor)[0]] == ["/reading"]


@pytest.mark.parametrize(
    "route, allowed",
    [
        (f"/{segment}{suffix}", False)
        for segment in (
            "chats",
            "pages",
            "agents",
            "sessions",
            "projects",
            "telemetry",
            "skills",
            "agent-profiles",
            "settings",
            "accounts",
            "mcp",
            "create",
            "api",
            "assets",
        )
        for suffix in ("", "/report")
    ]
    + [("/settingsx", True), ("/create-list", True), ("/my/settings", True)],
)
def test_create_page_schema_rejects_reserved_route_through_store(built, tmp_path, route, allowed):
    store = PageStore(tmp_path)
    store.set_create_mode("home", True)
    if allowed:
        page, *_ = store.create_page(route, "report")
        assert page["route"] == route
    else:
        with pytest.raises(ValidationError) as caught:
            store.create_page(route, "report")
        assert caught.value.path == "/route"
        assert caught.value.expected.startswith("pattern ")
