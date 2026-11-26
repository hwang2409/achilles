from __future__ import annotations

import hashlib
import json
import re
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import Any

_BUILD_IMAGE = "oven/bun@sha256:87416c977a612a204eb54ab9f3927023c2a3c971f4f345a01da08ea6262ae30e"
_LOCAL_SPEC = re.compile(r"^(?:file|link):|^(?:/|[A-Za-z]:[\\/])")


class PageBuildError(ValueError):
    def __init__(self, diagnostics: str, code: str = "compile_error"):
        super().__init__(diagnostics)
        self.diagnostics = diagnostics
        self.code = code


def _run_container(docker: str, workspace: Path, cache: Path, command: list[str]):
    try:
        return subprocess.run(
            [
                docker,
                "run",
                "--rm",
                "--network=bridge",
                "--mount",
                f"type=bind,src={workspace},dst=/workspace",
                "--mount",
                f"type=bind,src={cache},dst=/cache",
                "--workdir=/workspace",
                "--env=HOME=/tmp/home",
                "--env=BUN_INSTALL_CACHE_DIR=/cache",
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
    try:
        (workspace / "src").mkdir()
        (workspace / "src/Page.tsx").write_text(source, encoding="utf-8")
        package = {
            "private": True,
            "type": "module",
            "dependencies": {"react": "19.0.0", "react-dom": "19.0.0", **dependencies},
        }
        (workspace / "package.json").write_text(
            json.dumps(package, sort_keys=True), encoding="utf-8"
        )
        install = _run_container(docker, workspace, package_cache, ["bun", "install"])
        if install.returncode:
            detail = (install.stderr or install.stdout).strip()[-4000:]
            if install.returncode == 125:
                raise PageBuildError(
                    "page build isolation is unavailable: " + detail, "build_unavailable"
                )
            raise PageBuildError("package.json:1:1: " + detail)
        bundle = _run_container(
            docker,
            workspace,
            package_cache,
            [
                "bun",
                "build",
                "src/Page.tsx",
                "--outfile",
                "page.js",
                "--target=browser",
                "--format=esm",
                "--minify",
            ],
        )
        if bundle.returncode:
            raise PageBuildError((bundle.stderr or bundle.stdout).strip()[-4000:])
        output = workspace / "page.js"
        artifact = output.read_bytes()
        digest = hashlib.sha256(artifact).hexdigest()
        destination = root / "bundles" / f"{digest}.js"
        destination.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        if not destination.exists():
            destination.write_bytes(artifact)
            destination.chmod(0o600)
        lock = (workspace / "bun.lock").read_text(encoding="utf-8")
        resolved = {
            name: json.loads((workspace / "node_modules" / name / "package.json").read_text())[
                "version"
            ]
            for name in package["dependencies"]
        }
        return {
            "digest": digest,
            "size": len(artifact),
            "dependencies": package["dependencies"],
            "resolved_dependencies": resolved,
            "lockfile": lock,
        }
    finally:
        shutil.rmtree(workspace, ignore_errors=True)
