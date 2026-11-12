from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from achilles.web import _database, _save_session


def test_session_mapping_is_atomic_and_private(monkeypatch, tmp_path: Path) -> None:
    home = tmp_path / "achilles"
    home.mkdir(mode=0o755)
    monkeypatch.setenv("ACHILLES_HOME", str(home))
    with _database() as db:
        db.execute("UPDATE page SET zeta_session_id = NULL WHERE id = 'home'")
        db.commit()
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(
            pool.map(lambda value: _save_session(None, value), ("session-a", "session-b"))
        )
    assert [result[0] for result in results].count(True) == 1
    assert len({result[1] for result in results}) == 1
    assert home.stat().st_mode & 0o777 == 0o700
    assert (home / "achilles.sqlite3").stat().st_mode & 0o777 == 0o600
    for sidecar in (home / "achilles.sqlite3-wal", home / "achilles.sqlite3-shm"):
        if sidecar.exists():
            assert sidecar.stat().st_mode & 0o777 == 0o600
