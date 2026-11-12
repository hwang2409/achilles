from __future__ import annotations

import argparse
import json
import os
import socket


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--socket", required=True)
    p.add_argument("--record", required=True)
    a = p.parse_args()
    try:
        os.unlink(a.socket)
    except FileNotFoundError:
        pass
    seen = {}
    requests = 0
    with socket.socket(socket.AF_UNIX) as s:
        s.bind(a.socket)
        s.listen()
        print(json.dumps({"ready": True, "socket": a.socket}), flush=True)
        while True:
            c, _ = s.accept()
            with c:
                line = c.recv(65536)
                if not line:
                    continue
                try:
                    req = json.loads(line)
                    assert (
                        req["version"] == 1
                        and isinstance(req["key"], str)
                        and len(req["key"]) < 256
                        and isinstance(req["text"], str)
                        and len(req["text"]) < 1500
                        and req["priority"] in {"normal", "alert"}
                    )
                    requests += 1
                    key = req["key"]
                    outcome = "duplicate" if key in seen else "sent"
                    seen[key] = True
                    response = {"version": 1, "outcome": outcome, "message_id": "fixture:" + key}
                except Exception:
                    response = {
                        "version": 1,
                        "outcome": "rejected",
                        "message_id": "fixture:invalid",
                    }
                open(a.record, "w").write(
                    json.dumps(
                        {"requests": requests, "notifications": len(seen), "keys": sorted(seen)}
                    )
                )
                c.sendall((json.dumps(response) + "\n").encode())


if __name__ == "__main__":
    main()
