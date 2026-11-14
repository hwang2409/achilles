#!/usr/bin/env python3
import fcntl
import os
import signal
import subprocess
import sys
import time
from pathlib import Path


def holder_status(value: str) -> str:
    try:
        pid = int(value)
    except ValueError:
        return "invalid"
    status = subprocess.run(
        ["ps", "-p", str(pid), "-o", "stat="],
        check=False,
        capture_output=True,
        text=True,
    )
    return status.stdout.strip() if status.returncode == 0 else "missing"


# dead holder: macOS CI can delay kernel flock release; this grace is bounded.
def wait_for_dead_holder_release(lock: object, holder: str) -> bool:
    for _attempt in range(50):
        time.sleep(0.01)
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            return True
        except BlockingIOError:
            continue
    return False


def main() -> int:
    lock_path = Path(__file__).resolve().parents[1] / ".cache" / "dev" / "lock"
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    with lock_path.open("a+", encoding="utf-8") as lock:
        os.fchmod(lock.fileno(), 0o600)
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            lock.seek(0)
            holder = lock.read().strip()
            status = holder_status(holder)
            if status not in {"missing"} and not status.startswith("Z"):
                suffix = f" (pid {holder})" if holder else ""
                print(
                    f"make dev is already running{suffix} (live holder, ps state {status})",
                    file=sys.stderr,
                )
                return 1
            if not wait_for_dead_holder_release(lock, holder):
                print(
                    f"make dev is already running (pid {holder}) "
                    f"(dead-holder grace exhausted, ps state {status})",
                    file=sys.stderr,
                )
                return 1

        lock.seek(0)
        lock.truncate()
        lock.write(str(os.getpid()))
        lock.flush()

        child = subprocess.Popen(sys.argv[1:])

        def forward(signum: int, _frame: object) -> None:
            child.send_signal(signum)

        signal.signal(signal.SIGINT, forward)
        signal.signal(signal.SIGTERM, forward)
        return child.wait()


if __name__ == "__main__":
    raise SystemExit(main())
