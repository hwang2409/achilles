import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const fixtureRoot = Bun.env.ACHILLES_TEST_FIXTURE_SOURCE ?? root;
const uv = Bun.which("uv")!;

async function fixtureZeta(revision: string) {
  for (const path of [join(fixtureRoot, ".cache", `zeta-${revision}`), join(fixtureRoot, ".cache", "zeta")]) {
    if (await Bun.file(join(path, ".git", "HEAD")).exists()) return path;
  }
}
async function fixturesReady() {
  const revision = (await readFile(join(root, "zeta.rev"), "utf8")).trim();
  return Boolean(uv && await fixtureZeta(revision) && await Bun.file(join(fixtureRoot, "apps", "web", "node_modules", "playwright", "index.mjs")).exists());
}

async function checkout() {
  const parent = await mkdtemp(join(tmpdir(), "achilles-eval-behavior-"));
  const target = join(parent, "target");
  const sha = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: root }).stdout.toString().trim();
  const clone = Bun.spawnSync(["git", "clone", "--shared", "--quiet", root, target]);
  if (clone.exitCode) throw new Error(clone.stderr.toString());
  const detached = Bun.spawnSync(["git", "checkout", "--detach", "--quiet", sha], { cwd: target });
  if (detached.exitCode) throw new Error(detached.stderr.toString());
  await mkdir(join(target, ".cache"), { recursive: true });
  const zetaRev = (await readFile(join(target, "zeta.rev"), "utf8")).trim();
  await symlink(join(fixtureRoot, ".cache", "fulcrum"), join(target, ".cache", "fulcrum"));
  await symlink((await fixtureZeta(zetaRev))!, join(target, ".cache", `zeta-${zetaRev}`));
  await mkdir(join(target, "vendor"), { recursive: true });
  await symlink(join(fixtureRoot, "vendor", "fulcrum"), join(target, "vendor", "fulcrum"));
  await symlink(join(fixtureRoot, "apps", "web", "node_modules"), join(target, "apps", "web", "node_modules"));
  // two evals' `uv run` would otherwise build this new venv at once, and one can import a half-installed package
  const sync = Bun.spawnSync([uv, "sync", "--project", target, "--quiet"]);
  if (sync.exitCode) throw new Error(sync.stderr.toString());
  return { parent, target };
}

async function runEval(target: string, task: string, extraEnv: Record<string, string> = {}) {
  const report = extraEnv.REPORT_DIR ?? join(target, "report");
  const child = Bun.spawn(["bun", "scripts/eval.ts", "--suite", task], {
    cwd: target,
    env: { ...process.env, EVAL_BACKEND: "scripted", EVAL_SKIP_BROWSER_INSTALL: "1", REPORT_DIR: report, BASE: "none", PATH: `${join(target, "test-bin")}:${process.env.PATH}`, ...extraEnv },
    stdout: "pipe",
    stderr: "pipe",
  });
  const output = Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
  const timed = await Promise.race([child.exited.then(code => ({ code, timeout: false })), Bun.sleep(45_000).then(() => ({ code: -1, timeout: true }))]);
  if (timed.timeout) {
    child.kill("SIGTERM");
    if (await Promise.race([child.exited.then(() => false), Bun.sleep(5_000).then(() => true)])) { child.kill("SIGKILL"); await child.exited; }
  }
  const [stdout, stderr] = await output;
  expect(timed.timeout, `eval exceeded 45 seconds\n${stdout}\n${stderr}`).toBe(false);
  const reportPath = join(report, "report.json");
  expect(await Bun.file(reportPath).exists(), `eval exited ${timed.code} without a report\n${stdout}\n${stderr}`).toBe(true);
  const row = JSON.parse(await readFile(reportPath, "utf8"));
  return { code: timed.code, stdout, stderr, task: row.tasks[0] };
}

async function installUvWrapper(target: string, body = "") {
  const directory = join(target, "test-bin");
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "uv"), `#!/bin/sh\n${body}\nexec ${JSON.stringify(uv)} "$@"\n`);
  await chmod(join(directory, "uv"), 0o755);
}

test("the scripted eval repairs missing target web assets before zeta starts", async () => {
  if (!await fixturesReady()) return;
  const { parent, target } = await checkout();
  try {
    await rm(join(target, "apps", "web", "dist"), { recursive: true, force: true });
    const packagePath = join(target, "apps", "web", "package.json");
    const packageJson = JSON.parse(await readFile(packagePath, "utf8"));
    packageJson.scripts.build = "bun ../../scripts/test-web-build.ts";
    await writeFile(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);
    await writeFile(join(target, "scripts", "test-web-build.ts"), 'await Bun.write(new URL("../apps/web/dist/index.html", import.meta.url), "<!doctype html><body>smoke</body>");\n');
    const task = JSON.parse(await readFile(join(target, "evals", "tasks", "harness-smoke.json"), "utf8"));
    task.id = "preflight-build";
    task.checks = [{ id: "page", type: "page_exists", page: "smoke" }];
    await writeFile(join(target, "evals", "tasks", "preflight-build.json"), JSON.stringify(task));
    const marker = join(parent, "zeta-started-after-build");
    await installUvWrapper(target, `case " $* " in *" zeta "*" serve "*) if test -f ${JSON.stringify(join(target, "apps/web/dist/index.html"))}; then printf built; else printf missing; fi > ${JSON.stringify(marker)};; esac`);

    const result = await runEval(target, "preflight-build");
    expect(result.task.status, JSON.stringify(result.task)).toBe("pass");
    expect(await Bun.file(marker).text(), `zeta did not start after the target build\n${result.stdout}\n${result.stderr}`).toBe("built");
  } finally { await rm(parent, { recursive: true, force: true }); }
}, 55_000);

test("two evals in one checkout do not break each other's target web repair", async () => {
  if (!await fixturesReady()) return;
  const { parent, target } = await checkout();
  try {
    await rm(join(target, "apps", "web", "dist"), { recursive: true, force: true });
    const builds = join(parent, "builds"); await mkdir(builds);
    const packagePath = join(target, "apps", "web", "package.json");
    const packageJson = JSON.parse(await readFile(packagePath, "utf8"));
    packageJson.scripts.build = "bun ../../scripts/test-web-build.ts";
    await writeFile(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);
    // forces the bad order: the second build empties dist after the first build wrote it, before the first eval checks it
    await writeFile(join(target, "scripts", "test-web-build.ts"), `
import { mkdir, rm, writeFile } from "node:fs/promises";
const builds = ${JSON.stringify(builds)}; const dist = new URL("../apps/web/dist/", import.meta.url).pathname;
const waitFor = async (path: string) => { for (let i = 0; i < 60 && !await Bun.file(path).exists(); i++) await Bun.sleep(50); };
const write = async () => { await mkdir(dist, { recursive: true }); await writeFile(dist + "index.html", "<!doctype html><body>smoke</body>"); };
if (await mkdir(builds + "/first").then(() => true, () => false)) { await waitFor(builds + "/second-started"); await write(); await waitFor(builds + "/second-emptied"); }
else { await writeFile(builds + "/second-started", ""); await waitFor(dist + "index.html"); await rm(dist, { recursive: true, force: true }); await writeFile(builds + "/second-emptied", ""); await Bun.sleep(2_000); await write(); }
`);
    const task = JSON.parse(await readFile(join(target, "evals", "tasks", "harness-smoke.json"), "utf8"));
    task.id = "shared-build"; task.checks = [{ id: "page", type: "page_exists", page: "smoke" }];
    await writeFile(join(target, "evals", "tasks", "shared-build.json"), JSON.stringify(task));

    const results = await Promise.all(["a", "b"].map(name => runEval(target, "shared-build", { REPORT_DIR: join(parent, `report-${name}`) })));
    for (const result of results) expect(result.task.status, JSON.stringify(result.task)).toBe("pass");
    expect(await Bun.file(join(builds, "second-started")).exists(), "the second eval rebuilt web assets the first eval had already repaired").toBe(false);
  } finally { await rm(parent, { recursive: true, force: true }); }
}, 55_000);

test("two evals that pick the same achilles port each use their own achilles", async () => {
  if (!await fixturesReady()) return;
  const { parent, target } = await checkout();
  try {
    // forces the bad order: the second eval is handed the first eval's achilles port once, before either server binds it
    const stackPath = join(target, "scripts", "eval-stack.ts"); const stackSource = await readFile(stackPath, "utf8"); const portFile = join(parent, "achilles-port");
    expect(stackSource).toContain("const achillesPort = await freePort();");
    await writeFile(stackPath, stackSource.replace("const achillesPort = await freePort();", `const achillesPort = await (async () => { const fs = await import("node:fs"); const port = await freePort(); try { fs.writeFileSync(${JSON.stringify(portFile)}, String(port), { flag: "wx" }); return port; } catch { const taken = fs.readFileSync(${JSON.stringify(portFile)}, "utf8"); if (!taken) return port; fs.writeFileSync(${JSON.stringify(portFile)}, ""); return Number(taken); } })();`));
    await mkdir(join(target, "apps", "web", "dist"), { recursive: true });
    await writeFile(join(target, "apps", "web", "dist", "index.html"), "<!doctype html><body>ready</body>");
    const results = await Promise.all(["a", "b"].map(name => runEval(target, "harness-smoke", { REPORT_DIR: join(parent, `report-${name}`) })));
    expect(await readFile(portFile, "utf8"), "the second eval was not handed the first eval's port").toBe("");
    for (const result of results) expect(result.task.status, JSON.stringify(result.task)).toBe("pass");
  } finally { await rm(parent, { recursive: true, force: true }); }
}, 55_000);

test("a queued accepted delivery becomes a structured harness error at the task deadline", async () => {
  if (!await fixturesReady()) return;
  const { parent, target } = await checkout();
  try {
    const evalPath = join(target, "scripts", "eval.ts");
    const evalSource = await readFile(evalPath, "utf8");
    // the deadline fires as soon as zeta accepts the delivery; a short TASK_TIMEOUT_MS could fire during setup instead
    const accepted = "deliveries.set(deliveryId, await protocol.send(session.id, step.prompt ?? task.prompt!, deliveryId));";
    expect(evalSource).toContain(accepted);
    await writeFile(evalPath, evalSource.replace(accepted, `${accepted} timeout.abort(new Error("task deadline exceeded"));`));
    await mkdir(join(target, "apps", "web", "dist"), { recursive: true });
    await writeFile(join(target, "apps", "web", "dist", "index.html"), "<!doctype html><body>ready</body>");
    const evidence = join(parent, "delivery-evidence.json");
    await writeFile(join(target, "scripts", "fake-zeta-serve.ts"), `
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
const args = process.argv.slice(2); const port = Number(args[args.indexOf("--ws") + 1]); const origin = args[args.indexOf("--ws-origin") + 1]; const evidence = ${JSON.stringify(evidence)}; const deliveries = new Map();
const server = Bun.serve({ port, hostname: "127.0.0.1", fetch(request, server) { if (server.upgrade(request, { headers: { "Sec-WebSocket-Protocol": "zeta.v1" } })) return; return new Response("upgrade required", { status: 426 }); }, websocket: { async message(socket, raw) { const row = JSON.parse(String(raw)); let result = {};
if (row.method === "hello") result = { capabilities: { features: row.params.features } };
else if (row.method === "new_session") result = { session: { session_id: "queued-session" } };
else if (row.method === "send") { deliveries.set(row.params.delivery_id, "queued"); result = { status: "queued" }; }
else if (row.method === "delivery_status") { result = { delivery_id: row.params.delivery_id, status: deliveries.get(row.params.delivery_id) }; await Bun.write(evidence, JSON.stringify({ method: row.method, ...result })); }
else if (row.method === "session_history") result = { messages: [], next_offset: null };
else if (row.method === "abort") result = {};
socket.send(JSON.stringify({ jsonrpc: "2.0", id: row.id, result })); }, close() {} } });
const home = process.env.ZETA_HOME; await mkdir(join(home, "run"), { recursive: true }); await Bun.write(join(home, "run/serve.ws.json"), JSON.stringify({ port: server.port, pid: process.pid, controller_token: "synthetic-controller", observer_token: "synthetic-observer", origins: [origin] }));
await new Promise(() => {});
`);
    const fakeLog = join(parent, "fake-zeta.log");
    await installUvWrapper(target, `case " $* " in *" zeta "*" serve "*) exec bun ${JSON.stringify(join(target, "scripts", "fake-zeta-serve.ts"))} "$@" >>${JSON.stringify(fakeLog)} 2>&1;; esac`);

    const result = await runEval(target, "harness-smoke");
    const serverLog = await Bun.file(fakeLog).text().catch(() => "");
    expect(result.task.status, `${JSON.stringify(result.task)}\n${serverLog}`).toBe("harness_error");
    expect(result.task.checks[0].evidence, `${JSON.stringify(result.task)}\n${serverLog}`).toEqual(expect.objectContaining({ message: expect.stringMatching(/^zeta: delivery .+ never resolved$/), delivery_status: "queued" }));
    expect(JSON.parse(await readFile(evidence, "utf8")), "delivery_status was not requested from the scripted serve").toEqual(expect.objectContaining({ method: "delivery_status", status: "queued" }));
  } finally { await rm(parent, { recursive: true, force: true }); }
}, 55_000);
