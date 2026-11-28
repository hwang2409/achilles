import ast
from pathlib import Path

# calls that open the default achilles home when ACHILLES_HOME is unset
_HOME_OPENERS = {"create_app", "_home", "_database"}


def test_tests_build_the_app_only_through_the_guarded_factory() -> None:
    offenders = []
    for path in sorted(Path(__file__).parent.rglob("*.py")):
        if path.name == "homes.py":
            continue
        for node in ast.walk(ast.parse(path.read_text(), str(path))):
            if isinstance(node, ast.Call):
                func = node.func
                name = func.attr if isinstance(func, ast.Attribute) else getattr(func, "id", "")
                home_store = name == "PageStore" and ".home()" in ast.unparse(node)
                if name in _HOME_OPENERS or home_store:
                    offenders.append(f"{path.name}:{node.lineno} {name}()")
    assert offenders == [], (
        "tests build the app or open the default home only through homes.app() in tests/homes.py, "
        f"which refuses the real homes first: {offenders}"
    )
