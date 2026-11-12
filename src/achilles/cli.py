from __future__ import annotations

import argparse
import json
from pathlib import Path

from . import __version__
from .runner import run_once
from .verdicts import list_verdicts


def main() -> None:
    parser = argparse.ArgumentParser(prog="achilles")
    parser.add_argument("--version", action="version", version=f"%(prog)s {__version__}")
    sub = parser.add_subparsers(dest="command")
    run = sub.add_parser("run")
    run.add_argument("--once", action="store_true")
    run.add_argument("--manifest", type=Path, required=True)
    run.add_argument("--fixture", type=Path, required=True)
    run.add_argument("--db", type=Path, required=True)
    run.add_argument("--notify-socket", type=Path, required=True)
    v = sub.add_parser("verdict")
    vs = v.add_subparsers(dest="sub")
    ls = vs.add_parser("list")
    ls.add_argument("--db", type=Path, required=True)
    ls.add_argument("--json", action="store_true")
    sv = sub.add_parser("serve")
    sv.add_argument("--db", type=Path, required=True)
    sv.add_argument("--web-root", type=Path, required=True)
    sv.add_argument("--host", default="127.0.0.1")
    sv.add_argument("--port", type=int, default=0)
    a = parser.parse_args()
    if a.command == "run":
        print(json.dumps(run_once(a.manifest, a.fixture, a.db, a.notify_socket)))
        return
    if a.command == "verdict" and a.sub == "list":
        print(json.dumps(list_verdicts(a.db)))
        return
    if a.command == "serve":
        from .web import serve

        serve(a.db, a.web_root, a.host, a.port)
        return
    parser.error("a command is required")
