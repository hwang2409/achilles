import ast
import asyncio
import json
import os
import threading
from pathlib import Path
from types import SimpleNamespace

_SERVER = Path(__file__).parents[1] / "scripts" / "real-zeta-server.py"
_TREE = ast.parse(_SERVER.read_text())
_FUNCTIONS = [
    node
    for node in _TREE.body
    if isinstance(node, ast.FunctionDef | ast.AsyncFunctionDef)
    and node.name in {"write_control", "read_control", "hold"}
]


def _load(asyncio_module=asyncio) -> dict:
    namespace = {"Path": Path, "json": json, "os": os, "asyncio": asyncio_module}
    module = ast.Module(body=_FUNCTIONS, type_ignores=[])
    exec(compile(module, _SERVER, "exec"), namespace)
    return namespace


_NAMESPACE = _load()


def test_control_writes_are_always_complete(tmp_path):
    control = tmp_path / "control.json"
    write_control = _NAMESPACE["write_control"]
    write_control(control, {"value": 0})
    errors = []

    def writer():
        try:
            for value in range(1_000):
                write_control(control, {"value": value})
        except BaseException as error:
            errors.append(error)

    def reader():
        try:
            while writer_thread.is_alive():
                try:
                    document = json.loads(control.read_text())
                    assert isinstance(document["value"], int)
                except (AssertionError, json.JSONDecodeError, FileNotFoundError) as error:
                    errors.append(error)
        except BaseException as error:
            errors.append(error)

    writer_thread = threading.Thread(target=writer, daemon=True)
    reader_thread = threading.Thread(target=reader, daemon=True)
    writer_thread.start()
    reader_thread.start()
    writer_thread.join(timeout=10)
    reader_thread.join(timeout=10)
    assert not writer_thread.is_alive(), "writer thread hung"
    assert not reader_thread.is_alive(), "reader thread hung"
    assert not errors


def test_hold_reads_a_partial_control_file_as_not_yet(tmp_path):
    # the gate once wrote control.json in place: a poll read half of it and the
    # JSONDecodeError killed zeta's turn inside finalize_turn
    asyncio.run(_partial_control_file_scenario(tmp_path / "control.json"))


async def _partial_control_file_scenario(control: Path) -> None:
    polls: asyncio.Queue = asyncio.Queue()

    async def sleep(_seconds):
        # each poll of hold() parks here until the test lets it go on
        step = asyncio.get_running_loop().create_future()
        await polls.put(step)
        await step

    namespace = _load(SimpleNamespace(sleep=sleep))
    namespace["write_control"](control, {"port": 1})
    held = asyncio.create_task(namespace["hold"](control, "late_turn_barrier"))
    next_poll = asyncio.create_task(polls.get())
    try:
        step = await asyncio.wait_for(next_poll, 10)
        document = json.loads(control.read_text())
        assert document == {"port": 1, "late_turn_barrier": "held"}
        full = json.dumps({**document, "release_late_turn_barrier": True})
        control.write_text(full[: len(full) // 2])
        step.set_result(None)
        next_poll = asyncio.create_task(polls.get())
        done, _ = await asyncio.wait({held, next_poll}, timeout=10, return_when="FIRST_COMPLETED")
        assert held not in done, f"a partial control file ended the hold: {held.exception()!r}"
        assert next_poll in done, "hold made no next poll after the partial read"
        next_poll.result().set_result(None)
        next_poll = asyncio.create_task(polls.get())
        step = await asyncio.wait_for(next_poll, 10)
        assert not held.done(), "hold must wait for a complete release"
        control.write_text(full)
        step.set_result(None)
        assert await asyncio.wait_for(held, 10) is None
    finally:
        held.cancel()
        next_poll.cancel()


def test_proof_servers_refuse_a_missing_or_real_zeta_home(monkeypatch, tmp_path):
    import importlib.util

    import pytest

    spec = importlib.util.spec_from_file_location("proof_home", _SERVER.parent / "proof_home.py")
    proof_home = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(proof_home)
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    monkeypatch.setenv("ZETA_PROOF_WORKTREE", str(tmp_path / "worktree"))
    monkeypatch.delenv("ZETA_HOME")
    with pytest.raises(RuntimeError, match="set ZETA_HOME to a temp dir"):
        proof_home.private_proof_home()
    monkeypatch.setenv("ZETA_HOME", str(tmp_path / "home/.zeta"))
    with pytest.raises(RuntimeError, match="never use ~/.zeta"):
        proof_home.private_proof_home()
    monkeypatch.setenv("ZETA_HOME", str(tmp_path / "zeta"))
    assert proof_home.private_proof_home() == (tmp_path / "zeta").resolve()
    assert list(tmp_path.iterdir()) == []
