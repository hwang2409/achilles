import base64
import hashlib
import json
import os
import shutil
import socket
import subprocess
import threading
from pathlib import Path

import httpx
import pytest
from test_web import running_http_app

import achilles.render_page as render_page_module
import achilles.web as web
from achilles.pages import PageStore
from achilles.render_page import render_page

_CHROMIUM = Path.home() / (
    "Library/Caches/ms-playwright" if Path("/Library").is_dir() else ".cache/ms-playwright"
)
_RUNNER_READY = (
    shutil.which("bun") is not None
    and (Path(web.__file__).parents[2] / "apps/web/node_modules/playwright").is_dir()
    and any(_CHROMIUM.glob("chromium_headless_shell-*"))
)
# real chromium: runs where the web deps and playwright chromium are installed (CI evals job, local)
# the CI step that has chromium sets ACHILLES_RENDER_TESTS=required, so a broken setup fails there
pytestmark = pytest.mark.skipif(
    not _RUNNER_READY and os.environ.get("ACHILLES_RENDER_TESTS") != "required",
    reason="needs bun, apps/web deps, chromium",
)

DELAYED = """
const root = document.getElementById("root");
root.innerHTML = "<h1>loading</h1>";
const items = await window.achilles.records.list("items");
root.innerHTML = "<h1>ready</h1>" + items.map((item) => "<p>" + item.title + "</p>").join("");
"""
FAULTS = """
document.getElementById("root").innerHTML = "<h1>faults</h1>";
console.error("boom-console");
Promise.reject(new Error("boom-rejection"));
fetch("http://127.0.0.1:%d/missing").catch(() => {});
window.achilles.records.insert("items", { title: "should not save" }).catch(() => {});
"""
POLLING = """
document.getElementById("root").innerHTML = "<h1>polling</h1>";
setInterval(() => fetch(location.href).catch(() => {}), 100);
"""
# random noise does not compress: the screenshot is far larger than one 64 KiB pipe buffer
NOISE = """
const canvas = document.createElement("canvas");
canvas.width = 1440; canvas.height = 900;
document.body.style.margin = "0";
document.getElementById("root").append(canvas);
const pixels = canvas.getContext("2d").createImageData(1440, 900);
for (let i = 0; i < pixels.data.length; i++)
  pixels.data[i] = i % 4 === 3 ? 255 : Math.random() * 256;
canvas.getContext("2d").putImageData(pixels, 0, 0);
"""
# an LLM page styles itself with a <style> element and shows a data: image
STYLED = """
const style = document.createElement("style");
style.textContent = "h1 { color: rgb(1, 2, 3); }";
document.head.append(style);
const image = new Image();
image.src = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
document.getElementById("root").append(image);
await image.decode().catch(() => {});
const h1 = document.createElement("h1");
document.body.append(h1);
h1.textContent = "color " + getComputedStyle(h1).color + " image " + image.naturalWidth;
"""
CONFIRM_DELETE = """
const confirmed = confirm("delete stretch?");
document.getElementById("root").textContent = "confirmed " + confirmed;
if (confirmed) await window.achilles.records.delete("items", "r1").catch(() => {});
"""
HUNG = "document.getElementById('root').textContent = 'spin'; for (;;) {}"


def _home_with_code(root: Path, source: str) -> PageStore:
    store = PageStore(root)
    store.set_create_mode("home", True)
    digest = hashlib.sha256(source.encode()).hexdigest()
    (root / "bundles" / f"{digest}.js").write_text(source)
    with store.transaction() as db:
        db.execute(
            "INSERT INTO code_revision(page_id,version,source,dependencies,digest,"
            "artifact_size,diagnostics,runtime_error,created_at) VALUES(?,?,?,?,?,?,?,?,?)",
            ("home", 1, "source", "{}", digest, len(source), None, None, "2025-01-01"),
        )
        db.execute("UPDATE page SET active_code_revision=1 WHERE id='home'")
    return store


def _closed_port() -> int:
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


def _record_count(store: PageStore) -> int:
    with store.transaction() as db:
        return db.execute("SELECT count(*) FROM page_record").fetchone()[0]


def _mcp_render(port: int, token: str) -> dict:
    headers = {
        "authorization": f"Bearer {token}",
        "accept": "application/json, text/event-stream",
        "content-type": "application/json",
    }
    with httpx.Client(base_url=f"http://127.0.0.1:{port}", headers=headers, timeout=60) as client:
        initialized = client.post(
            "/mcp/",
            json={
                "jsonrpc": "2.0",
                "id": 1,
                "method": "initialize",
                "params": {
                    "protocolVersion": "2025-03-26",
                    "capabilities": {},
                    "clientInfo": {"name": "test", "version": "1"},
                },
            },
        )
        client.headers["mcp-session-id"] = initialized.headers["mcp-session-id"]
        listed = client.post(
            "/mcp/", json={"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}}
        ).json()["result"]["tools"]
        assert "render_page" in [tool["name"] for tool in listed]
        return client.post(
            "/mcp/",
            json={
                "jsonrpc": "2.0",
                "id": 3,
                "method": "tools/call",
                "params": {"name": "render_page", "arguments": {}},
            },
        ).json()["result"]


@pytest.fixture
def served(monkeypatch, tmp_path):
    monkeypatch.setenv("ACHILLES_HOME", str(tmp_path / "achilles"))
    monkeypatch.setenv("ZETA_HOME", str(tmp_path / "zeta"))
    return running_http_app


def test_render_returns_an_image_and_waits_for_bridge_content(served, tmp_path) -> None:
    store = _home_with_code(tmp_path / "achilles", DELAYED)
    store.insert_record("home", "items", {"title": "from the real records"})
    token = store.ensure_credential("home")
    with served(web.create_app()) as port:
        result = _mcp_render(port, token)
    assert not result.get("isError"), result
    image, text = result["content"]
    assert image["type"] == "image" and image["mimeType"] == "image/jpeg"
    assert base64.b64decode(image["data"])[:2] == b"\xff\xd8"
    report = json.loads(text["text"])
    assert report["ready"] is True
    # the list reply arrives after load; ready waits for it
    assert "from the real records" in report["text"] and "loading" not in report["text"]
    assert report["bridge_calls"] == ["list items"]


def test_render_reports_errors_with_context_and_blocks_writes(served, tmp_path) -> None:
    store = _home_with_code(tmp_path / "achilles", FAULTS % _closed_port())
    token = store.ensure_credential("home")
    with served(web.create_app()) as port:
        result = _mcp_render(port, token)
    report = json.loads(result["content"][-1]["text"])
    assert any(
        "boom-console" in line and "/artifact/" in line for line in report["console_errors"]
    ), report
    assert any("boom-rejection" in line for line in report["page_errors"]), report
    assert any("/missing" in line for line in report["failed_requests"]), report
    assert report["bridge_rejections"] == [
        "insert items: writes are blocked during render_page; nothing was saved"
    ]
    assert _record_count(store) == 0


def test_inline_styles_and_data_images_render(served, tmp_path) -> None:
    store = _home_with_code(tmp_path / "achilles", STYLED)
    token = store.ensure_credential("home")
    with served(web.create_app()) as port:
        result = render_page(f"http://127.0.0.1:{port}", "home", token)
    assert "color rgb(1, 2, 3) image 1" in result["text"], result
    assert result["console_errors"] == [] and result["failed_requests"] == [], result


def test_confirm_is_accepted_and_reported_so_a_render_never_hangs(served, tmp_path) -> None:
    store = _home_with_code(tmp_path / "achilles", CONFIRM_DELETE)
    token = store.ensure_credential("home")
    with served(web.create_app()) as port:
        result = render_page(f"http://127.0.0.1:{port}", "home", token)
    assert result["ready"] is True and "confirmed true" in result["text"], result
    assert result["dialogs"] == ["confirm: delete stretch?"]
    assert result["bridge_calls"] == ["delete items"]


def test_polling_page_times_out_with_a_fallback_screenshot(served, tmp_path) -> None:
    store = _home_with_code(tmp_path / "achilles", POLLING)
    token = store.ensure_credential("home")
    with served(web.create_app()) as port:
        result = render_page(f"http://127.0.0.1:{port}", "home", token, timeout=3)
    assert result["ready"] is False and result["timed_out"] is True
    assert "network-idle" in result["note"]
    assert base64.b64decode(result["screenshot"])[:2] == b"\xff\xd8"


def test_large_screenshot_reaches_the_caller_whole(served, tmp_path) -> None:
    store = _home_with_code(tmp_path / "achilles", NOISE)
    token = store.ensure_credential("home")
    with served(web.create_app()) as port:
        result = render_page(f"http://127.0.0.1:{port}", "home", token)
    image = base64.b64decode(result["screenshot"])
    assert result["ready"] is True and len(image) > 64 * 1024 and image[-2:] == b"\xff\xd9"


def test_deadline_note_is_absent_when_the_screenshot_is_omitted(
    served, monkeypatch, tmp_path
) -> None:
    # the real runner with only its image bound lowered, so both jpeg qualities are too large
    runner = render_page_module._RUNNER
    text = runner.read_text()
    small = text.replace("const MAX_IMAGE = 1024 * 1024;", "const MAX_IMAGE = 1;").replace(
        '"../apps/web/', f'"{runner.parents[1]}/apps/web/'
    )
    assert small.count("MAX_IMAGE = 1;") == 1 and small.count(str(runner.parents[1])) == 1
    (tmp_path / "render-page.ts").write_text(small)
    monkeypatch.setattr(render_page_module, "_RUNNER", tmp_path / "render-page.ts")
    store = _home_with_code(tmp_path / "achilles", POLLING)
    token = store.ensure_credential("home")
    with served(web.create_app()) as port:
        result = render_page(f"http://127.0.0.1:{port}", "home", token, timeout=3)
    assert result["timed_out"] is True and "screenshot" not in result
    assert "omitted" in result["screenshot_note"]
    assert "note" not in result, result["note"]


def _processes() -> dict[int, tuple[int, str]]:
    listing = subprocess.run(
        ["ps", "-axww", "-o", "pid=,ppid=,command="], capture_output=True, text=True, check=True
    ).stdout
    rows = (line.split(None, 2) for line in listing.splitlines())
    return {int(row[0]): (int(row[1]), row[2] if len(row) > 2 else "") for row in rows}


def test_hung_page_times_out_and_leaves_no_chromium(served, monkeypatch, tmp_path) -> None:
    store = _home_with_code(tmp_path / "achilles", HUNG)
    token = store.ensure_credential("home")
    # playwright puts chromium's profile under TMPDIR, so this path names only our browser
    marker = str(tmp_path / "render-tmp")
    Path(marker).mkdir()
    monkeypatch.setenv("TMPDIR", marker)
    ours: set[int] = set()
    stop = threading.Event()

    def watch() -> None:
        # the browser plus its helper processes, once a helper (the hung renderer) exists
        while not stop.is_set() and not ours:
            table = _processes()
            browsers = {pid for pid, (_, command) in table.items() if marker in command}
            helpers = {pid for pid, (parent, _) in table.items() if parent in browsers}
            if browsers and helpers:
                ours.update(browsers | helpers)

    watcher = threading.Thread(target=watch)
    with served(web.create_app()) as port:
        watcher.start()
        try:
            result = render_page(f"http://127.0.0.1:{port}", "home", token, timeout=3)
        finally:
            stop.set()
            watcher.join(10)
    assert ours, "chromium was never observed, so the leak check below would prove nothing"
    assert result["ready"] is False and result["timed_out"] is True
    assert "within 3 s" in result["error"]
    table = _processes()
    assert [pid for pid in ours if pid in table] == []
    assert [pid for pid, (_, command) in table.items() if marker in command] == []


# another site (localhost is a different site from 127.0.0.1) tries to read and run the bundle,
# then the achilles origin embeds the real sandboxed frame
_ORIGIN_PROBE = """
import { chromium } from "%(playwright)s";
const port = %(port)d;
const artifact = `http://127.0.0.1:${port}/api/pages/home/artifact/%(digest)s`;
const probe = `<!doctype html><script>
window.__probe = (async () => {
  const fetched = await fetch(${JSON.stringify(artifact)})
    .then(r => r.text()).then(() => "read", () => "blocked");
  const script = await new Promise(resolve => {
    const tag = document.createElement("script");
    tag.src = ${JSON.stringify(artifact)};
    tag.onload = tag.onerror = () => resolve(window.__ran ? "ran" : "not run");
    document.head.append(tag);
  });
  return { fetch: fetched, script };
})();
</script>`;
const sandbox = "allow-scripts allow-forms allow-downloads allow-modals";
const host = `<!doctype html><iframe sandbox="${sandbox}" src="/api/pages/home/frame"></iframe>`;
const serve = (body) => (route) => route.fulfill({ contentType: "text/html", body });
const text = () => document.getElementById("root")?.textContent ?? "";
const browser = await chromium.launch({ headless: true });
try {
  // worst case: the user granted the other site local network access, so only achilles decides
  const context = await browser.newContext({ permissions: ["local-network-access"] });
  const page = await context.newPage();
  await page.route(`http://localhost:${port}/probe`, serve(probe));
  await page.route(`http://127.0.0.1:${port}/host`, serve(host));
  await page.goto(`http://localhost:${port}/probe`);
  const other = await page.evaluate(() => (window as any).__probe);
  await page.goto(`http://127.0.0.1:${port}/host`);
  const frame = page.frames().find((item) => item !== page.mainFrame())!;
  await frame.waitForFunction(text, null, { timeout: 10000 }).catch(() => {});
  console.log(JSON.stringify({ ...other, frame: await frame.evaluate(text) }));
} finally {
  await browser.close();
}
"""
RUNS_ANYWHERE = """
const root = document.getElementById("root");
if (root) root.textContent = "frame ran";
window.__ran = true;
"""


def test_another_origin_cannot_read_or_run_a_page_bundle(served, tmp_path) -> None:
    _home_with_code(tmp_path / "achilles", RUNS_ANYWHERE)
    digest = hashlib.sha256(RUNS_ANYWHERE.encode()).hexdigest()
    playwright = Path(web.__file__).parents[2] / "apps/web/node_modules/playwright/index.mjs"
    with served(web.create_app()) as port:
        script = tmp_path / "origin-probe.ts"
        script.write_text(
            _ORIGIN_PROBE % {"playwright": playwright, "port": port, "digest": digest}
        )
        done = subprocess.run(
            ["bun", str(script)], capture_output=True, text=True, timeout=60, check=False
        )
    assert done.returncode == 0, done.stderr
    result = json.loads(done.stdout.strip().splitlines()[-1])
    assert result == {"fetch": "blocked", "script": "not run", "frame": "frame ran"}
