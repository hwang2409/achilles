from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import Any


class PageBuildError(ValueError):
    def __init__(self, diagnostics: str):
        super().__init__(diagnostics)
        self.diagnostics = diagnostics


def build_page(
    root: Path, page_id: str, source: str, dependencies: dict[str, str]
) -> dict[str, Any]:
    """Bundle a browser page in a private, environment-scrubbed workspace."""
    if not isinstance(source, str) or not source.strip():
        raise PageBuildError("src/Page.tsx:1:1: page source is empty")
    if not isinstance(dependencies, dict) or any(
        not isinstance(k, str) or not isinstance(v, str) or not k or not v
        for k, v in dependencies.items()
    ):
        raise PageBuildError("package.json:1:1: dependencies must be a string map")
    cache = root / "build-cache"
    cache.mkdir(mode=0o700, parents=True, exist_ok=True)
    workspace = Path(tempfile.mkdtemp(prefix="page-build-", dir=cache))
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
        env = {
            "PATH": os.environ.get("PATH", ""),
            "HOME": str(workspace / "home"),
            "TMPDIR": str(workspace / "tmp"),
        }
        (workspace / "home").mkdir()
        (workspace / "tmp").mkdir()
        install = subprocess.run(
            ["bun", "install"],
            cwd=workspace,
            env=env,
            text=True,
            capture_output=True,
            timeout=120,
        )
        if install.returncode:
            raise PageBuildError(
                "package.json:1:1: " + (install.stderr or install.stdout).strip()[-4000:]
            )
        output = workspace / "page.js"
        bundle = subprocess.run(
            [
                "bun",
                "build",
                "src/Page.tsx",
                "--outfile",
                str(output),
                "--target=browser",
                "--format=esm",
                "--minify",
            ],
            cwd=workspace,
            env=env,
            text=True,
            capture_output=True,
            timeout=120,
        )
        if bundle.returncode:
            raise PageBuildError((bundle.stderr or bundle.stdout).strip()[-4000:])
        artifact = output.read_bytes()
        digest = hashlib.sha256(artifact).hexdigest()
        destination = root / "bundles" / f"{digest}.js"
        destination.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        if not destination.exists():
            destination.write_bytes(artifact)
            destination.chmod(0o600)
        lock = (
            (workspace / "bun.lock").read_text(encoding="utf-8")
            if (workspace / "bun.lock").exists()
            else ""
        )
        return {
            "digest": digest,
            "size": len(artifact),
            "dependencies": package["dependencies"],
            "lock": lock,
        }
    finally:
        shutil.rmtree(workspace, ignore_errors=True)
