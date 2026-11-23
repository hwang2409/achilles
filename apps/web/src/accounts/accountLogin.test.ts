import { expect, test } from "bun:test";
import { ACCOUNT_LIST_IDLE_FEATURE, type Connection } from "../zeta";
import { createAccountLogin } from "./accountLogin";

const sentinel = "https://signin.invalid/browser-only-fixture";
const pending = { state: "pending", authorization_url: sentinel };
const empty = { revision: "a".repeat(64), data: { accounts: [] } };

function setup(start: unknown, status: unknown = { state: "succeeded" }, cancel: unknown = { state: "cancelled" }, blocked = false) {
  const calls: Array<[string, object]> = [];
  const locations: string[] = [];
  const popup = { opener: {} as unknown, closed: false, close() { popup.closed = true; }, location: { replace: (url: string) => {
    expect(popup.opener).toBeNull();
    locations.push(url);
  } } };
  const listeners = new Set<() => void>();
  let authority: "observer" | "controller" = "observer";
  let connected = true;
  const client = { features: [ACCOUNT_LIST_IDLE_FEATURE], onClose: (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; },
    async request(method: string, params: object) {
      expect(authority).toBe("controller");
      calls.push([method, params]);
      const result = method === "login_start" ? start : method === "login_status" ? status : method === "login_cancel" ? cancel : empty;
      if (result instanceof Error) throw result;
      return result;
    },
  } as unknown as Connection["client"];
  const login = createAccountLogin({
    get client() { return connected ? client : null; },
    get state() { return connected ? { phase: "connected", authority } : { phase: "connecting" }; },
    async takeControl() { calls.push(["take", {}]); authority = "controller"; return null; },
    async releaseControl() { calls.push(["release", {}]); authority = "observer"; },
  }, () => { calls.push(["open", {}]); return blocked ? null : popup; }, 25);
  const drop = () => { connected = false; listeners.forEach(fn => fn()); };
  return { login, calls, locations, popup, drop };
}

type Harness = ReturnType<typeof setup>;
async function deadline<T>(h: Harness, name: string, work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timed out: ${name}`)), 1000);
    })]);
  } catch (error) { h.login.stop(); throw error; }
  finally { clearTimeout(timer); }
}
async function receipt(h: Harness) {
  const { login } = h;
  const initial = login.snapshot();
  if (initial && "at" in initial) return initial;
  let unsubscribe = () => {};
  try {
    return await deadline(h, "login terminal receipt", new Promise<NonNullable<ReturnType<typeof login.snapshot>>>(resolve => {
      unsubscribe = login.subscribe(() => {
        const next = login.snapshot();
        if (next && "at" in next) resolve(next);
      });
    }));
  } finally { unsubscribe(); }
}

const contention = Object.assign(new Error(sentinel), { code: -32005, data: { code: "login_in_progress" } });
test.each([
  ["succeeded immediately", { state: "succeeded" }, undefined, "succeeded", []],
  ["succeeded by polling", pending, undefined, "succeeded", ["login_status"]],
  ["idle by polling", pending, { state: "idle" }, "idle", ["login_status"]],
  ["login-in-progress", contention, undefined, "contention", []],
] as const)("%s rereads the catalog and releases", async (_name, start, status, expected, extra) => {
  const h = setup(start, status);
  try {
    const task = h.login.start({ provider: "claude" });
    expect(h.calls.map(([method]) => method)).toEqual(["open", "take"]);
    await deadline(h, "login_start", task);
    if (extra.length) {
      expect(h.login.snapshot()?.state).toBe("pending");
      expect(h.calls.some(([method]) => method === "release")).toBe(false);
    }
    expect((await receipt(h)).state).toBe(expected);
    expect(h.calls).toEqual([["open", {}], ["take", {}], ["login_start", { provider: "claude" }],
      ...extra.map(method => [method, { provider: "claude" }]), ["account_list", {}], ["release", {}]]);
    expect(h.popup.closed).toBe(!extra.length);
  } finally { h.login.stop(); }
});

test.each(["login_timeout", "login_lock_timeout", "login_save_failed", "login_port_in_use", "login_callback_error", "login_failed", sentinel])("safe failure: %s", async code => {
  const h = setup({ state: "failed", error: { code, message: sentinel } });
  try {
    await deadline(h, "failed login_start", h.login.start({ provider: "codex" }));
    const result = h.login.snapshot();
    expect(result?.state).toBe("failed");
    expect(JSON.stringify(result)).not.toContain(sentinel);
    if (code !== sentinel) expect(result?.state === "failed" && result.detail).toContain(code);
    expect(h.calls.at(-1)?.[0]).toBe("release");
  } finally { h.login.stop(); }
});

test.each(["cancelled", "succeeded"])("cancel before commit or after commit: %s", async state => {
  const h = setup(pending, undefined, { state });
  try {
    await deadline(h, "named login_start", h.login.start({ provider: "codex", account: "codex:sample" }));
    expect(h.calls[2]).toEqual(["login_start", { provider: "codex", account: "codex:sample" }]);
    await deadline(h, "login_cancel", h.login.cancel());
    expect(h.login.snapshot()?.state).toBe(state);
    expect(h.calls.slice(3)).toEqual([["login_cancel", { provider: "codex" }], ["account_list", {}], ["release", {}]]);
  } finally { h.login.stop(); }
});

test("drop after start does not resend; duplicate cannot open or take", async () => {
  const h = setup(pending);
  try {
    const task = h.login.start({ provider: "claude" });
    await deadline(h, "duplicate start refusal", h.login.start({ provider: "codex" }));
    await deadline(h, "original login_start", task);
    h.drop();
    expect((await receipt(h)).state).toBe("unknown");
    expect(h.locations).toEqual([sentinel]);
    expect(h.calls.map(([method]) => method)).toEqual(["open", "take", "login_start", "release"]);
  } finally { h.login.stop(); }
});

test.each(["javascript:alert(1)", "http://signin.invalid/", "https://fixture@signin.invalid/"])("unsafe popup URL is not used: %s", async authorization_url => {
  const h = setup({ ...pending, authorization_url });
  try {
    await deadline(h, "cancel after rejecting URL", h.login.start({ provider: "claude" }));
    expect(h.login.snapshot()?.state).toBe("blocked");
    expect(h.locations).toEqual([]);
    expect(h.calls.map(([method]) => method)).toEqual(["open", "take", "login_start", "login_cancel", "account_list", "release"]);
  } finally { h.login.stop(); }
});

test("popup blocked before taking control sends nothing", async () => {
  const h = setup(pending, undefined, undefined, true);
  try {
    await deadline(h, "blocked popup", h.login.start({ provider: "claude" }));
    expect(h.login.snapshot()?.state).toBe("blocked");
    expect(h.calls).toEqual([["open", {}]]);
  } finally { h.login.stop(); }
});
