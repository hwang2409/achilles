import { expect, test } from "bun:test";
import { chmod, cp, mkdtemp, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { mcpDecision, ownedProcessMatches, processIdentity, serveDecision, webInstallDecision, zetaExecutable, zetaRemediationMessage, zetaRevisionDecision, zetaStoredFormatMessage, type ProcessIdentity } from "./dev";

const root = resolve(new URL("..", import.meta.url).pathname);
const zetaCommand = "/usr/local/bin/zeta serve --port 43001 --ws 43003 --provider ollama --model 'test model'";

async function freePort(): Promise<number> {
  for (;;) {
    const port = await new Promise<number>((ok, fail) => {
      const server = createServer();
      server.once("error", fail);
      server.listen(0, "127.0.0.1", () => { const port = (server.address() as { port: number }).port; server.close(() => ok(port)); });
    });
    if (port >= 5200) return port;
  }
}

async function waitFor(check: () => boolean | Promise<boolean>, message: string) {
  for (let i = 0; i < 100; i++) {
    if (await check()) return;
    await Bun.sleep(50);
  }
  throw new Error(`timed out waiting for ${message}`);
}

function alive(pid: number): boolean {
  const result = Bun.spawnSync(["ps", "-p", String(pid), "-o", "stat="]);
  return result.exitCode === 0 && !result.stdout.toString().trim().startsWith("Z");
}

function processesContaining(text: string): string[] {
  const result = Bun.spawnSync(["ps", "-axo", "pid=,args="]);
  return result.stdout.toString().split("\n").flatMap((line) => {
    const match = line.trim().match(/^(\d+)\s+(.*)$/);
    return match && match[2].includes(text) ? [`pid ${match[1]} ${match[2]}`] : [];
  });
}

async function diagnostic(args: string[]): Promise<string> {
  const child = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
  const [output] = await Promise.all([
    Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]).then(([stdout, stderr]) => stdout + stderr),
    child.exited,
  ]);
  return output;
}

async function killAndReap(child: Bun.Subprocess): Promise<void> {
  try { child.kill("SIGKILL"); } catch {}
  await Promise.race([
    child.exited,
    Bun.sleep(5_000).then(() => { throw new Error(`timed out reaping pid ${child.pid}`); }),
  ]);
}

async function sourceRuntimeSnapshot(): Promise<string> {
  const status = Bun.spawnSync(["git", "status", "--porcelain", "--ignored"], { cwd: root }).stdout.toString();
  const cache = Bun.spawnSync(["find", ".cache", "-print"], { cwd: root });
  return `${status}\0${cache.stdout.toString()}`;
}

async function spawnTracked(args: string[], options: Parameters<typeof Bun.spawn>[1]) {
  const child = Bun.spawn(args, options);
  const identity = await processIdentity(child.pid);
  if (!identity) throw new Error(`process ${child.pid} disappeared during startup`);
  return { child, identity };
}

async function stop(saved: ProcessIdentity, signal: NodeJS.Signals = "SIGTERM") {
  const current = await processIdentity(saved.pid);
  if (!ownedProcessMatches(saved, current)) return;
  process.kill(saved.pid, signal);
  await waitFor(() => !alive(saved.pid), `pid ${saved.pid} to stop`);
}

test("serve discovery requires a live zeta process and allows either local origin", () => {
  const requested = "http://127.0.0.1:43002";
  const localhost = "http://localhost:43002";
  expect(serveDecision(null, requested, null).kind).toBe("start");
  expect(serveDecision({ pid: 123, port: 43003, origins: [localhost] }, requested, zetaCommand)).toMatchObject({ kind: "reuse", origin: localhost });
  expect(serveDecision({ pid: 123, port: 43003, origins: [requested] }, requested, zetaCommand)).toMatchObject({ kind: "reuse", origin: requested });
  expect(serveDecision({ pid: 123, port: 43003, origins: [requested, localhost] }, requested, zetaCommand)).toMatchObject({ kind: "reuse", origin: localhost });
  expect(serveDecision({ pid: 123, port: 43003, origins: [] }, requested, zetaCommand)).toEqual({
    kind: "origin-missing",
    command: `${zetaCommand} --ws-origin '${requested}' --ws-origin '${localhost}'`,
  });
  expect(serveDecision({ pid: 123, port: 43003, origins: ["https://example.test"] }, requested, zetaCommand).kind).toBe("origin-missing");
  expect(serveDecision({ pid: 123, port: 43003, origins: [requested] }, requested, null).kind).toBe("start");
  expect(serveDecision({ pid: 123, port: 43003, origins: [requested] }, requested, "python unrelated.py").kind).toBe("start");
});

test("zeta invocations use one selected executable", () => {
  const pin = "d6776edb3a60e7207eabcd1055e01a3aab092a83";
  const cases = [
    ["default", "/repo/.cache/zeta/.venv/bin/zeta", "'/repo/.cache/zeta/.venv/bin/zeta' mcp remove achilles --scope user && '/repo/.cache/zeta/.venv/bin/zeta' mcp add --scope user --url 'http://127.0.0.1:43002/mcp/' achilles", "ok"],
    ["path", "zeta", "'zeta' mcp remove achilles --scope user && 'zeta' mcp add --scope user --url 'http://127.0.0.1:43002/mcp/' achilles", "ok"],
    ["path mismatch", "zeta", zetaRemediationMessage(pin), "behind"],
  ] as const;
  for (const [name, executable, command, kind] of cases) {
    if (kind === "behind") {
      const decision = zetaRevisionDecision(pin, "/home/u/zeta", true, false);
      expect(decision.kind, name).toBe("behind");
      expect(decision.kind === "behind" ? decision.message : "", name).toBe(command);
    }
    else expect(mcpDecision({ transport: "stdio", url: "http://old.test" }, "http://127.0.0.1:43002/mcp/", executable), name).toMatchObject({ kind: "different", command });
  }
});

test("newer stored formats produce actionable startup messages", () => {
  const log = "error: stored format 12 is newer than writer capability 11";
  expect(zetaStoredFormatMessage(log, "/tmp/home", false, "pinsha")).toBe("zeta serve cannot start for home /tmp/home: stored format 12 is newer than writer capability 11. achilles' zeta pin (zeta.rev pinsha) is older than this home (stored format 12); update achilles (git pull) or move zeta.rev to a zeta main commit with WRITER_EPOCH >= 12");
  expect(zetaStoredFormatMessage(log, "/tmp/home", true, "pinsha")).toBe("zeta serve cannot start for home /tmp/home: stored format 12 is newer than writer capability 11. your zeta is older than zeta.rev pinsha; run make dev without ACHILLES_USE_PATH_ZETA to use the pinned one");
  expect(zetaStoredFormatMessage("other failure", "/tmp/home", false, "pinsha")).toBeNull();
});

test("web dependencies install only when the web-deps stamp changed", () => {
  // The old make dev installed web deps inside the fulcrum build step, so a stamp that
  // only tracked fulcrum never saw a changed apps/web/package.json. The web-deps stamp
  // must drive the install on its own: equal stamp skips, any change installs.
  expect(webInstallDecision("web-stamp-a", "web-stamp-a")).toBe("skip");
  expect(webInstallDecision("web-stamp-a", "web-stamp-b")).toBe("install");
  expect(webInstallDecision(null, "web-stamp-a")).toBe("install");
});

test("default zeta selection is isolated and path selection is explicit", () => {
  const old = process.env.ACHILLES_USE_PATH_ZETA;
  try {
    delete process.env.ACHILLES_USE_PATH_ZETA;
    expect(zetaExecutable()).toBe(resolve(root, ".cache/zeta/.venv/bin/zeta"));
    process.env.ACHILLES_USE_PATH_ZETA = "1";
    expect(zetaExecutable()).toBe(Bun.which("zeta") ?? "zeta");
  } finally {
    if (old === undefined) delete process.env.ACHILLES_USE_PATH_ZETA;
    else process.env.ACHILLES_USE_PATH_ZETA = old;
  }
});

test("zeta remediation never mutates an installed checkout", () => {
  const pin = "d6776edb3a60e7207eabcd1055e01a3aab092a83";
  const cases = [
    ["serve too old", zetaRemediationMessage(pin)],
    ["mcp missing", `missing zeta mcp: ${zetaRemediationMessage(pin)}`],
    ["behind pin", zetaRevisionDecision(pin, "/home/u/zeta", true, false).kind === "behind" ? zetaRevisionDecision(pin, "/home/u/zeta", true, false).message : ""],
    ["not a checkout", `warning: cannot verify the installed zeta is at least the pin ${pin}: zeta is not installed from a git checkout`],
  ];
  for (const [name, text] of cases) {
    expect(text, name).not.toContain("uv tool install");
    expect(text, name).not.toContain("pull");
    expect(text, name).not.toContain("git -C '/home/u/zeta'");
  }
  expect(cases[2][1]).toBe(zetaRemediationMessage(pin));
  expect(cases[3][1]).toContain("not installed from a git checkout");
});

test("stop ownership requires pid, start time, and exact command", () => {
  const saved = { pid: 123, started: "Mon Jan  1 00:00:00 2024", command: "zeta serve --ws 43003" };
  expect(ownedProcessMatches(saved, { ...saved })).toBe(true);
  expect(ownedProcessMatches(saved, { ...saved, started: "Tue Jan  2 00:00:00 2024" })).toBe(false);
  expect(ownedProcessMatches(saved, { ...saved, command: "zeta serve --ws 43004" })).toBe(false);
  expect(ownedProcessMatches(saved, null)).toBe(false);
});

test("cleanup does not signal a reused pid", async () => {
  const { child, identity: saved } = await spawnTracked(["sleep", "30"], { stdout: "ignore", stderr: "ignore" });
  try {
    expect(saved).not.toBeNull();
    await stop({ ...saved!, started: "different start time" });
    expect(alive(child.pid)).toBe(true);
    await stop(saved!);
  } finally {
    if (saved && alive(child.pid)) await stop(saved);
    await child.exited;
  }
});

test("an old zeta fails before owned serve startup but remains valid for attach", async () => {
  const temp = await mkdtemp(resolve(tmpdir(), "achilles-old-zeta-test-"));
  const bin = resolve(temp, "bin");
  const home = resolve(temp, "home");
  const achillesHome = resolve(temp, "achilles-home");
  const calls = resolve(temp, "calls");
  const started = resolve(temp, "started");
  const webStamp = resolve(root, ".cache/web-build.stamp");
  const devCache = resolve(root, ".cache/dev");
  const oldWebStamp = await Bun.file(webStamp).exists() ? await readFile(webStamp) : null;
  await mkdir(bin, { recursive: true });
  await writeFile(resolve(bin, "zeta"), `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_ZETA_CALLS"
if [ "$1 $2" = "serve --help" ]; then echo "--ws --ws-origin"; exit 0; fi
if [ "$2" = "--help" ] || [ "$3" = "--help" ]; then echo "add show remove --scope --json --url"; exit 0; fi
if [ "$1" = "serve" ]; then touch "$FAKE_ZETA_STARTED"; exit 1; fi
exit 0
`);
  await writeFile(resolve(bin, "uv"), "#!/bin/sh\nexit 1\n");
  await Promise.all(["uv", "zeta"].map((name) => chmod(resolve(bin, name), 0o755)));
  for (const state of ["achilles.json", "zeta-serve.json", "lock"]) {
    if (await Bun.file(resolve(devCache, state)).exists()) throw new Error("refusing to replace existing make dev state");
  }
  await mkdir(resolve(root, ".cache"), { recursive: true });
  await writeFile(webStamp, "old-zeta-test-web-stamp");
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    ACHILLES_USE_PATH_ZETA: "1",
    HOME: temp,
    ZETA_HOME: home,
    ACHILLES_HOME: achillesHome,
    ACHILLES_DEV_SKIP_BUILD: "1",
    FAKE_ZETA_CALLS: calls,
    FAKE_ZETA_STARTED: started,
  };
  const runDev = async (extra: Record<string, string> = {}) => {
    const { child } = await spawnTracked(["bun", "scripts/dev.ts"], { cwd: root, env: { ...env, ...extra }, stdout: "pipe", stderr: "pipe" });
    const exitCode = await child.exited;
    return { exitCode, stderr: await new Response(child.stderr).text() };
  };

  try {
    const owned = await runDev();
    expect(owned.exitCode).not.toBe(0);
    expect(owned.stderr).toBe(zetaRemediationMessage("3ab68a2d670eeb49ee8925d52b1d741e48a5fc1f") + "\n");
    expect(owned.stderr).not.toContain("uv tool upgrade zeta");
    expect(await Bun.file(started).exists()).toBe(false);
    expect(await Bun.file(resolve(devCache, "zeta-serve.json")).exists()).toBe(false);
    expect(await Bun.file(home).exists()).toBe(false);

    const attached = await runDev({ ACHILLES_ZETA_DISCOVERY: resolve(temp, "missing-serve.json") });
    expect(attached.exitCode).not.toBe(0);
    expect(attached.stderr).not.toContain("zeta too old:");
    expect(attached.stderr).toContain("ACHILLES_ZETA_DISCOVERY does not name a live zeta serve");
    expect((await readFile(calls, "utf8")).match(/^serve --help$/gm)).toHaveLength(1);
  } finally {
    if (oldWebStamp === null) await rm(webStamp, { force: true }); else await writeFile(webStamp, oldWebStamp);
    await rm(temp, { recursive: true, force: true });
  }
});

test("the real dev entry preserves MCP wiring and owns its process lifecycle", async () => {
  const sourceSnapshot = await sourceRuntimeSnapshot();
  const temp = await mkdtemp(resolve(tmpdir(), "achilles-dev-test-"));
  const testRootPath = resolve(temp, "testRoot");
  await mkdir(testRootPath, { recursive: true });
  const testRoot = await realpath(testRootPath);
  await Promise.all([
    cp(resolve(root, "Makefile"), resolve(testRoot, "Makefile")),
    cp(resolve(root, "zeta.rev"), resolve(testRoot, "zeta.rev")),
    cp(resolve(root, "pyproject.toml"), resolve(testRoot, "pyproject.toml")),
    cp(resolve(root, "uv.lock"), resolve(testRoot, "uv.lock")),
    cp(resolve(root, "scripts/dev.ts"), resolve(testRoot, "scripts/dev.ts")),
    cp(resolve(root, "scripts/stop.ts"), resolve(testRoot, "scripts/stop.ts")),
    cp(resolve(root, "scripts/locked.py"), resolve(testRoot, "scripts/locked.py")),
    cp(resolve(root, "src/achilles"), resolve(testRoot, "src/achilles"), { recursive: true }),
  ]);
  const home = resolve(temp, "home");
  const bin = resolve(temp, "bin");
  const achillesHome = resolve(temp, "achilles-home");
  const calls = resolve(temp, "zeta-calls.jsonl");
  const serverPids = resolve(temp, "server-pids.jsonl");
  const webStamp = resolve(testRoot, ".cache/web-build.stamp");
  const devCache = resolve(testRoot, ".cache/dev");
  const managed: ProcessIdentity[] = [];
  const spawned: Bun.Subprocess[] = [];
  const discovered: ProcessIdentity[] = [];
  let zetaPid = 0;
  let foreignPid = 0;
  let crashedChildPid = 0;
  let crashedLockIdentity: ProcessIdentity | null = null;

  await mkdir(resolve(home, "run"), { recursive: true });
  await writeFile(resolve(home, "run/serve.ws.json"), "shared discovery sentinel");
  await mkdir(bin, { recursive: true });
  for (const state of ["achilles.json", "zeta-serve.json", "lock"]) {
    if (await Bun.file(resolve(devCache, state)).exists()) throw new Error("refusing to replace existing make dev state");
  }
  await rm(devCache, { recursive: true, force: true });
  await mkdir(resolve(testRoot, ".cache"), { recursive: true });
  await writeFile(webStamp, "test-web-stamp-1");

  const fakeServer = resolve(temp, "server.ts");
  await writeFile(fakeServer, `import { appendFileSync } from "node:fs";
const port = Number(process.argv[process.argv.indexOf("--port") + 1] ?? process.argv[2]);
appendFileSync(process.env.FAKE_SERVER_PIDS!, JSON.stringify({ pid: process.pid }) + "\\n");
const server = Bun.serve({ port, hostname: "127.0.0.1", fetch(request) { return Response.json({ url: new URL(request.url).origin }); } });
for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, () => { server.stop(true); process.exit(0); });
await new Promise(() => {});
`);
  await writeFile(resolve(bin, "uv"), `#!/bin/sh\nif [ "$1 $2 $3" = "run --no-project python" ]; then shift 3; exec python3 "$@"; fi\nif [ "$1 $2 $3" = "run achilles serve" ]; then exec bun ${JSON.stringify(fakeServer)} "$@"; fi\nexit 0\n`);
  await writeFile(resolve(bin, "open"), "#!/bin/sh\nexit 0\n");
  const fakeZeta = resolve(bin, "zeta");
  await writeFile(fakeZeta, `#!/usr/bin/env bun
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
appendFileSync(process.env.FAKE_ZETA_CALLS!, JSON.stringify(process.argv.slice(2)) + "\\n");
const args = process.argv.slice(2);
if (process.env.FAKE_ZETA_BLOCK && args[0] === "mcp" && args[1] === "--help") {
  writeFileSync(process.env.FAKE_ZETA_BLOCK + ".ready", "ready");
  while (!existsSync(process.env.FAKE_ZETA_BLOCK + ".release")) await Bun.sleep(20);
}
if (args.includes("--help")) {
  if (args[0] === "serve") console.log(process.env.FAKE_ZETA_OLD ? "--ws --ws-origin" : "--ws --ws-origin --ws-discovery");
  else console.log("add show remove --scope --json --url");
  process.exit(0);
}
if (args[0] === "serve") {
  const ws = Number(args[args.indexOf("--ws") + 1]);
  const origins = args.reduce<string[]>((values, arg, index) => arg === "--ws-origin" ? [...values, args[index + 1]] : values, []);
  const discovery = args[args.indexOf("--ws-discovery") + 1];
  mkdirSync(resolve(discovery, ".."), { recursive: true });
  const started = Bun.spawnSync(["ps", "-p", String(process.pid), "-o", "lstart="]).stdout.toString().trim();
  const command = Bun.spawnSync(["ps", "-o", "args=", "-p", String(process.pid)]).stdout.toString().trim();
  writeFileSync(discovery, JSON.stringify({ pid: process.pid, started, command, port: ws, origins }));
  for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, () => process.exit(0));
  const parent = Number(process.env.FAKE_PARENT_PID);
  const watchdog = setInterval(() => {
    try { process.kill(parent, 0); } catch { process.exit(0); }
    if (!existsSync(process.env.ZETA_HOME!)) process.exit(0);
  }, 200);
  await new Promise(() => {});
  clearInterval(watchdog);
}
if (args[0] === "mcp" && args[1] === "show") {
  console.log(JSON.stringify({ config: { transport: "streamable-http", url: process.env.FAKE_MCP_URL } })); process.exit(0);
}
process.exit(0);
`);
  await Promise.all(["uv", "open", "zeta"].map((name) => chmod(resolve(bin, name), 0o755)));
  const fakeGit = resolve(bin, "git");
  await writeFile(fakeGit, `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_GIT_CALLS"
case "$*" in *status*) exec /usr/bin/git "$@";; *fetch*|*checkout*) exit 0;; esac
exec /usr/bin/git "$@"
`);
  await chmod(fakeGit, 0o755);
  const cachedZeta = resolve(testRoot, ".cache/zeta/.venv/bin/zeta");
  await mkdir(resolve(testRoot, ".cache/zeta/.venv/bin"), { recursive: true });
  await writeFile(cachedZeta, await readFile(fakeZeta));
  await chmod(cachedZeta, 0o755);
  await writeFile(resolve(testRoot, ".cache/zeta/.gitignore"), ".venv/\n");
  const zetaFixture = resolve(testRoot, ".cache/zeta");
  expect(Bun.spawnSync(["git", "init", "-q", zetaFixture]).exitCode).toBe(0);
  expect(Bun.spawnSync(["git", "-C", zetaFixture, "add", ".gitignore"]).exitCode).toBe(0);
  expect(Bun.spawnSync(["git", "-C", zetaFixture, "-c", "user.email=test@example.invalid", "-c", "user.name=test", "commit", "-qm", "fixture"]).exitCode).toBe(0);

  const port = await freePort();
  const gitCalls = resolve(temp, "git-calls");
  const baseEnv = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    ACHILLES_USE_PATH_ZETA: "1",
    PORT: String(port),
    ZETA_HOME: home,
    ACHILLES_HOME: achillesHome,
    ACHILLES_DEV_SKIP_BUILD: "1",
    FAKE_MCP_URL: `http://127.0.0.1:${port}/mcp/`,
    FAKE_ZETA_CALLS: calls,
    FAKE_GIT_CALLS: gitCalls,
    FAKE_SERVER_PIDS: serverPids,
    FAKE_PARENT_PID: String(process.pid),
  };
  const track = async (args: string[], options: Parameters<typeof Bun.spawn>[1]) => {
    const tracked = await spawnTracked(args, options);
    spawned.push(tracked.child);
    return tracked;
  };
  const runDev = async (env = baseEnv) => {
    const { child } = await track(["make", "--silent", "dev"], { cwd: testRoot, env, stdout: "pipe", stderr: "pipe" });
    const exitCode = await child.exited;
    return { exitCode, stdout: await new Response(child.stdout).text(), stderr: await new Response(child.stderr).text() };
  };

  try {
    const first = await runDev();
    expect(first.exitCode, first.stderr).toBe(0);
    expect(first.stdout).toContain("mcp.json: unchanged");
    const callsAfterFirst = (await readFile(calls, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as string[]);
    const startedServe = callsAfterFirst.find((args) => args[0] === "serve" && !args.includes("--help"));
    expect(startedServe?.flatMap((arg, index) => arg === "--ws-origin" ? [startedServe[index + 1]] : [])).toEqual([`http://127.0.0.1:${port}`, `http://localhost:${port}`]);
    expect(startedServe?.[startedServe.indexOf("--ws-discovery") + 1]).toBe(resolve(achillesHome, "run/serve.json"));
    expect(await readFile(resolve(home, "run/serve.ws.json"), "utf8")).toBe("shared discovery sentinel");
    const firstZetaState = JSON.parse(await readFile(resolve(devCache, "zeta-serve.json"), "utf8")) as ProcessIdentity & { executable: string };
    expect(firstZetaState.executable).toBe(fakeZeta);
    zetaPid = firstZetaState.pid;
    discovered.push(firstZetaState);
    expect(callsAfterFirst.some((args) => args[0] === "mcp" && ["add", "remove"].includes(args[1]) && !args.includes("--help"))).toBe(false);
    const firstState = JSON.parse(await readFile(resolve(devCache, "achilles.json"), "utf8")) as ProcessIdentity & { stamp: string };
    managed.push(firstState);
    expect(alive(firstState.pid)).toBe(true);

    const second = await runDev();
    expect(second.exitCode, second.stderr).toBe(0);
    const secondState = JSON.parse(await readFile(resolve(devCache, "achilles.json"), "utf8"));
    expect(secondState.pid).toBe(firstState.pid);

    const defaultRun = await runDev({ ...baseEnv, ACHILLES_USE_PATH_ZETA: "0" });
    expect(defaultRun.exitCode, defaultRun.stderr).toBe(0);
    expect(alive(firstZetaState.pid), "switching zeta mode must stop the path-owned server").toBe(false);
    const defaultZetaState = JSON.parse(await readFile(resolve(devCache, "zeta-serve.json"), "utf8")) as ProcessIdentity & { executable: string };
    expect(defaultZetaState.executable).toBe(cachedZeta);
    expect(alive(defaultZetaState.pid)).toBe(true);
    discovered.push(defaultZetaState);

    const isolatedRoot = resolve(temp, "isolated-root");
    const isolatedCache = resolve(isolatedRoot, ".cache/zeta");
    const isolatedExecutable = resolve(isolatedCache, ".venv/bin/zeta");
    await mkdir(dirname(isolatedExecutable), { recursive: true });
    expect(Bun.spawnSync(["git", "init", isolatedCache]).exitCode).toBe(0);
    await writeFile(resolve(isolatedRoot, "zeta.rev"), "test-pin\n");
    await writeFile(isolatedExecutable, await readFile(fakeZeta));
    await chmod(isolatedExecutable, 0o755);
    const dirtyFile = resolve(isolatedCache, "dirty-test-file");
    await writeFile(dirtyFile, "must remain");
    const beforeGitCalls = (await readFile(gitCalls, "utf8")).split("\n").filter(Boolean).length;
    const dirtyRun = await runDev({ ...baseEnv, ACHILLES_ROOT: isolatedRoot, ACHILLES_USE_PATH_ZETA: "0" });
    expect(dirtyRun.exitCode).not.toBe(0);
    expect(dirtyRun.stderr).toContain(".cache/zeta has local changes; make dev will not change it\n");
    expect(await readFile(dirtyFile, "utf8")).toBe("must remain");
    const afterGitCalls = (await readFile(gitCalls, "utf8")).split("\n").filter(Boolean);
    expect(afterGitCalls.slice(beforeGitCalls).some((call) => call.includes("fetch"))).toBe(false);
    await rm(dirtyFile);

    const callsAfterSecond = (await readFile(calls, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as string[]);
    expect(callsAfterSecond.filter((args) => args[0] === "serve" && !args.includes("--help"))).toHaveLength(2);
    expect(await readFile(resolve(home, "run/serve.ws.json"), "utf8")).toBe("shared discovery sentinel");

    const ownedDiscovery = resolve(achillesHome, "run/serve.json");
    await writeFile(ownedDiscovery, "not json");
    const afterCorruptDiscovery = await runDev();
    expect(afterCorruptDiscovery.exitCode, afterCorruptDiscovery.stderr).toBe(0);
    expect(alive(firstZetaState.pid), `owned zeta serve pid ${firstZetaState.pid} survived corrupt discovery`).toBe(false);
    const secondZetaState = JSON.parse(await readFile(resolve(devCache, "zeta-serve.json"), "utf8")) as ProcessIdentity;
    discovered.push(secondZetaState);

    await rm(ownedDiscovery);
    const afterMissingDiscovery = await runDev();
    expect(afterMissingDiscovery.exitCode, afterMissingDiscovery.stderr).toBe(0);
    expect(alive(secondZetaState.pid), `owned zeta serve pid ${secondZetaState.pid} survived missing discovery`).toBe(false);
    const finalZetaState = JSON.parse(await readFile(resolve(devCache, "zeta-serve.json"), "utf8")) as ProcessIdentity;
    discovered.push(finalZetaState);
    zetaPid = finalZetaState.pid;

    await writeFile(webStamp, "test-web-stamp-2");
    const third = await runDev();
    expect(third.exitCode, third.stderr).toBe(0);
    const thirdState = JSON.parse(await readFile(resolve(devCache, "achilles.json"), "utf8")) as ProcessIdentity & { stamp: string };
    managed.push(thirdState);
    expect(thirdState.pid).not.toBe(firstState.pid);
    expect(alive(firstState.pid)).toBe(false);
    expect(alive(thirdState.pid)).toBe(true);
    expect(thirdState.stamp).not.toBe(firstState.stamp);

    const block = resolve(temp, "block");
    const { child: held } = await track(["make", "--silent", "dev"], { cwd: testRoot, env: { ...baseEnv, FAKE_ZETA_BLOCK: block }, stdout: "pipe", stderr: "pipe" });
    await waitFor(() => Bun.file(`${block}.ready`).exists(), "first make dev to hold its lock");
    const lockPid = Number(await readFile(resolve(devCache, "lock"), "utf8"));
    const concurrent = await runDev({ ...baseEnv, FAKE_ZETA_BLOCK: block });
    expect(concurrent.exitCode).toBe(2);
    expect(concurrent.stderr).toContain(`make dev is already running (pid ${lockPid})`);
    await writeFile(`${block}.release`, "release");
    expect(await held.exited).toBe(0);

    const waiter = resolve(temp, "waiter.py");
    const waiterReady = resolve(temp, "waiter-ready");
    await writeFile(waiter, `import os\nimport signal\nfrom pathlib import Path\nPath(${JSON.stringify(waiterReady)}).write_text(str(os.getpid()))\nsignal.pause()\n`);
    const launcher = resolve(temp, "launcher.py");
    const launcherReady = resolve(temp, "launcher-ready");
    const launcherRelease = resolve(temp, "launcher-release");
    await writeFile(launcher, `import os\nimport time\nfrom pathlib import Path\nPath(${JSON.stringify(launcherReady)}).write_text(str(os.getpid()))\nwhile not Path(${JSON.stringify(launcherRelease)}).exists(): time.sleep(0.01)\nos.execvp("python3", ["python3", "scripts/locked.py", "python3", ${JSON.stringify(waiter)}])\n`);
    const { child: crashed, identity: crashedIdentity } = await track(["python3", launcher], { cwd: testRoot, stdout: "pipe", stderr: "pipe" });
    await waitFor(() => Bun.file(launcherReady).exists(), "launcher identity to be captured");
    await writeFile(launcherRelease, "release");
    await waitFor(() => Bun.file(waiterReady).exists(), "locked child to start");
    crashedChildPid = Number(await readFile(waiterReady, "utf8"));
    const crashedChildIdentity = await processIdentity(crashedChildPid);
    if (crashedChildIdentity) discovered.push(crashedChildIdentity);
    const crashedLockPid = Number(await readFile(resolve(devCache, "lock"), "utf8"));
    crashedLockIdentity = crashedIdentity.pid === crashedLockPid ? crashedIdentity : null;
    const rejected = Bun.spawn(["python3", "scripts/locked.py", "python3", "-c", "pass"], { cwd: testRoot, stdout: "pipe", stderr: "pipe" });
    expect(await rejected.exited).toBe(1);
    expect(await new Response(rejected.stderr).text()).toContain(`make dev is already running (pid ${crashedLockPid})`);
    expect(crashedLockIdentity).not.toBeNull();
    expect(ownedProcessMatches(crashedIdentity, await processIdentity(crashed.pid))).toBe(false);
    crashed.kill("SIGKILL");
    await crashed.exited;
    const recovered = Bun.spawn(["python3", "scripts/locked.py", "python3", "-c", "pass"], { cwd: testRoot, stdout: "pipe", stderr: "pipe" });
    const recoveredExit = await recovered.exited;
    const recoveredStderr = await new Response(recovered.stderr).text();
    if (recoveredExit !== 0) {
      const lsof = await diagnostic(["lsof", resolve(devCache, "lock")]);
      const ps = await diagnostic(["ps", "-o", "pid,ppid,stat,command", "-p", `${crashedLockPid},${crashedChildPid}`]);
      console.error(recoveredStderr, lsof, ps);
    }
    expect(recoveredExit, recoveredStderr).toBe(0);
    await stop(crashedChildIdentity!);
    crashedChildPid = 0;

    const { child: stopped } = await track(["make", "--silent", "stop"], { cwd: testRoot, env: baseEnv, stdout: "pipe", stderr: "pipe" });
    const stopExit = await stopped.exited;
    expect(stopExit, await new Response(stopped.stderr).text()).toBe(0);
    expect(alive(thirdState.pid)).toBe(false);
    expect(alive(zetaPid)).toBe(false);
    const { child: foreign } = await track(["bun", fakeServer, "--port", String(port)], { env: baseEnv, stdout: "ignore", stderr: "ignore" });
    foreignPid = foreign.pid;
    await waitFor(async () => { try { return (await fetch(`http://127.0.0.1:${port}/`)).ok; } catch { return false; } }, "foreign listener");
    const foreignRun = await runDev();
    expect(foreignRun.exitCode, foreignRun.stderr).toBe(0);
    expect(foreignRun.stdout).toContain(`kill ${foreign.pid} && make dev PORT=${port}`);
    expect(alive(foreign.pid)).toBe(true);

    // Simulate the test process losing its temporary home before cleanup runs.
    await rm(home, { recursive: true, force: true });
    await waitFor(() => !alive(zetaPid), "fake zeta to stop after its home is removed");
  } finally {
    const cleanupErrors: string[] = [];
    const survivors = new Map<number, string>();
    const rememberSurvivor = async (pid: number, fallbackCommand: string) => {
      const current = await processIdentity(pid);
      if (current) survivors.set(pid, current.command);
      else survivors.set(pid, fallbackCommand);
    };
    for (const child of spawned) {
      const before = await processIdentity(child.pid);
      try {
        await killAndReap(child);
      } catch (error) {
        await rememberSurvivor(child.pid, before?.command ?? "direct child");
        cleanupErrors.push(String(error));
      }
    }
    const owned: ProcessIdentity[] = [...managed, ...discovered];
    const addStoredIdentity = async (path: string) => {
      try {
        const value = JSON.parse(await readFile(path, "utf8"));
        if (typeof value.pid === "number" && typeof value.started === "string" && typeof value.command === "string") owned.push(value);
      } catch {}
    };
    await addStoredIdentity(resolve(achillesHome, "run/serve.json"));
    await addStoredIdentity(resolve(devCache, "zeta-serve.json"));
    await addStoredIdentity(resolve(devCache, "achilles.json"));
    for (const saved of owned) {
      try {
        await stop(saved);
      } catch (error) {
        await rememberSurvivor(saved.pid, saved.command);
        cleanupErrors.push(String(error));
      }
    }
    for (const survivor of processesContaining(temp)) {
      const match = survivor.match(/^pid (\d+) (.*)$/);
      if (match) survivors.set(Number(match[1]), match[2]);
    }
    try { await rm(devCache, { recursive: true, force: true }); } catch (error) { cleanupErrors.push(String(error)); }
    try {
      expect(await sourceRuntimeSnapshot()).toBe(sourceSnapshot);
      await rm(temp, { recursive: true, force: true });
    } catch (error) { cleanupErrors.push(String(error)); }
    if (cleanupErrors.length || survivors.size) {
      const details = [...survivors].map(([pid, command]) => `pid ${pid} ${command}`);
      throw new Error([...cleanupErrors, ...details].join("\n"));
    }
  }
}, 60_000);

test("make dev refuses an installed zeta that predates the pin before starting serve", async () => {
  const temp = await mkdtemp(resolve(tmpdir(), "achilles-zeta-rev-test-"));
  const bin = resolve(temp, "bin");
  const home = resolve(temp, "home");
  const achillesHome = resolve(temp, "achilles-home");
  const toolDir = resolve(temp, "tool");
  const checkout = resolve(temp, "checkout");
  const started = resolve(temp, "started");
  const pin = (await readFile(resolve(root, "zeta.rev"), "utf8")).trim();
  await mkdir(bin, { recursive: true });
  await mkdir(toolDir, { recursive: true });
  await mkdir(checkout, { recursive: true });
  // A real git checkout that does not contain the pin commit, so make dev cannot confirm it is new enough.
  expect(Bun.spawnSync(["git", "init", "-q", checkout]).exitCode).toBe(0);
  await writeFile(resolve(checkout, "f"), "x");
  expect(Bun.spawnSync(["git", "-C", checkout, "add", "f"]).exitCode).toBe(0);
  expect(Bun.spawnSync(["git", "-C", checkout, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "init"]).exitCode).toBe(0);
  await writeFile(resolve(toolDir, "uv-receipt.toml"), `[tool]\neditable = "${checkout}"\n`);
  await writeFile(resolve(bin, "uv"), `#!/bin/sh\nif [ "$1 $2" = "tool list" ]; then echo "zeta v0.1.0 (${toolDir})"; exit 0; fi\nexit 0\n`);
  await writeFile(resolve(bin, "zeta"), `#!/bin/sh
case "$*" in
  "serve --help") echo "--ws --ws-origin --ws-discovery"; exit 0;;
  *--help*) echo "add show remove --scope --json --url"; exit 0;;
  serve*) : > "${started}"; exit 1;;
  *) exit 0;;
esac
`);
  await Promise.all(["uv", "zeta"].map((name) => chmod(resolve(bin, name), 0o755)));
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    ACHILLES_USE_PATH_ZETA: "1",
    HOME: temp,
    ZETA_HOME: home,
    ACHILLES_HOME: achillesHome,
    ACHILLES_DEV_SKIP_BUILD: "1",
  };
  try {
    const child = Bun.spawn(["bun", "scripts/dev.ts"], { cwd: root, env, stdout: "pipe", stderr: "pipe" });
    const exitCode = await child.exited;
    const stderr = await new Response(child.stderr).text();
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain(`your zeta is older than zeta.rev ${pin}; run make dev without ACHILLES_USE_PATH_ZETA to use the pinned one`);
    expect(stderr).not.toContain("uv tool install");
    expect(stderr).not.toContain("pull");
    expect(stderr).not.toContain(`git -C '${checkout}' fetch`);
    expect(stderr).not.toContain(`git -C '${checkout}' checkout`);
    expect(stderr).not.toContain(`git -C '${checkout}' reset`);
    expect(existsSync(started)).toBe(false);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}, 30_000);

test("web dependencies reinstall when apps/web changed even if the fulcrum build is unchanged", async () => {
  const sourceSnapshot = await sourceRuntimeSnapshot();
  const temp = await mkdtemp(resolve(tmpdir(), "achilles-web-deps-test-"));
  const testRoot = resolve(temp, "testRoot");
  const cache = resolve(testRoot, ".cache");
  await mkdir(resolve(testRoot, "apps/web"), { recursive: true });
  await Promise.all([
    cp(resolve(root, "fulcrum.rev"), resolve(testRoot, "fulcrum.rev")),
    cp(resolve(root, "scripts/dev.ts"), resolve(testRoot, "scripts/dev.ts")),
    cp(resolve(root, "apps/web/package.json"), resolve(testRoot, "apps/web/package.json")),
    cp(resolve(root, "apps/web/bun.lock"), resolve(testRoot, "apps/web/bun.lock")),
  ]);
  const bin = resolve(temp, "bin");
  const home = resolve(temp, "home");
  const achillesHome = resolve(temp, "achilles-home");
  const calls1 = resolve(temp, "bun-calls-1");
  const calls2 = resolve(temp, "bun-calls-2");
  await mkdir(bin, { recursive: true });
  await writeFile(resolve(bin, "uv"), "#!/bin/sh\nexit 0\n");
  await writeFile(resolve(bin, "zeta"), `#!/bin/sh\ncase "$*" in\n  *--help*) echo "add show remove --scope --json --url"; exit 0;;\n  *) exit 0;;\nesac\n`);
  await writeFile(resolve(bin, "git"), `#!/bin/sh
for a in "$@"; do dest="$a"; done
case "$*" in
  clone*) mkdir -p "$dest/.git" "$dest/packages/core"; echo x > "$dest/packages/core/index.ts"; exit 0;;
  *ls-files*) echo "packages/core/index.ts"; exit 0;;
  *) exit 0;;
esac
`);
  await writeFile(resolve(bin, "bun"), `#!/bin/sh\nprintf '%s\\n' "$*" >> "$FAKE_BUN_CALLS"\nexit 0\n`);
  await Promise.all(["uv", "zeta", "git", "bun"].map((name) => chmod(resolve(bin, name), 0o755)));
  const baseEnv = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    ACHILLES_ROOT: testRoot,
    ACHILLES_USE_PATH_ZETA: "1",
    HOME: temp,
    ZETA_HOME: home,
    ACHILLES_HOME: achillesHome,
    ACHILLES_ZETA_DISCOVERY: resolve(temp, "missing-serve.json"),
  };
  const runDev = async (callsFile: string) => {
    const child = Bun.spawn([process.execPath, "scripts/dev.ts"], { cwd: testRoot, env: { ...baseEnv, FAKE_BUN_CALLS: callsFile }, stdout: "pipe", stderr: "pipe" });
    const exitCode = await child.exited;
    const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
    return { exitCode, stdout, stderr, calls: existsSync(callsFile) ? await readFile(callsFile, "utf8") : "" };
  };
  try {
    // First run clones the fake fulcrum, builds the vendor, installs web deps, and writes the stamps.
    const first = await runDev(calls1);
    expect(first.stderr).toContain("does not name a live zeta serve");
    expect(first.calls).toMatch(/scripts\/fulcrum\.ts/);

    // Simulate a changed apps/web (e.g. a new dependency) while the fulcrum build is unchanged.
    await writeFile(resolve(cache, "web-deps.stamp"), "stale-apps-web-package-json");
    const second = await runDev(calls2);
    expect(second.stderr).toContain("does not name a live zeta serve");
    expect(second.stdout).toContain("fulcrum build unchanged");
    // The bug: the old make dev skipped the web install here; it must now run from its own stamp.
    expect(second.calls).toContain("scripts/fulcrum.ts --install-web");
  } finally {
    await rm(temp, { recursive: true, force: true });
    expect(await sourceRuntimeSnapshot()).toBe(sourceSnapshot);
  }
}, 30_000);
