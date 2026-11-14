#!/usr/bin/env python3
import fcntl
import os
import signal
import subprocess
import sys
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
            suffix = f" (pid {holder})" if holder else ""
            print(
                f"make dev is already running{suffix} (lock holder ps state {status})",
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
