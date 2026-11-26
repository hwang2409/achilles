from __future__ import annotations

import base64
import hashlib
import json
import os
import re
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import Any

_BUILD_IMAGE = "oven/bun@sha256:87416c977a612a204eb54ab9f3927023c2a3c971f4f345a01da08ea6262ae30e"
_LOCAL_SPEC = re.compile(r"^(?:file|link):|^(?:/|[A-Za-z]:[\\/])")
_MAX_RESULT_BYTES = 16 * 1024 * 1024


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
):
    try:
        mounts = ["--mount", f"type=bind,src={workspace},dst=/workspace"]
        cache_env: list[str] = []
        if cache is not None:
            mounts += ["--mount", f"type=bind,src={cache},dst=/cache"]
            cache_env = ["--env=BUN_INSTALL_CACHE_DIR=/cache"]
        return subprocess.run(
            [
                docker,
                "run",
                "--rm",
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
            text=True,
            capture_output=True,
            timeout=180,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise PageBuildError(
            f"page build isolation is unavailable: {exc}", "build_unavailable"
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
if(Buffer.byteLength(value)>16777216)throw new Error('page build result exceeds 16 MiB');
console.log(value);
"""
    result = _run_container(
        docker,
        workspace,
        None,
        ["bun", "-e", script, json.dumps(dependencies)],
        network="none",
    )
    _check_step(result, "page build result")
    if len(result.stdout.encode()) > _MAX_RESULT_BYTES:
        raise PageBuildError("page build result exceeds 16 MiB")
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
