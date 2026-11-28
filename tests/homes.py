"""The one rule for test homes: helpers that build the app or start zeta refuse the real homes."""

import os
import tempfile
from pathlib import Path

import achilles.web as web

_ROOTS = (Path(tempfile.gettempdir()).resolve(), Path("/tmp").resolve())
# only the docker probe_root fixture keeps homes under .cache, in .cache/test-build-*
_CACHE = (Path(__file__).resolve().parents[1] / ".cache").resolve()


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
            or not (
                any(home.is_relative_to(root) for root in _ROOTS)
                or any(home.is_relative_to(build) for build in _CACHE.glob("test-build-*"))
            )
        ):
            raise RuntimeError(
                f"{name} is {raw or 'unset'}; test helpers never touch the real {default}. "
                f"set {name} to a temp dir; run through pytest"
            )


def app():
    """The only way tests build the web app: refuse the real homes first."""
    require_test_homes()
    return web.create_app()
