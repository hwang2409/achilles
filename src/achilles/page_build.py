from __future__ import annotations

import base64
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


def _install(docker: str, workspace: Path, cache: Path) -> None:
    result = _run_container(
        docker,
        workspace,
        cache,
        ["bun", "install", "--ignore-scripts"],
        network="bridge",
        step="package install",
    )
    _check_step(result, "package.json")


def _bundle(docker: str, workspace: Path) -> None:
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


def _collect(docker: str, workspace: Path, dependencies: list[str]) -> dict[str, Any]:
    script = """import {readFileSync} from 'node:fs';
const names=JSON.parse(process.argv[1]);
const resolved=Object.fromEntries(names.map(name=>{
 const path=`node_modules/${name}/package.json`;
 return [name,JSON.parse(readFileSync(path,'utf8')).version];
}));
const value=JSON.stringify({
 artifact:readFileSync('page.js').toString('base64'),
 lockfile:readFileSync('bun.lock','utf8'),
 resolved_dependencies:resolved
});
console.log(value);
"""
    result = _run_container(
        docker,
        workspace,
        None,
        ["bun", "-e", script, json.dumps(dependencies)],
        network="none",
        step="page result collector",
    )
    _check_step(result, "page build result")
    try:
        value = json.loads(result.stdout)
        artifact = base64.b64decode(value["artifact"], validate=True)
        lockfile = value["lockfile"]
        resolved = value["resolved_dependencies"]
    except (KeyError, TypeError, ValueError, json.JSONDecodeError) as exc:
        raise PageBuildError("page build returned an invalid result") from exc
    if (
        not isinstance(lockfile, str)
        or not isinstance(resolved, dict)
        or set(resolved) != set(dependencies)
        or any(not isinstance(value, str) for value in resolved.values())
    ):
        raise PageBuildError("page build returned an invalid result")
    return {"artifact": artifact, "lockfile": lockfile, "resolved_dependencies": resolved}


def build_page(
    root: Path, page_id: str, source: str, dependencies: dict[str, str]
) -> dict[str, Any]:
    """Bundle a browser page in a disposable container with only source and package cache."""
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
    package_cache = root / "package-cache"
    build_cache.mkdir(mode=0o700, parents=True, exist_ok=True)
    package_cache.mkdir(mode=0o700, parents=True, exist_ok=True)
    workspace = Path(tempfile.mkdtemp(prefix="page-build-", dir=build_cache)).resolve()
    package_cache = package_cache.resolve()
    package = {
        "private": True,
        "type": "module",
        "dependencies": {"react": "19.0.0", "react-dom": "19.0.0", **dependencies},
    }
    try:
        (workspace / "src").mkdir()
        (workspace / "src/Page.tsx").write_text(source, encoding="utf-8")
        (workspace / "package.json").write_text(
            json.dumps(package, sort_keys=True), encoding="utf-8"
        )
        _install(docker, workspace, package_cache)
        _bundle(docker, workspace)
        result = _collect(docker, workspace, list(package["dependencies"]))
        artifact = result.pop("artifact")
        digest = hashlib.sha256(artifact).hexdigest()
        destination = root / "bundles" / f"{digest}.js"
        destination.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        if not destination.exists():
            destination.write_bytes(artifact)
            destination.chmod(0o600)
        return {
            "digest": digest,
            "size": len(artifact),
            "dependencies": package["dependencies"],
            **result,
        }
    finally:
        shutil.rmtree(workspace, ignore_errors=True)
