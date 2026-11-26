import { expect, test } from "bun:test";
import { createClient } from "@fulcrum/zeta";
import { ACCOUNT_LIST_IDLE_FEATURE, readAccounts } from "./accounts";

const revision = "a".repeat(64);
const reset = "2026-11-12T16:00:00Z";
const canary = ["sk", "synthetic", "fixture"].join("-");
const window = { kind: "five_hour", used_percent: 62, window_minutes: 300, resets_at: reset };
const snapshot = { version: 1, captured_at: "2026-11-12T13:00:00Z", source: "usage_endpoint", windows: [window] };
const usage = { freshness: "now", snapshot, error: null };
const row = { account: "anthropic:fixture", label: "fixture", detail: null, available: true, current: false, default: true, usage };
const catalog = (accounts: unknown[]) => ({ revision, data: { accounts } });

function fixture(reply: { result: unknown } | { error: object }, idle = true, authority: "observer" | "controller" = "controller") {
  const requests: { id: number; method: string; params: object }[] = [];
  let receive: (text: string) => void;
  let closed = false;
  const client = Object.assign(createClient({
    onMessage(callback) { receive = callback; },
    send(text) {
      const call = JSON.parse(text);
      const response = call.method === "hello"
        ? { result: { protocol_version: "1.2", capabilities: { features: idle ? [ACCOUNT_LIST_IDLE_FEATURE] : [] } } }
        : reply;
      if (call.method !== "hello") requests.push(call);
      queueMicrotask(() => { if (!closed) receive(JSON.stringify({ id: call.id, ...response })); });
    },
    close() { closed = true; },
  }), { authority });
  const deadline = async <T>(work: Promise<T>, method: string) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        work,
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${method} fixture did not settle`)), 500); }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  const read = async (sessionId?: string) => {
    try {
      await deadline(client.hello([ACCOUNT_LIST_IDLE_FEATURE]), "hello");
      return await deadline(readAccounts(client, sessionId), "account_list");
    } finally {
      client.close();
    }
  };
  return { requests, read };
}

test("negotiated empty read sends no session_id, even when chat supplies one", async () => {
  const { requests, read } = fixture({ result: catalog([]) });
  expect(await read("fixture-session")).toEqual({ revision, accounts: [] });
  expect(requests).toEqual([expect.objectContaining({ method: "account_list", params: {} })]);
});

test("legacy session read accepts flat results without retaining credential detail", async () => {
  const { requests, read } = fixture({ result: { accounts: [{ ...row, current: true, detail: canary, usage: undefined }] } }, false);
  expect(await read("fixture-session")).toEqual({ revision: null, accounts: [{ ...row, current: true, usage: null }] });
  expect(requests).toEqual([expect.objectContaining({ method: "account_list", params: { session_id: "fixture-session" } })]);
});

test("observer refusal and absent legacy session send no account_list", async () => {
  const observer = fixture({ result: catalog([]) }, true, "observer");
  await expect(observer.read()).rejects.toThrow("too many tabs control zeta");
  expect(observer.requests).toEqual([]);
  const legacy = fixture({ result: { accounts: [] } }, false);
  await expect(legacy.read()).rejects.toThrow("start a chat");
  expect(legacy.requests).toEqual([]);
});

test.each([
  ["observer", -32008, "this tab is read-only: too many tabs control zeta"],
  ["invalid params", -32602, "zeta did not accept the account request"],
  ["store unavailable", -32005, "zeta's account store is unavailable"],
  ["unexpected", -32000, "could not read accounts from zeta"],
] as const)("%s RPC failure uses fixed copy", async (_label, code, message) => {
  const { read } = fixture({ error: { code, message: canary } });
  await expect(read()).rejects.toThrow(new RegExp(`^${message}\\.`));
});

test.each([
  ["revision", { ...catalog([]), revision: "A".repeat(64) }],
  ["row flags", catalog([{ ...row, available: 1 }])],
  ["non-null detail", catalog([{ ...row, detail: canary }])],
  ["token-shaped label", catalog([{ ...row, label: canary }])],
  ["token-shaped id", catalog([{ ...row, account: `codex:${canary}` }])],
  ["usage error", catalog([{ ...row, usage: { ...usage, error: canary } }])],
  ["usage percent", catalog([{ ...row, usage: { ...usage, snapshot: { ...snapshot, windows: [{ ...window, used_percent: 101 }] } } }])],
  ["usage reset", catalog([{ ...row, usage: { ...usage, snapshot: { ...snapshot, windows: [{ ...window, resets_at: canary }] } } }])],
] as const)("rejects malformed %s without echoing the response", async (_label, result) => {
  const { read } = fixture({ result });
  await expect(read()).rejects.toThrow(/^zeta returned an unreadable account catalog\.$/);
});

test("projects every usage window and drops unknown secret-shaped fields at every level", async () => {
  const secret = { access_token: canary };
  const wire = {
    revision, ...secret, data: { ...secret, accounts: [{ ...row, ...secret, usage: {
      ...usage, ...secret, error: "rate limited; retry later", snapshot: { ...snapshot, ...secret, windows: [
        { ...window, ...secret }, { ...window, kind: "seven_day", used_percent: 8, window_minutes: 10080 },
      ] },
    } }] },
  };
  const { read } = fixture({ result: wire });
  expect(await read()).toEqual({ revision, accounts: [{ ...row, usage: {
    freshness: "now", refreshFailed: true, windows: [
      { kind: "five_hour", usedPercent: 62, minutes: 300, resetsAt: Date.parse(reset) },
      { kind: "seven_day", usedPercent: 8, minutes: 10080, resetsAt: Date.parse(reset) },
    ],
  } }] });
});
