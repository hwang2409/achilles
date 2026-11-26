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


def test_container_mounts_only_workspace_and_package_cache(monkeypatch, tmp_path: Path) -> None:
    calls: list[list[str]] = []

    def run(command, **_kwargs):
        calls.append(command)
        return SimpleNamespace(returncode=1, stderr="bad package", stdout="")

    monkeypatch.setattr(page_build.shutil, "which", lambda _name: "/usr/bin/docker")
    monkeypatch.setattr(page_build.subprocess, "run", run)

    with pytest.raises(PageBuildError, match="bad package"):
        build_page(tmp_path, "home", "export default 1", {})

    command = calls[0]
    mounts = [command[index + 1] for index, value in enumerate(command) if value == "--mount"]
    assert len(mounts) == 2
    assert all(str(tmp_path.resolve()) in mount for mount in mounts)
    assert not any(str(Path.home()) in mount for mount in mounts)
    assert not any("docker.sock" in mount for mount in mounts)
