import base64
import json
import os
from pathlib import Path
from types import SimpleNamespace

import pytest

import achilles.page_build as page_build
from achilles.page_build import PageBuildError, build_page


def test_build_rejects_host_path_dependencies(tmp_path: Path) -> None:
    for spec in ("file:../secret", "link:/secret", "/secret/package", "C:\\secret"):
        with pytest.raises(PageBuildError, match="local dependency paths are not allowed"):
            build_page(tmp_path, "home", "export default 1", {"escape": spec})


def test_build_requires_container_isolation(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.setattr(page_build.shutil, "which", lambda _name: None)

    with pytest.raises(PageBuildError) as failure:
        build_page(tmp_path, "home", "export default 1", {})

    assert failure.value.code == "build_unavailable"
    assert "docker was not found" in failure.value.diagnostics


def test_build_uses_network_only_for_scriptless_install(monkeypatch, tmp_path: Path) -> None:
    calls: list[list[str]] = []

    def run(command, **_kwargs):
        calls.append(command)
        if len(calls) == 3:
            result = {
                "artifact": base64.b64encode(b"safe bundle").decode(),
                "lockfile": "safe lock",
                "resolved_dependencies": {"react": "19.0.0", "react-dom": "19.0.0"},
            }
            return SimpleNamespace(returncode=0, stderr="", stdout=json.dumps(result))
        return SimpleNamespace(returncode=0, stderr="", stdout="")

    monkeypatch.setattr(page_build.shutil, "which", lambda _name: "/usr/bin/docker")
    monkeypatch.setattr(page_build.subprocess, "run", run)

    build_page(tmp_path, "home", "export default 1", {})

    assert len(calls) == 3
    assert "--network=bridge" in calls[0] and "--ignore-scripts" in calls[0]
    assert all("--network=none" in command for command in calls[1:])
    assert all("host.docker.internal:127.0.0.1" in command for command in calls)
    assert all(
        command[command.index("--user") + 1] == f"{os.getuid()}:{os.getgid()}" for command in calls
    )
    mounts = [calls[0][index + 1] for index, value in enumerate(calls[0]) if value == "--mount"]
    assert len(mounts) == 2
    assert all(str(tmp_path.resolve()) in mount for mount in mounts)
    assert not any(str(Path.home()) in mount for mount in mounts)
    assert not any("docker.sock" in mount for mount in mounts)


def test_host_never_reads_symlinked_build_outputs(monkeypatch, tmp_path: Path) -> None:
    sentinel = tmp_path / "sentinel"
    sentinel.write_text("HOST-SECRET-SHOULD-NOT-LEAK")
    calls = 0

    def run(command, **_kwargs):
        nonlocal calls
        calls += 1
        workspace = Path(
            next(value for value in command if "dst=/workspace" in value).split(",")[1][4:]
        )
        if calls == 2:
            (workspace / "page.js").write_bytes(b"container-collected bundle")
            (workspace / "bun.lock").symlink_to(sentinel)
            for name in ("react", "react-dom"):
                package = workspace / "node_modules" / name / "package.json"
                package.parent.mkdir(parents=True, exist_ok=True)
                package.write_text(json.dumps({"version": "19.0.0"}))
        if calls == 3:
            result = {
                "artifact": base64.b64encode(b"container-collected bundle").decode(),
                "lockfile": "container-collected lock",
                "resolved_dependencies": {"react": "19.0.0", "react-dom": "19.0.0"},
            }
            return SimpleNamespace(returncode=0, stderr="", stdout=json.dumps(result))
        return SimpleNamespace(returncode=0, stderr="", stdout="")

    monkeypatch.setattr(page_build.shutil, "which", lambda _name: "/usr/bin/docker")
    monkeypatch.setattr(page_build.subprocess, "run", run)

    result = build_page(tmp_path / "build", "home", "export default 1", {})
    artifact = (tmp_path / "build/bundles" / f"{result['digest']}.js").read_bytes()
    serialized = json.dumps(result)
    assert artifact == b"container-collected bundle"
    assert (
        "HOST-SECRET-SHOULD-NOT-LEAK" not in serialized
        and sentinel.read_text() not in artifact.decode()
    )
