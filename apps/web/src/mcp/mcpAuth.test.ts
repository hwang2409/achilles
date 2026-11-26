import { expect, test } from "bun:test";
import type { ZetaClient } from "@fulcrum/zeta";
import { authMethods as methods, createMcpAuth, type AuthAttempt } from "./mcpAuth";

const target = { name: "fixture", scope: "user" } as const;
const reviewed = { ...target, revision: "a".repeat(64), trusted: true, config: { transport: "streamable-http",
  commandProvided: false, urlProvided: true, args: 0, env: 0, headers: 0, oauth: { secretProvided: false } } } as const;
const start = { ...reviewed, action: "start" } as const;
const launchUrl = "http://127.0.0.1:12345/launch/fixture-canary";
const data = (state: string) => ({ data: { state } });
const pending = { data: { state: "pending", authorization_url: launchUrl } };
const unknown = { status: "unknown" };

async function deadline<T>(label: string, task: Promise<T>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([task, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`timed out: ${label}`)), 10_000); })]);
  } finally { clearTimeout(timer); }
}

function harness({ blocked = false, startReply = () => pending, status = () => data("pending"), cancel = () => data("cancelled"), logout = () => data("unauthorized") }: {
  blocked?: boolean; startReply?: () => unknown; status?: () => unknown; cancel?: () => unknown; logout?: () => unknown;
} = {}) {
  const calls: [string, string, unknown][] = [];
  const order: string[] = [];
  const destinations: string[] = [];
  const popup = { opener: {}, closed: false, location: { replace: (url: string) => {
    expect(popup.opener).toBeNull();
    destinations.push(url);
  } }, close() { this.closed = true; } };
  const client = (role: string) => ({ async request(method: string, params: unknown) {
    calls.push([role, method, params]);
    return { [methods.start]: startReply, [methods.status]: status, [methods.cancel]: cancel, [methods.logout]: logout }[method]!();
  } }) as unknown as ZetaClient;
  const controller = client("controller");
  const observer = client("observer");
  let live: ZetaClient | null = observer;
  const queue = new Map<ReturnType<typeof setTimeout>, { run: () => void; ms: number }>();
  let next = 0;
  const auth = createMcpAuth({
    withControl: async (signal, send) => {
      order.push("take"); live = null;
      try { return signal.aborted ? unknown as { status: "unknown" } : await send(controller); }
      finally { live = observer; order.push("release"); }
    },
    supports: () => true, failure: () => null, live: () => live,
    open: () => { order.push("popup"); return blocked ? null : popup as unknown as Window; },
    timers: { set: (run, ms) => { const id = ++next as unknown as ReturnType<typeof setTimeout>; queue.set(id, { run, ms }); return id; },
      clear: ((id: ReturnType<typeof setTimeout>) => { queue.delete(id); }) as typeof clearTimeout },
  });
  const observe = (shown: boolean, connected = true) => {
    live = connected ? observer : null;
    auth.observe(live, shown, connected);
  };
  observe(true);
  const signal = new AbortController().signal;
  return { auth, calls, order, destinations, observe, popup, run: (attempt: AuthAttempt = start, check = false) => deadline(attempt.action, auth.run(attempt, check, signal)),
    due: () => [...queue.values()].map(({ ms }) => ms),
    tick: () => { const [item] = queue; if (!item) throw new Error("no poll queued"); queue.delete(item[0]); item[1].run(); },
    check: () => deadline("read OAuth status", auth.checkNow()),
  };
}

test("blocked popup never takes control or sends", async () => {
  const h = harness({ blocked: true });
  expect(await h.run()).toEqual({ status: "popup-blocked" });
  expect(h.order).toEqual(["popup"]);
  expect(h.calls).toEqual([]);
});

test("launch opens synchronously, only navigates the detached popup and takes one attempt UI-wide", async () => {
  const h = harness();
  const run = h.run();
  expect(h.order).toEqual(["popup", "take"]);
  expect(await run).toEqual({ status: "auth", state: "pending" });
  expect(h.order).toEqual(["popup", "take", "release"]);
  expect(h.destinations).toEqual([launchUrl]);
  expect(JSON.stringify(h.auth.snapshot())).not.toContain(launchUrl);
  expect(await h.run({ ...start, name: "other" })).toEqual({ status: "busy" });
  await h.run();
  expect(h.calls).toEqual([["controller", methods.start, { name: "fixture", scope: "user" }]]);
});

test.each(["succeeded", "failed", "cancelled"])("observer polls with 0, 1, 2, 5 second cadence and stops at %s", async (terminal) => {
  let state = "pending";
  const h = harness({ status: () => data(state) });
  await h.run();
  for (const time of [0, 1000, 2000, 5000, 5000]) {
    expect(h.due()).toEqual([time]);
    h.tick();
    await h.check();
  }
  state = terminal;
  h.tick();
  await h.check();
  expect(h.auth.snapshot()).toMatchObject({ state: terminal });
  expect(h.calls.slice(1)).toEqual(Array(6).fill(["observer", methods.status, { name: target.name }]));
  expect(h.due()).toEqual([]);
  h.observe(false, false);
  expect(h.auth.snapshot()).toBeNull();
});

test("one status read in flight across hide, disconnect and remount; reconnect or visibility resumes immediately", async () => {
  const deferred = Promise.withResolvers<unknown>();
  const h = harness({ status: () => deferred.promise });
  await h.run();
  h.tick();
  const inFlight = h.check();
  try {
    h.observe(false);
    expect(h.due()).toEqual([]);
    h.observe(false, false);
    h.observe(true);
    expect(h.due()).toEqual([]);
    const concurrent = h.check();
    expect(h.calls.filter(([, method]) => method === methods.status)).toHaveLength(1);
    deferred.resolve(data("pending"));
    await concurrent;
  } finally {
    deferred.resolve(data("pending"));
    await inFlight;
  }
  expect(h.due()).toEqual([0]);
  h.observe(false);
  expect(h.due()).toEqual([]);
  await h.check(); // manual check is allowed when automatic polling is paused
  expect(h.due()).toEqual([]);
  h.observe(true);
  expect(h.due()).toEqual([0]);
});

test("lost start settles through observer status, then restart idle makes no credential claim", async () => {
  let state = "pending";
  const h = harness({ startReply: () => { throw new Error(launchUrl); }, status: () => data(state) });
  expect(await h.run()).toEqual({ status: "auth", state: "pending" });
  expect(h.destinations).toEqual([]);
  expect(h.popup.closed).toBe(true);
  h.observe(true, false);
  state = "idle";
  h.observe(true);
  h.tick();
  await h.check();
  expect(h.auth.snapshot()).toMatchObject({ state: "idle" });
  expect(h.due()).toEqual([]);
});

test("a lost unacknowledged start cannot claim an older terminal attempt", async () => {
  const h = harness({ startReply: () => { throw new Error(launchUrl); }, status: () => data("succeeded") });
  expect(await h.run()).toEqual(unknown);
  expect(h.auth.snapshot()).toMatchObject({ state: "unknown" });
  expect(JSON.stringify(h.auth.snapshot())).not.toContain(launchUrl);
});

test("lost cancel settles through status, preserving a concurrent credential commit", async () => {
  const h = harness({ cancel: () => { throw new Error(launchUrl); }, status: () => data("succeeded") });
  const cancel = { ...target, action: "cancel" } as const;
  await h.run();
  expect(await h.run(cancel)).toEqual({ status: "auth", state: "succeeded" });
  expect(h.calls.slice(1)).toEqual([["controller", methods.cancel, { name: target.name }], ["observer", methods.status, { name: target.name }]]);
  expect(h.due()).toEqual([]);
});

test("a lost logout never uses attempt status as proof and is not resent", async () => {
  const h = harness({ logout: () => { throw new Error(launchUrl); } });
  const logout = { ...reviewed, action: "logout" } as const;
  await h.run();
  expect(await h.run(logout)).toEqual(unknown);
  expect(await h.run(logout, true)).toEqual(unknown);
  expect(await h.run(logout)).toEqual(unknown);
  expect(h.calls.map(([, method]) => method)).toEqual([methods.start, methods.logout]);
  expect(h.due()).toEqual([]);
  expect(h.auth.snapshot()).toMatchObject({ state: "unknown", tracking: false });
});

test("unsafe launch reply is never passed to replace or echoed", async () => {
  const h = harness({ startReply: () => ({ data: { state: "pending", authorization_url: `${launchUrl}?token=fixture` } }) });
  expect(await h.run()).toEqual({ status: "popup-blocked" });
  expect(h.destinations).toEqual([]);
  expect(JSON.stringify(h.auth.snapshot())).not.toContain(launchUrl);
});
