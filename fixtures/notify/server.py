from __future__ import annotations

import argparse
import json
import os
import socket


def read_line(conn: socket.socket, cap: int = 8192) -> bytes:
    data = bytearray()
    while len(data) <= cap:
        chunk = conn.recv(min(1024, cap + 1 - len(data)))
        if not chunk:
            break
        data.extend(chunk)
        if b"\n" in data:
            return bytes(data[: data.index(b"\n")])
    raise ValueError("invalid request line")


def valid(req: object) -> dict:
    if not isinstance(req, dict) or set(req) != {"version", "key", "text", "not_after", "priority"}:
        raise ValueError("invalid request")
    if (
        type(req["version"]) is not int
        or req["version"] != 1
        or not isinstance(req["key"], str)
        or not 0 < len(req["key"]) < 256
        or not isinstance(req["text"], str)
        or len(req["text"]) >= 1500
        or type(req["not_after"]) is not int
        or req["priority"] not in {"normal", "alert"}
    ):
        raise ValueError("invalid request")
    return req


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--socket", required=True)
    p.add_argument("--record", required=True)
    a = p.parse_args()
    try:
        os.unlink(a.socket)
    except FileNotFoundError:
        pass
    seen: set[str] = set()
    requests = 0
    with socket.socket(socket.AF_UNIX) as server:
        server.bind(a.socket)
        server.listen()
        print(json.dumps({"ready": True, "socket": a.socket}), flush=True)
        while True:
            conn, _ = server.accept()
            with conn:
                try:
                    req = valid(json.loads(read_line(conn)))
                    requests += 1
                    key = req["key"]
                    outcome = "duplicate" if key in seen else "sent"
                    seen.add(key)
                    response = {"version": 1, "outcome": outcome, "message_id": "fixture:" + key}
                except (ValueError, json.JSONDecodeError, UnicodeDecodeError):
                    response = {
                        "version": 1,
                        "outcome": "rejected",
                        "message_id": "fixture:invalid",
                    }
                Path = open(a.record, "w")
                Path.write(
                    json.dumps(
                        {"requests": requests, "notifications": len(seen), "keys": sorted(seen)}
                    )
                )
                Path.close()
                conn.sendall((json.dumps(response) + "\n").encode())


if __name__ == "__main__":
    main()
