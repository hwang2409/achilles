import { expect, test } from "bun:test";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { mcpDecision, ownedProcessMatches, serveDecision } from "./dev";

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

async function stop(pid: number) {
  if (!alive(pid)) return;
  process.kill(pid, "SIGTERM");
  await waitFor(() => !alive(pid), `pid ${pid} to stop`);
}

test("serve discovery requires a live zeta process and an exact origin", () => {
  expect(serveDecision(null, "http://127.0.0.1:43002", null).kind).toBe("start");
  expect(serveDecision({ pid: 123, port: 43003, origins: ["http://127.0.0.1:43002"] }, "http://127.0.0.1:43002", zetaCommand).kind).toBe("reuse");
  const localhost = serveDecision({ pid: 123, port: 43003, origins: ["http://localhost:43002"] }, "http://127.0.0.1:43002", zetaCommand);
  expect(localhost).toMatchObject({ kind: "reuse", origin: "http://localhost:43002" });
  expect(serveDecision({ pid: 123, port: 43003, origins: [] }, "http://127.0.0.1:43002", zetaCommand)).toEqual({
    kind: "origin-missing",
    command: `${zetaCommand} --ws-origin 'http://127.0.0.1:43002'`,
  });
  expect(serveDecision({ pid: 123, port: 43003, origins: ["https://example.test"] }, "http://127.0.0.1:43002", zetaCommand).kind).toBe("origin-missing");
  expect(serveDecision({ pid: 123, port: 43003, origins: ["http://127.0.0.1:43002"] }, "http://127.0.0.1:43002", null).kind).toBe("start");
  expect(serveDecision({ pid: 123, port: 43003, origins: ["http://127.0.0.1:43002"] }, "http://127.0.0.1:43002", "python unrelated.py").kind).toBe("start");
});

test("an existing different MCP entry is left unchanged with an exact fix command", () => {
  expect(mcpDecision({ transport: "stdio", url: "http://old.test" }, "http://127.0.0.1:43002/mcp/")).toEqual({
    kind: "different",
    command: "zeta mcp remove achilles --scope user && zeta mcp add --scope user --url 'http://127.0.0.1:43002/mcp/' achilles",
  });
});

test("stop ownership requires pid, start time, and exact command", () => {
  const saved = { pid: 123, started: "Mon Jan  1 00:00:00 2024", command: "zeta serve --ws 43003" };
  expect(ownedProcessMatches(saved, { ...saved })).toBe(true);
  expect(ownedProcessMatches(saved, { ...saved, started: "Tue Jan  2 00:00:00 2024" })).toBe(false);
  expect(ownedProcessMatches(saved, { ...saved, command: "zeta serve --ws 43004" })).toBe(false);
  expect(ownedProcessMatches(saved, null)).toBe(false);
});

test("the real dev entry preserves MCP wiring and owns its process lifecycle", async () => {
  const temp = await mkdtemp(resolve(tmpdir(), "achilles-dev-test-"));
  const home = resolve(temp, "home");
  const bin = resolve(temp, "bin");
  const calls = resolve(temp, "zeta-calls.jsonl");
  const serverPids = resolve(temp, "server-pids.jsonl");
  const webStamp = resolve(root, ".cache/web-build.stamp");
  const devCache = resolve(root, ".cache/dev");
  const oldWebStamp = await Bun.file(webStamp).exists() ? await readFile(webStamp) : null;
  const managed: number[] = [];
  let zetaPid = 0;
  let foreignPid = 0;

  await mkdir(resolve(home, "run"), { recursive: true });
  await mkdir(bin, { recursive: true });
  for (const state of ["achilles.json", "zeta-serve.json", "lock"]) {
    if (await Bun.file(resolve(devCache, state)).exists()) throw new Error("refusing to replace existing make dev state");
  }
  await rm(devCache, { recursive: true, force: true });
  await mkdir(resolve(root, ".cache"), { recursive: true });
  await writeFile(webStamp, "test-web-stamp-1");

  const fakeServer = resolve(temp, "server.ts");
  await writeFile(fakeServer, `import { appendFileSync } from "node:fs";
const port = Number(process.argv[process.argv.indexOf("--port") + 1] ?? process.argv[2]);
appendFileSync(process.env.FAKE_SERVER_PIDS!, JSON.stringify({ pid: process.pid }) + "\\n");
const server = Bun.serve({ port, hostname: "127.0.0.1", fetch(request) { return Response.json({ url: new URL(request.url).origin }); } });
for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, () => { server.stop(true); process.exit(0); });
await new Promise(() => {});
`);
  await writeFile(resolve(bin, "uv"), `#!/bin/sh\nif [ "$1 $2 $3" = "run achilles serve" ]; then exec bun ${JSON.stringify(fakeServer)} "$@"; fi\nexit 0\n`);
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
if (args[0] === "serve") {
  const ws = Number(args[args.indexOf("--ws") + 1]);
  const origin = args[args.indexOf("--ws-origin") + 1];
  const run = resolve(process.env.ZETA_HOME!, "run"); mkdirSync(run, { recursive: true });
  writeFileSync(resolve(run, "serve.ws.json"), JSON.stringify({ pid: process.pid, port: ws, origins: [origin] }));
  for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, () => process.exit(0));
  await new Promise(() => {});
}
if (args.includes("--help")) { console.log("add show remove --scope --json --url"); process.exit(0); }
if (args[0] === "mcp" && args[1] === "show") {
  console.log(JSON.stringify({ config: { transport: "streamable-http", url: process.env.FAKE_MCP_URL } })); process.exit(0);
}
process.exit(0);
`);
  await Promise.all(["uv", "open", "zeta"].map((name) => chmod(resolve(bin, name), 0o755)));

  const port = await freePort();
  const ws = await freePort();
  const baseEnv = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    PORT: String(port),
    ZETA_HOME: home,
    ACHILLES_DEV_SKIP_BUILD: "1",
    FAKE_MCP_URL: `http://127.0.0.1:${port}/mcp/`,
    FAKE_ZETA_CALLS: calls,
    FAKE_SERVER_PIDS: serverPids,
  };
  const runDev = async (env = baseEnv) => {
    const child = Bun.spawn(["bun", "scripts/dev.ts"], { cwd: root, env, stdout: "pipe", stderr: "pipe" });
    const exitCode = await child.exited;
    return { exitCode, stdout: await new Response(child.stdout).text(), stderr: await new Response(child.stderr).text() };
  };

  try {
    const zeta = Bun.spawn([fakeZeta, "serve", "--port", String(await freePort()), "--ws", String(ws), "--ws-origin", `http://localhost:${port}`], { env: baseEnv, stdout: "ignore", stderr: "ignore" });
    zetaPid = zeta.pid;
    await waitFor(() => Bun.file(resolve(home, "run/serve.ws.json")).exists(), "zeta discovery");

    const first = await runDev();
    expect(first.exitCode, first.stderr).toBe(0);
    expect(first.stdout).toContain("mcp.json: unchanged");
    const callsAfterFirst = (await readFile(calls, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as string[]);
    expect(callsAfterFirst.some((args) => args[0] === "mcp" && ["add", "remove"].includes(args[1]) && !args.includes("--help"))).toBe(false);
    const firstState = JSON.parse(await readFile(resolve(devCache, "achilles.json"), "utf8"));
    managed.push(firstState.pid);
    expect(alive(firstState.pid)).toBe(true);

    const second = await runDev();
    expect(second.exitCode, second.stderr).toBe(0);
    const secondState = JSON.parse(await readFile(resolve(devCache, "achilles.json"), "utf8"));
    expect(secondState.pid).toBe(firstState.pid);

    await writeFile(webStamp, "test-web-stamp-2");
    const third = await runDev();
    expect(third.exitCode, third.stderr).toBe(0);
    const thirdState = JSON.parse(await readFile(resolve(devCache, "achilles.json"), "utf8"));
    managed.push(thirdState.pid);
    expect(thirdState.pid).not.toBe(firstState.pid);
    expect(alive(firstState.pid)).toBe(false);
    expect(alive(thirdState.pid)).toBe(true);
    expect(thirdState.stamp).not.toBe(firstState.stamp);

    const block = resolve(temp, "block");
    const held = Bun.spawn(["bun", "scripts/dev.ts"], { cwd: root, env: { ...baseEnv, FAKE_ZETA_BLOCK: block }, stdout: "pipe", stderr: "pipe" });
    await waitFor(() => Bun.file(`${block}.ready`).exists(), "first make dev to hold its lock");
    const concurrent = await runDev({ ...baseEnv, FAKE_ZETA_BLOCK: block });
    expect(concurrent.exitCode).toBe(1);
    expect(concurrent.stderr).toContain(`make dev is already running (pid ${held.pid})`);
    await writeFile(`${block}.release`, "release");
    expect(await held.exited).toBe(0);

    await stop(thirdState.pid);
    await rm(resolve(devCache, "achilles.json"));
    const foreign = Bun.spawn(["bun", fakeServer, "--port", String(port)], { env: baseEnv, stdout: "ignore", stderr: "ignore" });
    foreignPid = foreign.pid;
    await waitFor(async () => { try { return (await fetch(`http://127.0.0.1:${port}/`)).ok; } catch { return false; } }, "foreign listener");
    const foreignRun = await runDev();
    expect(foreignRun.exitCode, foreignRun.stderr).toBe(0);
    expect(foreignRun.stdout).toContain(`kill ${foreign.pid} && make dev PORT=${port}`);
    expect(alive(foreign.pid)).toBe(true);
  } finally {
    let started: number[] = [];
    try { started = (await readFile(serverPids, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line).pid); } catch {}
    for (const pid of [foreignPid, ...started.reverse(), ...managed.reverse(), zetaPid]) await stop(pid);
    await rm(devCache, { recursive: true, force: true });
    if (oldWebStamp === null) await rm(webStamp, { force: true }); else await writeFile(webStamp, oldWebStamp);
    await rm(temp, { recursive: true, force: true });
  }
}, 60_000);
