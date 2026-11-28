"""The one rule for test homes: helpers that build the app or start zeta refuse the real homes."""

import os
import tempfile
from pathlib import Path

_ROOTS = (
    Path(tempfile.gettempdir()).resolve(),
    Path("/tmp").resolve(),
    (Path(__file__).resolve().parents[1] / ".cache").resolve(),
)


def require_test_homes() -> None:
    """Raise unless ACHILLES_HOME and ZETA_HOME both name a temp dir, never the real default."""
    for name, default in (
        ("ACHILLES_HOME", Path.home() / ".local/share/achilles"),
        ("ZETA_HOME", Path.home() / ".zeta"),
    ):
        raw = os.environ.get(name)
        home = Path(raw).resolve() if raw else None
        if (
            home is None
            or home.is_relative_to(default.resolve())
            or not any(home.is_relative_to(root) for root in _ROOTS)
        ):
            raise RuntimeError(
                f"{name} is {raw or 'unset'}; test helpers never touch the real {default}. "
                f"set {name} to a temp dir; run through pytest"
            )
