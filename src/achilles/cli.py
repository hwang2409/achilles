from __future__ import annotations

import argparse

from . import __version__


def main() -> None:
    parser = argparse.ArgumentParser(prog="achilles")
    parser.add_argument("--version", action="version", version=f"%(prog)s {__version__}")
    subparsers = parser.add_subparsers(dest="command")
    serve = subparsers.add_parser("serve")
    serve.add_argument("--host", default="127.0.0.1")
    serve.add_argument("--port", default=5190, type=int)
    args = parser.parse_args()
    if args.command == "serve":
        import uvicorn

        uvicorn.run("achilles.web:create_app", factory=True, host=args.host, port=args.port)
