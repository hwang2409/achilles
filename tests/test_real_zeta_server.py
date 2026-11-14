import ast
import json
import os
import threading
from pathlib import Path

_SERVER = Path(__file__).parents[1] / "scripts" / "real-zeta-server.py"
_TREE = ast.parse(_SERVER.read_text())
_FUNCTION = next(node for node in _TREE.body if isinstance(node, ast.FunctionDef))
_NAMESPACE = {"Path": Path, "json": json, "os": os}
exec(compile(ast.Module(body=[_FUNCTION], type_ignores=[]), _SERVER, "exec"), _NAMESPACE)


def test_control_writes_are_always_complete(tmp_path):
    control = tmp_path / "control.json"
    write_control = _NAMESPACE["write_control"]
    write_control(control, {"value": 0})
    errors = []

    def writer():
        for value in range(1_000):
            write_control(control, {"value": value})

    def reader():
        while writer_thread.is_alive():
            try:
                document = json.loads(control.read_text())
                assert isinstance(document["value"], int)
            except (AssertionError, json.JSONDecodeError, FileNotFoundError) as error:
                errors.append(error)

    writer_thread = threading.Thread(target=writer)
    reader_thread = threading.Thread(target=reader)
    writer_thread.start()
    reader_thread.start()
    writer_thread.join()
    reader_thread.join()

    assert not errors
