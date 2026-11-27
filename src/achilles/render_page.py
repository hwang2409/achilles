from __future__ import annotations

import json
import os
import shutil
import signal
import subprocess
from pathlib import Path
from typing import Any

_RUNNER = Path(__file__).parents[2] / "scripts/render-page.ts"
RENDER_TIMEOUT_SECONDS = 20
# the runner bounds its own output; this cap only guards against a broken runner
_MAX_OUTPUT_BYTES = 4 * 1024 * 1024

RENDER_PAGE_SCHEMA = {
    "type": "object",
    "properties": {"route": {"type": "string"}, "page_id": {"type": "string"}},
    "additionalProperties": False,
}


class RenderError(RuntimeError):
    pass


def render_page(
    origin: str, page_id: str, credential: str, timeout: float = RENDER_TIMEOUT_SECONDS
) -> dict[str, Any]:
    """Render the page's live frame in headless chromium at 1440 x 900; never writes records.
    Returns the runner's bounded result; `screenshot` is base64 JPEG when the page got ready."""
    bun = shutil.which("bun")
    if bun is None:
        raise RenderError("render_page needs bun on PATH")
    payload = {"origin": origin, "pageId": page_id, "credential": credential}
    process = subprocess.Popen(
        [bun, str(_RUNNER)],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        start_new_session=True,
    )
    try:
        # the runner stops at its own deadline and closes chromium; the kill below is the backstop
        stdout, stderr = process.communicate(
            json.dumps({**payload, "timeoutMs": int(timeout * 1000)}).encode(), timeout=timeout + 15
        )
    except subprocess.TimeoutExpired:
        raise RenderError(f"render_page runner did not stop within {timeout + 15:.0f} s") from None
    finally:
        # whatever the runner left behind (chromium, helpers) dies with its process group
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except (ProcessLookupError, PermissionError):  # macOS: EPERM when only zombies remain
            pass
        process.communicate()
    if process.returncode != 0 or len(stdout) > _MAX_OUTPUT_BYTES:
        raise RenderError(
            "render_page runner failed: " + stderr.decode(errors="replace").strip()[-2000:]
        )
    try:
        return json.loads(stdout)
    except ValueError:
        raise RenderError("render_page runner returned output that is not JSON") from None
