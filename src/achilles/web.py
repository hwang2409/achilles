from __future__ import annotations

import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from .verdicts import detail, list_verdicts


def serve(db: Path, root: Path, host: str, port: int):
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            if self.path == "/health":
                self.send_json({"ok": True})
                return
            if self.path == "/api/verdicts":
                self.send_json(list_verdicts(db))
                return
            if self.path.startswith("/api/verdicts/"):
                value = detail(db, self.path.rsplit("/", 1)[-1])
                if value is None:
                    self.send_error(404)
                    return
                self.send_json(value)
                return
            relative = self.path.lstrip("/") or "index.html"
            target = (root / relative).resolve()
            if not str(target).startswith(str(root.resolve())) or not target.is_file():
                target = (root / "index.html").resolve()
            if not target.exists():
                self.send_error(404)
                return
            self.send_response(200)
            content_type = (
                "text/css"
                if target.suffix == ".css"
                else "application/javascript"
                if target.suffix == ".js"
                else "text/html"
            )
            self.send_header("Content-Type", content_type + "; charset=utf-8")
            self.end_headers()
            self.wfile.write(target.read_bytes())

        def send_json(self, value):
            body = json.dumps(value).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *args):
            pass

    server = ThreadingHTTPServer((host, port), Handler)
    print(json.dumps({"ready": True, "port": server.server_port}), flush=True)
    server.serve_forever()
