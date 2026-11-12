from __future__ import annotations

import json
import queue
import subprocess
import threading
from collections.abc import Sequence


def start_ready(command: Sequence[str], timeout: float = 5) -> tuple[subprocess.Popen[str], dict]:
    proc = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    assert proc.stdout is not None
    lines: queue.Queue[str] = queue.Queue()
    threading.Thread(target=lambda: lines.put(proc.stdout.readline()), daemon=True).start()
    try:
        line = lines.get(timeout=timeout)
        if not line:
            raise RuntimeError(f"child exited {proc.poll()}; stderr unavailable")
        return proc, json.loads(line)
    except Exception:
        proc.terminate()
        try:
            proc.wait(timeout=2)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait()
        raise


def stop(proc: subprocess.Popen[str]) -> None:
    proc.terminate()
    try:
        proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait()
