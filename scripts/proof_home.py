"""The one rule for zeta proof servers: ZETA_HOME is a private temp home, never ~/.zeta."""

import os
import tempfile
from pathlib import Path

_FIX = "set ZETA_HOME to a temp dir; run through bun scripts/real-zeta-gate.ts"


def private_proof_home() -> Path:
    raw = os.environ.get("ZETA_HOME")
    worktree = os.environ.get("ZETA_PROOF_WORKTREE")
    if not raw or not worktree:
        raise RuntimeError("proof servers require ZETA_HOME and ZETA_PROOF_WORKTREE. " + _FIX)
    home = Path(raw).resolve()
    default = (Path.home() / ".zeta").resolve()
    if home == default or home.is_relative_to(default):
        raise RuntimeError("proof servers never use ~/.zeta. " + _FIX)
    if (
        not home.is_relative_to(Path(tempfile.gettempdir()).resolve())
        and not home.is_relative_to(Path("/tmp").resolve())
        and not home.is_relative_to(Path(worktree).resolve())
    ):
        raise RuntimeError("ZETA_HOME must be under /tmp or the proof worktree. " + _FIX)
    return home
