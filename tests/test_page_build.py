import base64
import io
import json
import os
import subprocess
import threading
from pathlib import Path

import pytest

import achilles.page_build as page_build
from achilles.page_build import PageBuildError, build_page


class _Output(io.BytesIO):
    def __init__(self, value: bytes, finished: threading.Event):
        super().__init__(value)
        self.finished = finished

    def read(self, size: int = -1) -> bytes:
        value = super().read(size)
        if not value:
            self.finished.set()
        return value


class _Process:
    def __init__(self, stdout: bytes = b"", stderr: bytes = b"", *, times_out: bool = False):
        self.stdout_finished = threading.Event()
        self.stderr_finished = threading.Event()
        self.stdout = _Output(stdout, self.stdout_finished)
        self.stderr = _Output(stderr, self.stderr_finished)
        self.returncode: int | None = None
        self.times_out = times_out
        self.killed = False

    def wait(self, timeout: float | None = None) -> int:
        if self.times_out and not self.killed:
            raise subprocess.TimeoutExpired("docker", timeout)
        assert self.stdout_finished.wait(1)
        assert self.stderr_finished.wait(1)
        self.returncode = -9 if self.killed else 0
        return self.returncode

    def kill(self) -> None:
        self.killed = True
        self.stdout_finished.set()
        self.stderr_finished.set()
        self.returncode = -9

    def poll(self) -> int | None:
        return self.returncode


def _fake_containers(monkeypatch, outputs: list[tuple[bytes, bytes]]):
    calls: list[list[str]] = []
    processes: list[_Process] = []

    def popen(command, **_kwargs):
        calls.append(command)
        stdout, stderr = outputs[len(processes)]
        process = _Process(stdout, stderr)
        processes.append(process)
        return process

    monkeypatch.setattr(page_build.subprocess, "Popen", popen)
    monkeypatch.setattr(page_build.subprocess, "run", lambda *_args, **_kwargs: None)
    return calls, processes


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
    result = {
        "artifact": base64.b64encode(b"safe bundle").decode(),
        "lockfile": "safe lock",
        "resolved_dependencies": {"react": "19.0.0", "react-dom": "19.0.0"},
    }
    calls, _ = _fake_containers(
        monkeypatch, [(b"", b""), (b"", b""), (json.dumps(result).encode(), b"")]
    )
    monkeypatch.setattr(page_build.shutil, "which", lambda _name: "/usr/bin/docker")

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
    assert all("dst=/cache" not in value for command in calls[1:] for value in command)
    assert not any(str(Path.home()) in mount for mount in mounts)
    assert not any("docker.sock" in mount for mount in mounts)


def test_oversized_output_is_bounded_and_removes_container(monkeypatch, tmp_path: Path) -> None:
    removed: list[str] = []
    process = _Process(b"x" * 1024)
    monkeypatch.setattr(page_build.subprocess, "Popen", lambda *_args, **_kwargs: process)
    monkeypatch.setattr(
        page_build.subprocess,
        "run",
        lambda command, **_kwargs: removed.append(command[-1]),
    )

    with pytest.raises(PageBuildError, match="collector output exceeds 32 bytes"):
        page_build._run_container(
            "docker",
            tmp_path,
            None,
            ["collect"],
            network="none",
            step="collector",
            stdout_limit=32,
            timeout=1,
        )

    assert process.stdout.tell() == 33
    assert process.killed
    assert len(removed) == 1 and removed[0].startswith("page-build-")


def test_timed_out_step_removes_container(monkeypatch, tmp_path: Path) -> None:
    removed: list[str] = []
    process = _Process(times_out=True)
    monkeypatch.setattr(page_build.subprocess, "Popen", lambda *_args, **_kwargs: process)
    monkeypatch.setattr(
        page_build.subprocess,
        "run",
        lambda command, **_kwargs: removed.append(command[-1]),
    )

    with pytest.raises(PageBuildError, match="bundle exceeded the 0.01 second limit"):
        page_build._run_container(
            "docker",
            tmp_path,
            None,
            ["bundle"],
            network="none",
            step="bundle",
            timeout=0.01,
        )

    assert process.killed
    assert len(removed) == 1 and removed[0].startswith("page-build-")


def test_host_never_reads_symlinked_build_outputs(monkeypatch, tmp_path: Path) -> None:
    sentinel = tmp_path / "sentinel"
    sentinel.write_text("HOST-SECRET-SHOULD-NOT-LEAK")
    collected = {
        "artifact": base64.b64encode(b"container-collected bundle").decode(),
        "lockfile": "container-collected lock",
        "resolved_dependencies": {"react": "19.0.0", "react-dom": "19.0.0"},
    }
    calls, _ = _fake_containers(
        monkeypatch, [(b"", b""), (b"", b""), (json.dumps(collected).encode(), b"")]
    )
    monkeypatch.setattr(page_build.shutil, "which", lambda _name: "/usr/bin/docker")

    result = build_page(tmp_path / "build", "home", "export default 1", {})
    artifact = (tmp_path / "build/bundles" / f"{result['digest']}.js").read_bytes()
    serialized = json.dumps(result)
    assert artifact == b"container-collected bundle"
    assert (
        "HOST-SECRET-SHOULD-NOT-LEAK" not in serialized
        and sentinel.read_text() not in artifact.decode()
    )
