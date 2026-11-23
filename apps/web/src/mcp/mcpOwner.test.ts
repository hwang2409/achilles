import { expect, test } from "bun:test";
import type { ZetaClient } from "@fulcrum/zeta";
import { createMcpOwner, mcpMethods, type McpAttempt, type McpOutcome } from "./mcpOwner";

const a = "a".repeat(64), b = "b".repeat(64);
const enabled = { action: "enabled", name: "fixture", scope: "user", revision: a, value: false } as const;
const trusted = { action: "trusted", name: "fixture", scope: "project", revision: a, value: true } as const;
const remove = { action: "remove", name: "fixture", scope: "project", revision: a } as const;
const row = (scope: string, value: boolean) => ({ name: "fixture", scope, enabled: value, trusted: value,
  status: value ? "configured" : "disabled", auth: "none", tool_count: 0, config: { transport: "stdio", command: "<redacted>" } });
const list = (revision: string, ...items: object[]) => ({ revision, data: { items } });
const restart = { serve: false, sessions: ["fixture-session"], complete: false };
const saved = { ...list(b, row("user", false)), restart };
const busy = { code: -32004 };
const stale = { code: -32009, data: { reason: "stale_mcp_revision" } };

function rig() {
  const writes: Array<{ method: string; params: unknown }> = [];
  const reads: string[] = [], events: string[] = [], waits: number[] = [];
  const replies: Array<() => unknown> = [];
  const gates: Array<() => void> = [];
  const jobs: Promise<unknown>[] = [];
  let read = (scope: string) => list(b, row(scope === "effective" ? "project" : scope, false));
  let wait = (_signal: AbortSignal): Promise<void> => Promise.resolve();
  let release = (): Promise<void> => Promise.resolve();
  const request = (method: string, params: { scope: string; signal?: AbortSignal }) => {
    if (method === "mcp_server_list") { reads.push(params.scope); return read(params.scope); }
    writes.push({ method, params });
    return replies.shift()?.() ?? saved;
  };
  const client = { request } as unknown as ZetaClient;
  let live: ZetaClient | null = client;
  let acquire = (): Promise<ZetaClient | null> => Promise.resolve(client);
  const owner = createMcpOwner({ live: () => live, canRead: () => true, supports: () => true,
    acquire: () => { events.push("acquire"); return acquire(); }, release: () => { events.push("release"); return release(); },
    wait: (ms, signal) => { waits.push(ms); return wait(signal); } });
  const forms: string[] = [];
  const open = () => {
    const form = owner.open(); forms.push(form);
    const outcomes: McpOutcome[] = [];
    let detach = owner.attach(form, (value) => outcomes.push(value));
    return { outcomes, close: () => owner.close(form), detach: () => detach(), attach: () => { detach = owner.attach(form, (value) => outcomes.push(value)); },
      execute: (sent: McpAttempt = enabled) => track(owner.execute(form, sent)), check: (sent: McpAttempt = enabled) => track(owner.check(form, sent)) };
  };
  const track = <T,>(promise: Promise<T>) => { jobs.push(promise); return promise; };
  const cancel = () => { forms.forEach(owner.close); gates.forEach((finish) => finish()); };
  async function deadline<T>(operation: string, promise: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => { cancel(); reject(new Error(`${operation} did not finish`)); }, 500);
    })]); } finally { clearTimeout(timer); }
  }
  function gate<T>(value: T) {
    let enter!: () => void, finish!: (result: T) => void;
    const entered = new Promise<void>((resolve) => { enter = resolve; });
    const result = new Promise<T>((resolve) => { finish = resolve; });
    const resume = () => finish(value);
    gates.push(resume);
    return { entered, resume, hold: () => { enter(); return result; } };
  }
  return { owner, open, writes, reads, events, waits, replies, deadline, gate,
    read: (fn: typeof read) => { read = fn; }, acquire: (fn: typeof acquire) => { acquire = fn; },
    release: (fn: typeof release) => { release = fn; }, wait: (fn: typeof wait) => { wait = fn; }, drop: () => { live = null; },
    async cleanup() { cancel(); await deadline("drain owner jobs", Promise.allSettled(jobs)); },
  };
}

type Rig = ReturnType<typeof rig>;
const rowTest = (name: string, check: (r: Rig) => Promise<void>) => test(name, async () => {
  const r = rig();
  try { await check(r); } finally { await r.cleanup(); }
});
const fail = (value: unknown) => () => { throw value; };
const allScopes = ["effective", "user", "project"];

for (const [name, sent, mutation, items] of [
  ["enable or disable", enabled, { name: "fixture", scope: "user", enabled: false }, [row("user", false)]],
  ["trust", trusted, { name: "fixture", trusted: true }, [row("project", true)]],
  ["remove", remove, { name: "fixture", scope: "project" }, []],
] as const) rowTest(`success: ${name} sends only the CAS mutation and returns restart`, async (r) => {
  const form = r.open();
  r.replies.push(() => ({ ...list(b, ...items), restart }));
  await r.deadline("submit mutation and refresh", form.execute(sent));
  expect(r.writes).toEqual([{ method: mcpMethods[sent.action], params: { revision: a, mutation } }]);
  expect(form.outcomes).toEqual([{ status: "committed", restart: { sessions: restart.sessions, complete: false } }]);
  expect(r.reads).toEqual(allScopes);
  expect(r.events).toEqual(["acquire", "release"]);
});

rowTest("identical double submit joins; conflicting project action never reaches the wire", async (r) => {
  const gate = r.gate(saved);
  r.replies.push(gate.hold);
  const first = r.open(), second = r.open();
  const running = first.execute();
  await r.deadline("first write sent", gate.entered);
  expect(first.execute({ ...enabled })).toBe(running);
  await r.deadline("reject different scope while busy", second.execute(trusted));
  expect(second.outcomes).toEqual([{ status: "conflict" }]);
  gate.resume();
  await r.deadline("original write and refresh", running);
  expect(r.writes).toHaveLength(1);
  expect(r.events).toEqual(["acquire", "release"]);
});

for (const retries of [1, 4]) rowTest(`busy ${retries === 1 ? "then success" : "exhaustion"}`, async (r) => {
  r.replies.push(...Array.from({ length: retries }, () => fail(busy)));
  const form = r.open();
  await r.deadline("busy backoff and response", form.execute());
  expect(r.waits).toEqual(retries === 1 ? [500] : [500, 1_000, 2_000]);
  expect(r.writes).toHaveLength(retries === 1 ? 2 : 4);
  expect(r.writes.every((sent) => JSON.stringify(sent) === JSON.stringify(r.writes[0]))).toBe(true);
  expect(form.outcomes[0]?.status).toBe(retries === 1 ? "committed" : "busy");
  expect(r.events).toEqual(["acquire", "release"]);
});

for (const [error, status, refresh] of [[stale, "stale", true], [{ code: -32005 }, "unavailable", true],
  [{ code: -32602 }, "invalid", false], [{ code: -32601 }, "unsupported", false], [{ code: -32008 }, "refused", false]] as const) {
  rowTest(`${status}: release on definite failure and never resend`, async (r) => {
    const form = r.open();
    r.replies.push(fail(error));
    await r.deadline("write failure and release", form.execute());
    expect(form.outcomes).toEqual([{ status }]);
    expect(r.reads).toEqual(refresh ? allScopes : []);
    if (refresh) expect(r.owner.reads.snapshot()?.user).toMatchObject({ revision: b });
    expect(r.writes).toHaveLength(1);
    expect(r.events).toEqual(["acquire", "release"]);
  });
}

rowTest("controller refusal sends nothing and does not release a slot it never took", async (r) => {
  r.acquire(() => Promise.resolve(null));
  const form = r.open();
  await r.deadline("controller refusal", form.execute());
  expect(form.outcomes).toEqual([{ status: "refused" }]);
  expect(r.writes).toEqual([]);
  expect(r.events).toEqual(["acquire"]);
});

for (const [sent, matches] of [[enabled, true], [trusted, true], [remove, true], [enabled, false], [remove, false]] as const) {
  rowTest(`${sent.action}: settle ${matches ? "committed" : "changed"} on a newer concrete read without restart details`, async (r) => {
    r.replies.push(fail(new Error("lost reply")));
    r.read((scope) => scope === sent.scope && matches && sent.action === "remove" ? list(b)
      : list(b, row(scope, scope === sent.scope && matches && sent.action !== "remove" ? sent.value : true)));
    const form = r.open();
    await r.deadline("lost reply and concrete read", form.execute(sent));
    expect(form.outcomes).toEqual([matches ? { status: "committed", restart: null } : { status: "changed" }]);
    expect(r.writes).toHaveLength(1);
    expect(r.events).toEqual(["acquire", "release"]);
  });
}

rowTest("unknown at the base revision: check twice by reading, not sending", async (r) => {
  r.replies.push(fail(new Error("no answer")));
  r.read((scope) => list(a, row(scope, true)));
  const form = r.open();
  await r.deadline("non-definite response at base revision", form.execute());
  await r.deadline("explicit check at base revision", form.check());
  r.read((scope) => list(b, row(scope, false)));
  await r.deadline("explicit check after the intended change appears", form.check());
  expect(form.outcomes).toEqual([{ status: "unknown" }, { status: "unknown" }, { status: "committed", restart: null }]);
  expect(r.writes).toHaveLength(1);
  expect(r.events).toEqual(["acquire", "release"]);
});

for (const phase of ["take control", "send", "busy wait", "release", "read"] as const) for (const cause of ["close", "drop"] as const) {
  rowTest(`${cause} while awaiting ${phase} never authorizes another send`, async (r) => {
    const form = r.open();
    const control = r.gate(null), write = r.gate(saved), pause = r.gate(undefined), read = r.gate(list(b));
    if (phase === "take control") {
      const client = { request: () => saved } as unknown as ZetaClient;
      r.acquire(async () => { await r.deadline("resume pending acquire", control.hold()); return client; });
    } else if (phase === "send") r.replies.push(write.hold);
    else if (phase === "busy wait") { r.replies.push(fail(busy)); r.wait(pause.hold); }
    else if (phase === "release") r.release(pause.hold);
    else { r.replies.push(fail(new Error("dropped"))); r.read(read.hold as unknown as (scope: string) => ReturnType<typeof list>); }
    const waiting = phase === "take control" ? control : phase === "send" ? write : phase === "read" ? read : pause;
    const job = form.execute();
    await r.deadline(`enter ${phase}`, waiting.entered);
    if (cause === "close") form.close(); else r.drop();
    waiting.resume();
    await r.deadline(`drain ${phase}`, job);
    expect(r.writes).toHaveLength(phase === "take control" ? 0 : 1);
    expect(r.events).toEqual(["acquire", "release"]);
    if (cause === "close") expect(form.outcomes).toEqual([]);
  });
}

rowTest("outcome while detached is delivered once when reattached", async (r) => {
  const form = r.open();
  const write = r.gate(saved);
  r.replies.push(write.hold);
  const job = form.execute();
  await r.deadline("mutation in flight", write.entered);
  form.detach();
  write.resume();
  await r.deadline("write settles while detached", job);
  expect(form.outcomes).toEqual([]);
  form.attach(); form.detach(); form.attach();
  expect(form.outcomes.map(({ status }) => status)).toEqual(["committed"]);
  expect(r.writes).toHaveLength(1);
  expect(r.events).toEqual(["acquire", "release"]);
});
