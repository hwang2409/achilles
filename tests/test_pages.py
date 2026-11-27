import shutil
import sqlite3
from pathlib import Path

import pytest

import achilles.pages as pages
from achilles.pages import PageStore


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
