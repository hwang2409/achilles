from __future__ import annotations

import base64
import contextlib
import fcntl
import hashlib
import json
import os
import re
import shutil
import subprocess
import tempfile
import threading
import uuid
from pathlib import Path
from typing import Any

_BUILD_IMAGE = "oven/bun@sha256:87416c977a612a204eb54ab9f3927023c2a3c971f4f345a01da08ea6262ae30e"
_LOCAL_SPEC = re.compile(r"^(?:file|link):|^(?:/|[A-Za-z]:[\\/])")
_MAX_RESULT_BYTES = 16 * 1024 * 1024
_MAX_DIAGNOSTIC_BYTES = 16 * 1024
_STEP_TIMEOUT_SECONDS = 180
_BUILD_LABEL = "achilles.page-build"
_MAX_CACHE_ENTRIES = 100


class PageBuildError(ValueError):
    def __init__(self, diagnostics: str, code: str = "compile_error"):
        super().__init__(diagnostics)
        self.diagnostics = diagnostics
        self.code = code


def _run_container(
    docker: str,
    workspace: Path,
    cache: Path | None,
    command: list[str],
    *,
    network: str,
    step: str,
    stdout_limit: int | None = None,
    timeout: float | None = None,
):
    stdout_limit = _MAX_RESULT_BYTES if stdout_limit is None else stdout_limit
    timeout = _STEP_TIMEOUT_SECONDS if timeout is None else timeout
    container = f"page-build-{uuid.uuid4().hex}"
    stdout = bytearray()
    stderr = bytearray()
    overflow = threading.Event()
    process: subprocess.Popen[bytes] | None = None
    readers: list[threading.Thread] = []

    def read_stdout() -> None:
        assert process is not None and process.stdout is not None
        while chunk := process.stdout.read(min(64 * 1024, stdout_limit + 1 - len(stdout))):
            remaining = stdout_limit + 1 - len(stdout)
            stdout.extend(chunk[:remaining])
            if len(stdout) > stdout_limit:
                overflow.set()
                process.kill()
                return

    def read_stderr() -> None:
        assert process is not None and process.stderr is not None
        while chunk := process.stderr.read(64 * 1024):
            stderr.extend(chunk)
            if len(stderr) > _MAX_DIAGNOSTIC_BYTES:
                del stderr[:-_MAX_DIAGNOSTIC_BYTES]

    mounts = ["--mount", f"type=bind,src={workspace},dst=/workspace"]
    cache_env: list[str] = []
    if cache is not None:
        mounts += ["--mount", f"type=bind,src={cache},dst=/cache"]
        cache_env = ["--env=BUN_INSTALL_CACHE_DIR=/cache"]
    try:
        process = subprocess.Popen(
            [
                docker,
                "run",
                "--rm",
                "--name",
                container,
                "--label",
                f"{_BUILD_LABEL}={container}",
                f"--network={network}",
                "--add-host",
                "host.docker.internal:127.0.0.1",
                "--user",
                f"{os.getuid()}:{os.getgid()}",
                *mounts,
                "--workdir=/workspace",
                "--env=HOME=/tmp/home",
                *cache_env,
                _BUILD_IMAGE,
                *command,
            ],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        readers = [threading.Thread(target=read_stdout), threading.Thread(target=read_stderr)]
        try:
            for reader in readers:
                reader.start()
            returncode = process.wait(timeout=timeout)
        except subprocess.TimeoutExpired as exc:
            process.kill()
            raise PageBuildError(
                f"{step} exceeded the {timeout:g} second limit", "build_unavailable"
            ) from exc
        finally:
            if process.poll() is None:
                process.kill()
                process.wait()
            try:
                subprocess.run(
                    [docker, "rm", "-f", container],
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    timeout=10,
                    check=False,
                )
            except (OSError, subprocess.TimeoutExpired):
                pass
            for reader in readers:
                if reader.ident is not None:
                    reader.join()
        if overflow.is_set():
            raise PageBuildError(f"{step} output exceeds {stdout_limit} bytes")
        return subprocess.CompletedProcess(
            [], returncode, stdout.decode(errors="replace"), stderr.decode(errors="replace")
        )
    except OSError as exc:
        raise PageBuildError(
            f"page build isolation is unavailable during {step}: {exc}", "build_unavailable"
        ) from exc


def _check_step(result, source: str) -> None:
    if not result.returncode:
        return
    detail = (result.stderr or result.stdout).strip()[-4000:]
    if result.returncode == 125:
        raise PageBuildError("page build isolation is unavailable: " + detail, "build_unavailable")
    raise PageBuildError(f"{source}:1:1: {detail}")


# runs before any package script, so the lock, versions and script list are bun's own output
_INSTALL_REPORT = """import {readFileSync,readdirSync,existsSync} from 'node:fs';
const read=path=>JSON.parse(readFileSync(path,'utf8'));
const scripts=new Set();
const walk=dir=>{if(!existsSync(dir))return;for(const name of readdirSync(dir)){
 if(name.startsWith('.'))continue;const path=`${dir}/${name}`;
 if(name.startsWith('@')){walk(path);continue;}
 try{const p=read(`${path}/package.json`);const s=p.scripts||{};
  if(s.preinstall||s.install||s.postinstall)scripts.add(`${p.name}@${p.version}`);}catch{}
 walk(`${path}/node_modules`);}};
walk('node_modules');
console.log(JSON.stringify({
 lockfile:readFileSync('bun.lock','utf8'),
 resolved_dependencies:Object.fromEntries(JSON.parse(process.argv[1]).map(
  name=>[name,read(`node_modules/${name}/package.json`).version])),
 install_scripts:[...scripts].sort().slice(0,50)
}));
"""


def _warnings(*outputs: str) -> list[str]:
    lines = [line.strip()[:300] for text in outputs for line in text.splitlines()]
    return [line for line in lines if "warn" in line.lower()][:20]


def _install(
    docker: str, workspace: Path, cache: Path, dependencies: list[str], frozen: bool
) -> dict[str, Any]:
    install = "bun install --ignore-scripts" + (" --frozen-lockfile" if frozen else "")
    result = _run_container(
        docker,
        workspace,
        cache,
        [
            "sh",
            "-c",
            f'{install} >&2 && bun -e "$0" "$1"',
            _INSTALL_REPORT,
            json.dumps(dependencies),
        ],
        network="bridge",
        step="package install",
    )
    _check_step(result, "package.json")
    try:
        report = json.loads(result.stdout)
        lockfile = report["lockfile"]
        resolved = report["resolved_dependencies"]
        scripts = report["install_scripts"]
    except (KeyError, TypeError, ValueError) as exc:
        raise PageBuildError("package install returned an invalid result") from exc
    if (
        not isinstance(lockfile, str)
        or not isinstance(resolved, dict)
        or set(resolved) != set(dependencies)
        or any(not isinstance(value, str) for value in resolved.values())
        or not isinstance(scripts, list)
        or any(not isinstance(value, str) for value in scripts)
    ):
        raise PageBuildError("package install returned an invalid result")
    return {
        "lockfile": lockfile,
        "resolved_dependencies": resolved,
        # a package name has no length limit; inspect_page must stay within its size bound
        "install_scripts": [value[:200] for value in scripts[:50]],
        "warnings": _warnings(result.stderr),
    }


def _bundle(docker: str, workspace: Path) -> list[str]:
    result = _run_container(
        docker,
        workspace,
        None,
        [
            "sh",
            "-c",
            'trust=$(bun pm trust --all 2>&1) || { echo "$trust"; '
            "echo \"$trust\" | grep -q '0 scripts ran' || exit 1; }; "
            "bun build src/Page.tsx --outfile page.js --target=browser --format=esm --minify",
        ],
        network="none",
        step="page bundle",
    )
    _check_step(result, "src/Page.tsx")
    return _warnings(result.stdout, result.stderr)


def _collect(docker: str, workspace: Path) -> bytes:
    script = (
        "const artifact=require('node:fs').readFileSync('page.js').toString('base64');"
        "console.log(JSON.stringify({artifact}))"
    )
    result = _run_container(
        docker,
        workspace,
        None,
        ["bun", "-e", script],
        network="none",
        step="page result collector",
    )
    _check_step(result, "page build result")
    try:
        return base64.b64decode(json.loads(result.stdout)["artifact"], validate=True)
    except (KeyError, TypeError, ValueError) as exc:
        raise PageBuildError("page build returned an invalid result") from exc


def effective_dependencies(dependencies: dict[str, str]) -> dict[str, str]:
    """The dependency map a build installs and stores: the react pins plus the requested deps."""
    return {"react": "19.0.0", "react-dom": "19.0.0", **dependencies}


def atomic_private_write(path: Path, content: bytes) -> None:
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "wb") as stream:
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    except BaseException:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass
        raise


def build_page(
    root: Path,
    page_id: str,
    source: str,
    dependencies: dict[str, str],
    lockfile: str | None = None,
    *,
    wait: bool = True,
) -> dict[str, Any]:
    """Bundle a browser page in a disposable container with only source and package cache.

    A lockfile pins the install to it. Identical (source, dependencies, lockfile) builds share
    one result: concurrent ones wait for the first (or fail at once when not `wait`), and only a
    complete build is cached."""
    if not isinstance(source, str) or not source.strip():
        raise PageBuildError("src/Page.tsx:1:1: page source is empty")
    if not isinstance(dependencies, dict) or any(
        not isinstance(k, str) or not isinstance(v, str) or not k or not v
        for k, v in dependencies.items()
    ):
        raise PageBuildError("package.json:1:1: dependencies must be a string map")
    local = next((value for value in dependencies.values() if _LOCAL_SPEC.match(value)), None)
    if local is not None:
        raise PageBuildError(f"package.json:1:1: local dependency paths are not allowed: {local}")
    docker = shutil.which("docker")
    if docker is None:
        raise PageBuildError(
            "page build isolation is unavailable: docker was not found", "build_unavailable"
        )
    build_cache = root / "build-cache"
    build_cache.mkdir(mode=0o700, parents=True, exist_ok=True)
    package = {
        "private": True,
        "type": "module",
        "dependencies": effective_dependencies(dependencies),
    }
    key = hashlib.sha256(
        json.dumps([source, package["dependencies"], lockfile], sort_keys=True).encode()
    ).hexdigest()
    entry = build_cache / f"{key}.json"
    with _key_lock(build_cache / f"{key}.lock", wait):
        try:
            cached = json.loads(entry.read_text())
        except FileNotFoundError:  # never built, or pruned
            cached = None
        if cached and (root / "bundles" / f"{cached['digest']}.js").is_file():
            return cached
        result = _build(docker, root, source, package, lockfile)
        atomic_private_write(entry, json.dumps(result, sort_keys=True).encode())
    _prune_cache(build_cache)
    return result


@contextlib.contextmanager
def _key_lock(path: Path, wait: bool):
    """One build per key at a time. The lock file exists only while a build holds it, so a
    waiter that wakes on a deleted file tries again on the current one."""
    while True:
        with open(path, "a") as lock:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | (0 if wait else fcntl.LOCK_NB))
            except BlockingIOError:
                raise PageBuildError(
                    "an identical page build is already running", "build_unavailable"
                ) from None
            try:
                current = os.stat(path).st_ino
            except FileNotFoundError:
                current = None
            if current == os.fstat(lock.fileno()).st_ino:
                try:
                    yield
                finally:
                    path.unlink(missing_ok=True)
                return


def _prune_cache(build_cache: Path) -> None:
    """Keep the newest cache entries; an evicted one only costs a rebuild."""
    entries = []
    for path in build_cache.glob("*.json"):
        try:
            entries.append((path.stat().st_mtime, path))
        except FileNotFoundError:  # another build pruned it
            pass
    for _, path in sorted(entries)[:-_MAX_CACHE_ENTRIES]:
        path.unlink(missing_ok=True)


def _build(
    docker: str, root: Path, source: str, package: dict[str, Any], lockfile: str | None
) -> dict[str, Any]:
    workspace = Path(tempfile.mkdtemp(prefix="page-build-", dir=root / "build-cache")).resolve()
    # a saved lockfile names its own download sources, so it gets a cache no other build reads
    if lockfile is None:
        package_cache = root / "package-cache"
        package_cache.mkdir(mode=0o700, parents=True, exist_ok=True)
    else:
        package_cache = Path(f"{workspace}-cache")
        package_cache.mkdir(mode=0o700)
    try:
        (workspace / "src").mkdir()
        (workspace / "src/Page.tsx").write_text(source, encoding="utf-8")
        (workspace / "package.json").write_text(
            json.dumps(package, sort_keys=True), encoding="utf-8"
        )
        if lockfile is not None:
            (workspace / "bun.lock").write_text(lockfile, encoding="utf-8")
        installed = _install(
            docker,
            workspace,
            package_cache.resolve(),
            list(package["dependencies"]),
            frozen=lockfile is not None,
        )
        warnings = installed.pop("warnings") + _bundle(docker, workspace)
        artifact = _collect(docker, workspace)
        digest = hashlib.sha256(artifact).hexdigest()
        destination = root / "bundles" / f"{digest}.js"
        if not destination.is_file():
            atomic_private_write(destination, artifact)
        return {
            "digest": digest,
            "size": len(artifact),
            "dependencies": package["dependencies"],
            **installed,
            "warnings": warnings[:20],
        }
    finally:
        shutil.rmtree(workspace, ignore_errors=True)
        if lockfile is not None:
            shutil.rmtree(package_cache, ignore_errors=True)
