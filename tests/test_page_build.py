import base64
import http.server
import io
import json
import os
import re
import shutil
import subprocess
import tempfile
import threading
from pathlib import Path

import pytest
from starlette.testclient import TestClient

import achilles.page_build as page_build
from achilles import web
from achilles.page_build import PageBuildError, build_page
from achilles.pages import PageStore


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
    def __init__(
        self,
        stdout: bytes = b"",
        stderr: bytes = b"",
        *,
        times_out: bool = False,
        exit_code: int = 0,
    ):
        self.stdout_finished = threading.Event()
        self.stderr_finished = threading.Event()
        self.stdout = _Output(stdout, self.stdout_finished)
        self.stderr = _Output(stderr, self.stderr_finished)
        self.returncode: int | None = None
        self.times_out = times_out
        self.exit_code = exit_code
        self.killed = False

    def wait(self, timeout: float | None = None) -> int:
        if self.times_out and not self.killed:
            raise subprocess.TimeoutExpired("docker", timeout)
        assert self.stdout_finished.wait(1)
        assert self.stderr_finished.wait(1)
        self.returncode = -9 if self.killed else self.exit_code
        return self.returncode

    def kill(self) -> None:
        self.killed = True
        self.stdout_finished.set()
        self.stderr_finished.set()
        self.returncode = -9

    def poll(self) -> int | None:
        return self.returncode


def _build_outputs(
    artifact: bytes = b"safe bundle", lockfile: str = "safe lock"
) -> list[tuple[bytes, bytes]]:
    """Fake install, bundle and collector outputs of one page build."""
    resolved = {"react": "19.0.0", "react-dom": "19.0.0"}
    install = {"lockfile": lockfile, "resolved_dependencies": resolved, "install_scripts": []}
    collected = {
        "artifact": base64.b64encode(artifact).decode(),
        "lockfile": lockfile,
        "resolved_dependencies": resolved,
    }
    return [(json.dumps(install).encode(), b""), (b"", b""), (json.dumps(collected).encode(), b"")]


def _fake_containers(monkeypatch, outputs: list[tuple[bytes, bytes]], exit_codes=()):
    """Each docker run returns the install, bundle or collector output for its step."""
    calls: list[list[str]] = []
    processes: list[_Process] = []
    lock = threading.Lock()

    def popen(command, **_kwargs):
        with lock:
            index = len(processes)
            calls.append(command)
            script = " ".join(command[command.index(page_build._BUILD_IMAGE) + 1 :])
            step = 0 if "install" in script else 1 if "bun build" in script else 2
            stdout, stderr = outputs[step]
            code = exit_codes[index] if index < len(exit_codes) else 0
            process = _Process(stdout, stderr, exit_code=code)
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
    calls, _ = _fake_containers(monkeypatch, _build_outputs())
    monkeypatch.setattr(page_build.shutil, "which", lambda _name: "/usr/bin/docker")

    build_page(tmp_path, "home", "export default 1", {})

    assert len(calls) == 3
    assert "--network=bridge" in calls[0] and "--ignore-scripts" in " ".join(calls[0])
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


def test_cleanup_runs_before_waiting_for_open_pipes(monkeypatch, tmp_path: Path) -> None:
    released = threading.Event()
    removed = threading.Event()

    class _OpenPipe:
        def read(self, _size: int) -> bytes:
            released.wait(10)
            return b""

    class _ProcessWithOpenPipes:
        stdout = _OpenPipe()
        stderr = _OpenPipe()

        def __init__(self) -> None:
            self.returncode = None

        def wait(self, timeout: float | None = None) -> int:
            self.returncode = 0
            return 0

        def kill(self) -> None:
            self.returncode = -9

        def poll(self) -> int | None:
            return self.returncode

    process = _ProcessWithOpenPipes()
    monkeypatch.setattr(page_build.subprocess, "Popen", lambda *_args, **_kwargs: process)

    def remove_container(*_args, **_kwargs):
        removed.set()
        released.set()

    monkeypatch.setattr(page_build.subprocess, "run", remove_container)
    finished = threading.Event()

    def run_container() -> None:
        page_build._run_container(
            "docker", tmp_path, None, ["bundle"], network="none", step="bundle"
        )
        finished.set()

    worker = threading.Thread(target=run_container, daemon=True)
    worker.start()
    try:
        assert finished.wait(10), "container cleanup must not wait for open pipes"
        assert removed.is_set()
    finally:
        released.set()
        worker.join(10)


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
    _fake_containers(
        monkeypatch, _build_outputs(b"container-collected bundle", "container-collected lock")
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


def test_concurrent_identical_builds_run_one_build(monkeypatch, tmp_path: Path) -> None:
    calls, _ = _fake_containers(monkeypatch, _build_outputs())
    monkeypatch.setattr(page_build.shutil, "which", lambda _name: "/usr/bin/docker")
    results: list[dict] = []
    errors: list[BaseException] = []

    def build() -> None:
        try:
            results.append(build_page(tmp_path, "home", "export default 1", {}))
        except BaseException as exc:  # noqa: BLE001
            errors.append(exc)

    workers = [threading.Thread(target=build) for _ in range(2)]
    for worker in workers:
        worker.start()
    for worker in workers:
        worker.join(10)

    assert not errors and len(results) == 2
    assert len(calls) == 3, "identical builds must share one container build"
    assert results[0] == results[1]
    assert [path.name for path in (tmp_path / "bundles").iterdir()] == [
        f"{results[0]['digest']}.js"
    ]
    assert (tmp_path / "bundles" / f"{results[0]['digest']}.js").read_bytes() == b"safe bundle"


def test_failed_install_is_not_cached(monkeypatch, tmp_path: Path) -> None:
    calls, _ = _fake_containers(monkeypatch, _build_outputs(), exit_codes=(1,))
    monkeypatch.setattr(page_build.shutil, "which", lambda _name: "/usr/bin/docker")

    with pytest.raises(PageBuildError):
        build_page(tmp_path, "home", "export default 1", {})
    assert not (tmp_path / "bundles").exists() or not any((tmp_path / "bundles").iterdir())

    result = build_page(tmp_path, "home", "export default 1", {})
    assert len(calls) == 4, "the retry must install again, not reuse the failed build"
    assert (tmp_path / "bundles" / f"{result['digest']}.js").read_bytes() == b"safe bundle"


# real container builds with a local package; no package registry is contacted
_docker = shutil.which("docker")
_real_docker = pytest.mark.skipif(
    _docker is None
    or subprocess.run([_docker, "info"], capture_output=True, check=False).returncode != 0,
    reason="needs docker",
)
_PROBE = """const fs=require('fs');const out=['SCRIPT-RAN'];
const tryRead=path=>{try{out.push('read:'+fs.readFileSync(path,'utf8'))}
 catch(e){out.push('denied:'+e.code)}};
for(const path of PATHS)tryRead(path);
const done=()=>fs.writeFileSync('result.js','export default '+JSON.stringify(out.join('|'))+';');
Promise.all(URLS.map(url=>fetch(url,{signal:AbortSignal.timeout(3000)}).then(r=>r.text())
 .then(t=>out.push('fetched:'+t),e=>out.push('blocked:'+e.name)))).then(done,done);
"""


@pytest.fixture
def probe_root(monkeypatch):
    """An achilles home that docker can mount, and builds that install a local probe package."""
    cache = Path(__file__).resolve().parent.parent / ".cache"
    cache.mkdir(exist_ok=True)
    root = Path(tempfile.mkdtemp(prefix="test-build-", dir=cache))
    original = page_build._install

    def install(docker, workspace, *args, **kwargs):
        shutil.copytree(root / "probe", workspace / "probe")
        return original(docker, workspace, *args, **kwargs)

    monkeypatch.setattr(page_build, "_LOCAL_SPEC", re.compile(r"(?!)"))
    monkeypatch.setattr(page_build, "effective_dependencies", dict)
    monkeypatch.setattr(page_build, "_install", install)
    try:
        yield root
    finally:
        shutil.rmtree(root, ignore_errors=True)


def _write_probe(root: Path, paths: list[str], urls: list[str]) -> None:
    probe = root / "probe"
    probe.mkdir()
    (probe / "package.json").write_text(
        json.dumps(
            {
                "name": "probe",
                "version": "1.0.0",
                "type": "module",
                "main": "result.js",
                "scripts": {"postinstall": "node probe.cjs"},
            }
        )
    )
    (probe / "result.js").write_text('export default "NOT-RUN";')
    (probe / "probe.cjs").write_text(
        f"const PATHS={json.dumps(paths)};const URLS={json.dumps(urls)};\n" + _PROBE
    )


_PROBE_SOURCE = 'import result from "probe";\nexport default result;\n'
_PROBE_DEPENDENCIES = {"probe": "file:./probe"}


@_real_docker
def test_install_script_runs_but_cannot_reach_host_secrets(probe_root: Path) -> None:
    zeta_home = probe_root / "zeta"
    zeta_home.mkdir()
    (zeta_home / "sentinel").write_text("ZETA-HOME-SECRET")
    achilles = probe_root / "achilles"
    store = PageStore(achilles)
    (achilles / "sentinel").write_text("ACHILLES-HOME-SECRET")
    token = store.ensure_credential("home")

    class _TokenHandler(http.server.BaseHTTPRequestHandler):
        def do_GET(self) -> None:  # noqa: N802
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b"LOOPBACK-TOKEN-" + token.encode())

        def log_message(self, *_args) -> None:
            pass

    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _TokenHandler)
    port = server.server_address[1]
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        _write_probe(
            probe_root,
            [
                str(zeta_home / "sentinel"),
                str(achilles / "sentinel"),
                str(achilles / "credentials" / "home"),
                "../sentinel",
                "../../credentials/home",
            ],
            [f"http://127.0.0.1:{port}/", f"http://host.docker.internal:{port}/"],
        )
        written = store.write_page("home", _PROBE_SOURCE, _PROBE_DEPENDENCIES)
    finally:
        server.shutdown()
        server.server_close()
        thread.join(10)

    bundle = (achilles / "bundles" / f"{written['digest']}.js").read_text()
    assert "SCRIPT-RAN" in bundle, bundle
    assert bundle.count("denied:ENOENT") == 5, bundle
    assert bundle.count("blocked:") == 2, bundle
    for secret in ("ZETA-HOME-SECRET", "ACHILLES-HOME-SECRET", "LOOPBACK-TOKEN", token):
        assert secret not in bundle
    inspected = store.inspect_page("home")["code"]
    assert inspected["resolved_dependencies"] == {"probe": "1.0.0"}
    assert inspected.get("install_scripts") == ["probe@1.0.0"]
    assert inspected.get("bundle_size") == written["size"] == len(bundle.encode())


@_real_docker
def test_rebuilt_revision_keeps_lock_versions_and_digest(probe_root: Path, monkeypatch) -> None:
    achilles = probe_root / "achilles"
    monkeypatch.setenv("ACHILLES_HOME", str(achilles))
    monkeypatch.setenv("ZETA_HOME", str(probe_root / "zeta"))
    store = PageStore(achilles)
    _write_probe(probe_root, [], [])
    written = store.write_page("home", _PROBE_SOURCE, _PROBE_DEPENDENCIES)
    bundle = achilles / "bundles" / f"{written['digest']}.js"
    original = bundle.read_bytes()
    bundle.unlink()

    with TestClient(web.create_app()) as client:
        frame = client.get("/api/pages/home/frame")

    assert frame.status_code == 200, frame.text
    assert bundle.read_bytes() == original
    # the rebuild is a second, lock-pinned build, not the cached first one
    assert len(list((achilles / "build-cache").glob("*.json"))) == 2
    code = store.page_code("home")
    assert code["digest"] == written["digest"]
    assert code["resolved_dependencies"] == json.dumps({"probe": "1.0.0"})
