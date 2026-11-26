import "./test-dom";
import { expect, spyOn, test } from "bun:test";
import { act, createElement } from "react";
import type { RenderResult } from "@testing-library/react";

import { isMac } from "./keyboard";
import { draftStore } from "./draftStore";
import { getSettings, SETTINGS_KEY, updateSettings } from "./settings";
import { WRITE_SURFACES, type WriteSurfaceId } from "./writeSurfaces";

const { fireEvent, render } = await import("@testing-library/react");

const chat = { session_id: "session", page_id: "page", page_route: "/", title: "Fixture chat", message_sent: true, titled_by_user: true, last_state: "idle", updated_at: "2026-01-01" };
const page = { id: "page", route: "/", title: "Fixture page", zeta_session_id: null, workspace: "/fixture", create_mode: false, layout: { blocks: [] } };
const reads = new Set(["hello", "status", "session_settings", "session_history_and_subscribe", "session_history", "unsubscribe", "delivery_status", "account_list", "login_status", "skill_catalog", "skill_read", "home_settings_get", "state_settings", "mcp_server_list", "mcp_auth_status", "agent_run_catalog", "list_sessions", "state_sessions", "state_session"]);
const pendingRecord = JSON.stringify([{ sessionId: "session", pageId: "page", mode: "allow", stage: "created" }]);
type Authority = "observer" | "controller";
// `path`: the route to open (default the chats route).
// `slot`: like zeta, one controller at a time across every socket (a second controller hello gets -32001); `roles`
// records each hello role.
type Options = { path?: string; sockets?: EventTarget[]; slot?: boolean; roles?: string[]; browserPreference?: keyof ReturnType<typeof getSettings>; unsent?: boolean; pending?: boolean; attached?: boolean; extraChat?: typeof chat; page?: Record<string, unknown>; tool?: object; chat?: object; joined?: object; rpc?: Record<string, (params: Record<string, unknown>, requests: readonly string[]) => object | Promise<object>>; http?: (path: string, method: string) => Response | undefined };

async function withApp(authority: Authority, options: Options, check: (app: RenderResult, writes: string[], requests: string[], emit: (event: object) => void) => Promise<void>) {
  options.roles?.splice(0);
  const writes: string[] = [];
  const requests: string[] = [];
  // Happy DOM has no layout; give the real virtual timeline a viewport.
  const height = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientHeight");
  Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get() { return this.matches('[data-part="timeline-scroll"]') ? 600 : height?.get?.call(this) ?? 0; } });
  const originalFetch = globalThis.fetch;
  const OriginalSocket = globalThis.WebSocket;
  const oldSettings = getSettings();
  const keys = [SETTINGS_KEY, pendingKey, "achilles-pending-create-modes", "achilles:unsent:session", "achilles:unsent:new:page"];
  const oldStorage = keys.map((key) => localStorage.getItem(key));
  keys.forEach((key) => localStorage.removeItem(key));
  if (options.pending) localStorage.setItem(pendingKey, pendingRecord);
  if (options.unsent) localStorage.setItem("achilles:unsent:session", JSON.stringify({ rows: [{ text: "please retry", failed: "not sent" }] }));
  for (const id of ["session", "new:page"]) draftStore.set(id, "");
  const url = location.href;
  const status = { session: { session_id: "session" }, state: "idle" };
  const chats = options.chat ? [options.chat] : options.attached ? [chat] : [];
  if (options.extraChat) chats.push(options.extraChat);
  let app: RenderResult | undefined;
  let socket: Socket;
  const reply = (target: EventTarget, event: object) => target.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(event) }));
  const emit = (event: object) => reply(socket, event);
  const controllers = new Set<Socket>();
  class Socket extends EventTarget {
    role?: string;
    constructor() { super(); socket = this; options.sockets?.push(this); queueMicrotask(() => this.dispatchEvent(new Event("open"))); }
    close() { controllers.delete(this); this.dispatchEvent(new Event("close")); }
    send(raw: string) {
      const { id, method, params } = JSON.parse(raw);
      requests.push(method);
      if (!reads.has(method)) writes.push(method);
      if (method === "hello") { this.role = params.role; options.roles?.push(params.role); }
      if (method === "child_run_spawn" || method === "child_run_cancel") expect(this.role).toBe("controller");
      const taken = options.slot && method === "hello" && params.role === "controller" && [...controllers].some((other) => other !== this);
      if (options.slot && method === "hello" && params.role === "controller" && !taken) controllers.add(this);
      const custom = taken ? { error: { code: -32001, message: "controller occupied" } } : options.rpc?.[method]?.(params, requests);
      const response = method === "hello" && authority === "observer" && params.role === "controller"
        ? { error: { code: -32001, message: "controller occupied" } }
        : custom ?? { result: ({
          hello: { protocol_version: "1.2", capabilities: { features: params.features } },
          new_session: { session: { session_id: "session" } },
          resume: { session: { session_id: "session" } },
          session_settings: { approval_mode: "allow" }, status,
          send: { accepted: true }, steer: { accepted: true }, delivery_status: { status: "delivered" },
          session_history_and_subscribe: { messages: [], next_before: null, status, ...options.joined },
        } as Record<string, unknown>)[method] ?? {} };
      void Promise.resolve(response).then((result) => reply(this, { jsonrpc: "2.0", id, ...result }));
    }
  }
  try {
    globalThis.WebSocket = Socket as unknown as typeof WebSocket;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      const method = init?.method ?? "GET";
      requests.push(`${method} ${path}`);
      if (method !== "GET") writes.push(`${method} ${path}${init?.body ? ` ${String(init.body)}` : ""}`);
      return options.http?.(path, method) ?? Response.json(path === "/api/zeta/discovery"
        ? { url: "ws://fixture.invalid", controller_token: "fixture-c", observer_token: "fixture-o", origins: [location.origin] }
        : path.startsWith("/api/chats?") ? { chats, next: null, approval_count: options.chat ? 1 : 0 }
        : path.startsWith("/api/pages?") ? { pages: [], next: null }
        : path.endsWith("/credential") ? { credential: "fixture" }
        : path.endsWith("/tools") ? { tools: options.tool ? [options.tool] : [] }
        : path.includes("/records/") ? [] : { ...page, ...options.page });
    }) as typeof fetch;
    (window as unknown as { happyDOM: { setURL(url: string): void } }).happyDOM.setURL(`http://fixture.invalid${options.path ?? "/"}${options.attached ? "?chat=session" : ""}`);
    updateSettings({ vim: false, size: 14 });
    const { SurfaceRouter } = await import("./surface/SurfaceRouter");
    app = render(createElement(SurfaceRouter));
    await act(async () => {});
    // an observer connects after a refused controller hello: give that fallback a few turns to land
    for (let turn = 0; turn < 20 && authority === "observer" && !app.container.querySelector(".observer-banner"); turn++) await act(async () => {});
    const banner = app.container.querySelector(".observer-banner");
    if (authority === "observer") {
      expect(banner?.textContent).toContain("this tab is read-only and shows updates: too many tabs control zeta, or another app does. close another zeta tab, then take control.");
      expect(banner?.getAttribute("hidden")).toBeNull();
    } else {
      expect(banner === null, "a controller tab showed the observer banner").toBe(true);
      expect(requests).toContain("hello");
    }
    await check(app, writes, requests, emit);
    if (authority === "observer") {
      expect(writes).toEqual([]);
      const expected = { ...oldSettings, vim: false, size: 14 };
      if (options.browserPreference) Object.assign(expected, { [options.browserPreference]: getSettings()[options.browserPreference] });
      expect(JSON.parse(localStorage.getItem(SETTINGS_KEY)!)).toEqual(expected);
    }
  } finally {
    app?.unmount();
    if (height) Object.defineProperty(HTMLElement.prototype, "clientHeight", height);
    else Reflect.deleteProperty(HTMLElement.prototype, "clientHeight");
    globalThis.fetch = originalFetch;
    globalThis.WebSocket = OriginalSocket;
    updateSettings(oldSettings);
    keys.forEach((key, index) => {
      const value = oldStorage[index];
      if (value === null) localStorage.removeItem(key);
      else localStorage.setItem(key, value);
    });
    (window as unknown as { happyDOM: { setURL(url: string): void } }).happyDOM.setURL(url);
  }
}

const click = (element: Element) => act(async () => { fireEvent.click(element); });
const select = (app: RenderResult, selector: string) => {
  const element = app.container.querySelector<HTMLElement>(selector);
  expect(element, selector).not.toBeNull();
  return element!;
};

const sessionDetail = (metadata: object = {}): Options => ({
  path: "/sessions/session",
  rpc: { status: () => ({ result: { session: null, state: "idle" } }), list_sessions: () => ({ result: { sessions: [{ session_id: "session", name: "Fixture session", project_id: "other-project", parent_session_id: null, in_use: false, ...metadata }], next_offset: null } }) },
});

type Row = { kind: "visible" | "command" | "passive" | "local-only"; absent?: true; options?: Options; check: (app: RenderResult, authority: Authority, writes: string[], requests: string[]) => Promise<void> };
const tag = (id: WriteSurfaceId) => `[data-write-surface="${id}"]`;
const disabled = (element: HTMLElement) => element.matches(":disabled") || element.getAttribute("aria-disabled") === "true";
const didWrite = (writes: string[], prefix: string) => expect(writes.some((write) => write.startsWith(prefix)), `${prefix}; got ${JSON.stringify(writes)}`).toBe(true);
const button = (selector: string, write: string, options?: Options): Row => ({ kind: "visible", options, check: async (app, authority, writes) => {
  const control = select(app, selector);
  expect(disabled(control)).toBe(authority === "observer");
  await click(control);
  if (authority === "controller") didWrite(writes, write);
} });
const setting = (id: WriteSurfaceId, key: keyof ReturnType<typeof getSettings>, child = "", locksApprovalDefault = false): Row => ({ kind: "visible", options: { browserPreference: locksApprovalDefault ? undefined : key }, check: async (app, authority, writes) => {
  await keydown(window, ",", { ctrlKey: !isMac, metaKey: isMac });
  const control = select(app, tag(id) + child);
  const before = getSettings()[key];
  const storageBefore = localStorage.getItem(SETTINGS_KEY);
  const locked = locksApprovalDefault && authority === "observer";
  expect(WRITE_SURFACES.find((row) => row.id === id)?.observer).toBe(locksApprovalDefault ? undefined : "browser-only");
  expect(WRITE_SURFACES.find((row) => row.id === id)?.channel).toBe(locksApprovalDefault ? "storage-and-shared-default" : "storage");
  expect(disabled(control)).toBe(locked);
  await click(control);
  if (locked) {
    expect(getSettings()[key]).toBe(before);
    expect(localStorage.getItem(SETTINGS_KEY)).toBe(storageBefore);
    expect(app.getByText("only a tab that controls zeta can change auto-approve or reset.")).toBeTruthy();
  } else {
    expect(getSettings()[key]).not.toBe(before);
    expect(JSON.parse(localStorage.getItem(SETTINGS_KEY)!)[key]).toBe(getSettings()[key]);
  }
  expect(writes).toEqual([]);
} });
const change = (element: HTMLElement, value: string) => act(async () => {
  fireEvent.change(element, { target: { value } });
  fireEvent.input(element, { target: { value } });
});
const keydown = (element: Element | Window, key: string, modifiers = {}) => act(async () => { fireEvent.keyDown(element, { key, ...modifiers }); });
const composer = (action: "send" | "steer" | "abort", options: Options = { attached: true }): Row => ({ kind: "visible", absent: true, options, check: async (app, authority, writes) => {
  const field = app.container.querySelector<HTMLElement>('[data-part="composer-field"] textarea');
  if (authority === "controller" && action !== "abort") await change(field!, "fixture prompt");
  const control = app.container.querySelector<HTMLElement>(`button${tag(`composer.${action}`)}`);
  if (authority === "observer") {
    expect(Boolean(control)).toBe(false);
    expect(select(app, '[data-part="composer"] textarea').getAttribute("placeholder")).toBe("read-only");
    await keydown(field ?? select(app, '[data-part="composer"]'), "Enter");
  } else {
    expect(Boolean(control) && !disabled(control!), `${action}: ${field?.outerHTML}; ${control?.outerHTML}`).toBe(true);
    if (action === "abort") await click(control!);
    else await act(async () => { fireEvent.submit(control!.closest("form")!); });
    didWrite(writes, action);
  }
} });
const running = { attached: true, joined: { status: { state: "running", session: { session_id: "session" } } } };
const insert = { description: "Add a book", name: "add_book", operation: "insert", collection: "books", input_schema: { type: "object", properties: { title: { type: "string" } }, required: ["title"] } };
const records = { tool: insert, page: { layout: { blocks: [{ type: "form", title: "add book", tool: insert.name }, { type: "list", title: "books", collection: "books" }] } } };
const docked: Options = { ...records, attached: true };
const dockedWrite = (id: WriteSurfaceId, write: string, options = docked): Row => ({ kind: "visible", options, check: async (app, authority, writes) => {
  const control = select(app, tag(id));
  expect(disabled(control)).toBe(authority === "observer");
  if (authority === "observer") {
    const description = select(app, `#${CSS.escape(control.getAttribute("aria-describedby")!)}`);
    expect(description.textContent).toContain("read-only");
  }
  await click(control);
  if (authority === "controller") {
    didWrite(writes, write);
  }
} });
const userMessage = { id: "message", role: "user", content: [{ type: "text", text: "Fixture history title" }] };

test("replay stream end is not a chat transcript row", async () => {
  const reply = { id: "reply", role: "assistant", content: [{ type: "text", text: "Fixture final reply" }] };
  await withApp("controller", { attached: true, joined: { messages: [userMessage, reply] } }, async (app, _writes, _requests, emit) => {
    await app.findByText("Fixture final reply", {}, { timeout: 10_000 });
    const event = (name: string, fields = {}) => emit({ jsonrpc: "2.0", method: "event", params: { event: name, session_id: "session", ...fields } });
    await act(async () => {
      event("replay_stream_ended", { stream_id: "fixture-stream", reason: "rejoined" });
      event("fixture_future_event");
    });
    const nextRow = await app.findByText("fixture_future_event", {}, { timeout: 10_000 });
    const transcript = nextRow.closest(".transcript");
    expect(transcript).not.toBeNull();
    expect(transcript?.textContent).not.toContain("replay_stream_ended");
  });
}, 25_000);
const pendingKey = "achilles-pending-chats";
const sha256 = async (text: string) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
// The skills route with library_read_v1, and library_write_v1 + skill_write when `writes` (each part can be withheld).
// Like zeta, hello lists a controller-write method only to a controller.
const library = (writes: boolean, feature = writes, method = writes): Options => ({ path: "/skills", rpc: {
  hello: (params) => ({ result: { protocol_version: "1.2", capabilities: {
    features: (params.features as string[]).filter((name) => name !== "library_write_v1" || feature),
    requests: ["skill_catalog", "skill_read", ...(method && params.role === "controller" ? ["skill_write"] : [])],
  } } }),
  skill_catalog: () => ({ result: { revision: "r", data: { items: [] } } }),
  skill_write: async (params) => ({ result: { revision: await sha256((params.mutation as { document: string }).document), data: { name: params.name, scope: params.scope, redacted: false } } }),
} });
const fixtureFile = "---\nname: fixture-skill\ndescription: synthetic skill\n---\nbody\n";
const libraryFile: Options = { ...library(true), rpc: { ...library(true).rpc,
  skill_catalog: () => ({ result: { revision: "r", data: { items: [{ name: "fixture-skill", description: "synthetic skill", keywords: [], source: "home", scope: "home", editable: true, diagnostics: [] }] } } }),
  skill_read: async () => ({ result: { revision: await sha256(fixtureFile), data: { name: "fixture-skill", frontmatter: {}, body: "body\n", source: "home", editable: true, redacted: false, document: fixtureFile } } }),
} };
const homeSettings: Options = { path: "/settings", rpc: {
  hello: (params) => ({ result: { protocol_version: "1.2", capabilities: { features: params.features, requests: params.role === "controller" ? ["home_settings_get", "home_settings_update"] : ["home_settings_get"] } } }),
  // a read after the update sees it: the borrow reconnects, and each new socket reads again
  home_settings_get: (_params, requests) => ({ result: { revision: `sha256:${(requests.includes("home_settings_update") ? "b" : "a").repeat(64)}`, settings: { telemetry: requests.includes("home_settings_update") ? { enabled: true, source: "builtin", editable: true } : { enabled: false, source: "off", editable: true } }, settings_malformed: false } }),
  home_settings_update: () => ({ result: { revision: `sha256:${"b".repeat(64)}`, settings: { telemetry: { enabled: true, source: "builtin", editable: true } }, restart: { serve: true, sessions: [], complete: true } } }),
} };
const blockedCreation = (path: string, method: string) => path === "/api/pages/page/chats" && method === "POST" ? new Response(null, { status: 503 }) : undefined;
const creationAction = (action: "retry" | "discard"): Row => ({ kind: action === "retry" ? "visible" : "local-only", absent: true, options: { pending: true, http: blockedCreation }, check: async (app, authority, writes, requests) => {
  const id = `create.${action}` as const;
  const control = app.container.querySelector<HTMLElement>(tag(id));
  if (authority === "observer") {
    expect(writes).toEqual([]);
    expect(Boolean(control)).toBe(false);
    expect(localStorage.getItem(pendingKey)).toBe(pendingRecord);
    await keydown(select(app, '[data-part="composer"]'), "Enter");
  } else {
    expect(Boolean(control) && !disabled(control!)).toBe(true);
    const postCount = writes.length;
    const attachmentCount = requests.filter((request) => request === "GET /api/pages/home").length;
    await click(control!);
    if (action === "retry") {
      expect(postCount).toBe(1);
      didWrite(writes.slice(postCount), "POST /api/pages/page/chats");
    } else {
      expect(writes).toHaveLength(postCount);
      expect(requests.filter((request) => request === "GET /api/pages/home")).toHaveLength(attachmentCount + 1);
      expect(localStorage.getItem(pendingKey)).toBeNull();
    }
  }
} });
const approval = (action: "approve" | "deny"): Row => button(`[data-part="approval"] button[data-action="${action}"]`, action, { attached: true, joined: { status: { state: "tool", session: { session_id: "session" }, pending_approvals: [{ request_id: "waiting", delegated: false, tool_call: { id: "tool", name: "fixture", arguments: {} } }] } } });
const modify = { ...insert, name: "edit_book", operation: "update" };
const existingBook = { record_id: "book-id", revision: 1, title: "Old book" };

const fromAccount = "anthropic:fixture-expired";
const toAccount = "anthropic:fixture-ready";
const accountFixture = (requests: { method: string; params: Record<string, unknown> }[], state: { account: string } = { account: fromAccount }): Options => ({
  attached: true,
  joined: { messages: [{ id: "prompt", role: "user", content: [{ type: "text", text: "fixture prompt" }], failed_turn: { code: "auth_error", message: "fixture login failed" } }] },
  rpc: {
    hello: (params) => ({ result: { protocol_version: "1.2", capabilities: { features: params.features,
      requests: params.role === "observer" ? ["status"] : ["account_list", "account_switch", "login_start", "login_status"] } } }),
    status: () => ({ result: { session: { session_id: "session", name: "Fixture chat" }, state: "idle" } }),
    account_list: () => ({ result: { revision: "a".repeat(64), data: { accounts: [fromAccount, toAccount].map(account => ({
      account, label: account.slice(10), current: state.account === account, available: account === toAccount, default: false, detail: null,
      usage: { freshness: "usage unknown", error: null, snapshot: null },
    })) } } }),
    login_start: params => { requests.push({ method: "login_start", params }); return { result: { state: "succeeded" } }; },
    account_switch: params => { requests.push({ method: "account_switch", params }); state.account = String(params.account); return { result: { account: state.account, replay: false } }; },
  },
});

async function proveSwitch(app: RenderResult, writes: string[]) {
  const dialog = app.getByRole("dialog", { name: "review chat account switch" });
  const submit = dialog.querySelector<HTMLButtonElement>('button[type="submit"]')!;
  expect(dialog.textContent).toContain("Fixture chat");
  expect(dialog.textContent).toContain(fromAccount);
  expect(dialog.textContent).toContain("the failed request is not retried");
  expect(writes).not.toContain("account_switch");
  expect(disabled(submit)).toBe(true);
  await change(dialog.querySelector("input")!, toAccount);
  expect(disabled(submit)).toBe(false);
  return submit;
}

const recoveryWrite = (id: WriteSurfaceId, request: string): Row => {
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  return { kind: "visible", options: accountFixture(calls), check: async (app, authority, writes, requests) => {
    const card = select(app, ".transcript .chat-auth-error");
    expect(card.querySelector('a[href="/accounts"]')).not.toBeNull();
    const control = select(app, tag(id));
    expect(disabled(control)).toBe(authority === "observer");
    if (authority === "observer") {
      await click(control);
      expect(card.textContent).toContain("this chat is pinned to its account, which failed to sign in.");
      if (id !== "auth.new-chat") expect(requests).not.toContain("account_list");
      return;
    }
    if (id === "auth.login") {
      const originalOpen = window.open;
      window.open = (() => ({ opener: window, closed: false, close() {} })) as typeof window.open;
      try {
        await click(control);
        const dialog = app.getByRole("dialog", { name: "review browser sign-in" });
        await click(dialog.querySelector("input")!);
        await click(dialog.querySelector('button[type="submit"]')!);
        expect(calls).toContainEqual({ method: "login_start", params: { provider: "claude", account: fromAccount } });
        expect(card.textContent).toContain("send your message again to retry.");
      } finally { window.open = originalOpen; }
    } else if (id === "auth.switch") {
      await click(control);
      await click(await proveSwitch(app, writes));
      expect(app.getByText(/Fixture chat: switched to/)).toBeTruthy();
      expect(calls).toEqual([{ method: "account_switch", params: { session_id: "session", account: toAccount } }]);
    } else await click(control);
    didWrite(writes, request);
  } };
};

test("chat account switch busy refusal permits one retry; a dropped reply is settled only by reading", async () => {
  const sockets: EventTarget[] = [];
  const state = { account: fromAccount };
  const options = accountFixture([], state);
  let attempts = 0;
  let readsAfterDrop = 0;
  const read = options.rpc!.account_list!;
  await withApp("controller", { ...options, sockets, rpc: { ...options.rpc,
    account_list: (params, requests) => {
      if (attempts >= 2) readsAfterDrop++;
      return read(params, requests);
    },
    account_switch: params => {
      if (++attempts === 1) return { error: { code: -32004, message: "fixture busy" } };
      if (attempts === 2) {
        state.account = String(params.account);
        (sockets.at(-1)! as EventTarget & { close(): void }).close();
      }
      return {};
    },
  } }, async (app, writes) => {
    await click(select(app, tag("auth.switch")));
    const submit = await proveSwitch(app, writes);
    await click(submit);
    expect(app.getByText(/not changed. zeta is busy/)).toBeTruthy();
    expect(attempts).toBe(1);
    await click(submit);
    expect(await app.findByText(/current account confirmed as anthropic:fixture-ready/, {}, { timeout: 3_000 })).toBeTruthy();
    expect(readsAfterDrop).toBeGreaterThan(0);
    expect(attempts).toBe(2);
    expect(writes).not.toContain("send");
  });
});

const browserLogin = (cancel: boolean): Row => {
  const sentinel = "https://signin.invalid/browser-only-fixture";
  return { kind: "visible", options: { path: "/accounts", rpc: {
    account_list: () => ({ result: { revision: "a".repeat(64), data: { accounts: [] } } }),
    login_start: () => ({ result: { state: "pending", authorization_url: sentinel } }),
    login_status: () => ({ result: { state: "pending" } }),
    login_cancel: () => ({ result: { state: "succeeded" } }),
  } }, check: async (app, authority, writes, requests) => {
    if (authority === "observer") {
      expect(await app.findByText(/^zeta is still full at .+\. close another zeta tab, then try again\.$/)).toBeTruthy();
      expect(requests).not.toContain("account_list");
      expect(app.container.querySelector(tag("accounts.login"))).toBeNull();
      expect(app.container.querySelector(tag("accounts.login-cancel"))).toBeNull();
      return;
    }
    const originalOpen = window.open;
    const consoleCalls = ["log", "warn", "error", "debug", "info"].map(method => spyOn(console, method as "log"));
    const locations: string[] = [];
    window.open = (() => ({ opener: window, closed: false, close() {}, location: { replace: (url: string) => locations.push(url) } })) as typeof window.open;
    try {
      await click(await app.findByRole("button", { name: "sign in to claude" }));
      const dialog = app.getByRole("dialog", { name: "review browser sign-in" });
      expect(writes).toEqual([]);
      expect(disabled(dialog.querySelector('button[type="submit"]')!)).toBe(true);
      await click(dialog.querySelector('input[type="checkbox"]')!);
      await click(dialog.querySelector('button[type="submit"]')!);
      didWrite(writes, "login_start");
      expect(app.getByText("waiting for your browser")).toBeTruthy();
      expect(locations).toEqual([sentinel]);
      if (cancel) {
        await click(select(app, tag("accounts.login-cancel")));
        expect(writes).toEqual(["login_start"]);
        await click(app.getByRole("group").querySelector(".confirmation-primary")!);
        expect(writes).toEqual(["login_start", "login_cancel"]);
        expect(app.getByText(/^signed in at/)).toBeTruthy();
        expect(requests.filter(method => method === "account_list")).toHaveLength(2);
        expect(requests.filter(method => method !== "status" && !method.includes(" ")).at(-1)).toBe("account_list");
      }
      const contents = [document.documentElement.outerHTML, location.href, history.state,
        ...[localStorage, sessionStorage].map(store => Array.from({ length: store.length }, (_, i) => [store.key(i), store.getItem(store.key(i)!)])),
        ...consoleCalls.flatMap(spy => spy.mock.calls)];
      expect(JSON.stringify(contents)).not.toContain(sentinel);
    } finally { window.open = originalOpen; consoleCalls.forEach(spy => spy.mockRestore()); }
  } };
};

const mcpAddCanary = "fixture-private-command";
function mcpAdd(): Row {
  const method = "mcp_server_add";
  const roles: string[] = [];
  const before = { revision: "a".repeat(64), data: { items: [] } };
  const after = { revision: "b".repeat(64), data: { items: [{ name: "fixture-user", scope: "user", enabled: true,
    trusted: true, status: "configured", auth: "none", tool_count: 0, config: { transport: "stdio", command: "<redacted>" } }] } };
  let applied = false;
  return { kind: "visible", options: { path: "/connections", roles, rpc: {
    hello: (params) => ({ result: { protocol_version: "1.2", capabilities: { features: params.features,
      requests: ["mcp_server_list", ...(params.role === "controller" ? [method] : [])] } } }),
    mcp_server_list: ({ scope }) => ({ result: applied && scope !== "project" ? after : before }),
    [method]: (params) => {
      expect(params.mutation).toMatchObject({ name: "fixture-user", scope: "user", command: mcpAddCanary });
      expect(document.querySelector<HTMLInputElement>('input[name="command"]')?.value).toBe("");
      applied = true;
      return { result: { ...after, restart: { serve: false, sessions: [], complete: true } } };
    },
  } }, check: async (app, authority, writes) => {
    const start = roles.length;
    const url = location.href;
    await click(select(app, tag("mcp.add")));
    await change(app.getByRole("textbox", { name: "connection name" }), "fixture-user");
    const command = app.getByLabelText("local command") as HTMLInputElement;
    await change(command, mcpAddCanary);
    await act(async () => { fireEvent.submit(command.form!); });
    expect(document.body.innerHTML).not.toContain(mcpAddCanary);
    expect(roles).toHaveLength(start);
    expect(writes).toEqual([]);
    const confirm = document.querySelector<HTMLButtonElement>(".confirmation-primary")!;
    expect(confirm.disabled).toBe(true);
    await click(app.getByRole("checkbox", { name: "i reviewed the scope for this connection" }));
    expect(confirm.disabled).toBe(false);
    await act(async () => { fireEvent.submit(confirm.form!); });
    expect(command.value).toBe("");
    expect(location.href).toBe(url);
    expect(JSON.stringify([localStorage, sessionStorage])).not.toContain(mcpAddCanary);
    if (authority === "observer") {
      expect(app.getByRole("alert").textContent).toContain("too many tabs control zeta");
      expect(roles.slice(start)).toEqual(["controller"]);
      expect(writes).toEqual([]);
    } else {
      expect(app.getByText(/new sessions use this configuration/)).toBeTruthy();
      expect(roles.slice(start)).toEqual([]);
      expect(writes).toEqual([method]);
    }
  } };
}


function mcpWrite(id: "mcp.enabled" | "mcp.trusted" | "mcp.remove" | "mcp.test", method: string): Row {
  const fixture = { name: "fixture-project", scope: "project", enabled: true, trusted: id === "mcp.test", status: id === "mcp.test" ? "configured" : "pending trust",
    auth: "none", tool_count: 0, config: { transport: "stdio", command: "<redacted>" } };
  const view = (items: object[] = [fixture]) => ({ revision: "a".repeat(64), data: { items } });
  const roles: string[] = [];
  return { kind: "visible", options: { path: "/connections/project/fixture-project", roles, rpc: {
    hello: (params) => ({ result: { protocol_version: "1.2", capabilities: { features: params.features,
      requests: ["mcp_server_list", ...(params.role === "controller" ? [method] : [])] } } }),
    mcp_server_list: ({ scope }) => ({ result: view(scope === "user" ? [] : [fixture]) }),
    [method]: () => id === "mcp.test" ? { result: { data: { status: "ok", tool_count: 1 } } } : ({ result: { ...view(id === "mcp.remove" ? [] : [{ ...fixture, enabled: false, trusted: true }]),
      restart: { serve: false, sessions: [], complete: true } } }),
  } }, check: async (app, authority, writes) => {
    const requestStart = roles.length;
    expect(roles.at(-1)).toBe(authority);
    const trigger = select(app, tag(id));
    await click(trigger);
    expect(writes).toEqual([]);
    expect(roles).toHaveLength(requestStart);
    if (id === "mcp.test") await click(app.getByRole("checkbox", { name: "i reviewed the scope" }));
    else if (id !== "mcp.enabled") await change(app.getByRole("textbox", { name: "type fixture-project to confirm" }), "fixture-project");
    const confirm = document.querySelector<HTMLButtonElement>(".confirmation-primary")!;
    expect(confirm.disabled).toBe(false);
    if (id === "mcp.enabled") await click(confirm);
    else await act(async () => { fireEvent.submit(confirm.form!); });
    if (authority === "observer") {
      expect(app.getByRole("alert").textContent).toContain("too many tabs control zeta");
      expect(roles.slice(requestStart)).toEqual(["controller"]);
      expect(writes).toEqual([]);
    } else {
      expect(roles.slice(requestStart)).toEqual([]);
      expect(writes).toEqual([method]);
    }
  } };
}

function mcpOAuth(action: "start" | "cancel" | "logout", changed = false): Row {
  const name = "fixture-oauth";
  const sentinel = "http://127.0.0.1:31234/launch/browser-only-fixture";
  const roles: string[] = [];
  // `changed`: the configuration changes after the review opened, before the write is confirmed
  let edited = false;
  const fixture = { name, scope: "user", enabled: true, trusted: true, status: "configured", auth: "none", tool_count: 0,
    config: { transport: "streamable-http", url: "<redacted-url>", auth: { type: "oauth" } } };
  return { kind: "visible", options: { path: `/connections/user/${name}`, roles, rpc: {
    hello: (params) => ({ result: { protocol_version: "1.2", capabilities: { features: params.features,
      requests: ["mcp_server_list", "mcp_auth_status", ...(params.role === "controller" ? ["mcp_auth_start", "mcp_auth_cancel", "mcp_auth_logout"] : [])] } } }),
    mcp_server_list: ({ scope }) => {
      const revision = (edited && action === "start" ? "b" : "a").repeat(64);
      const row = edited && action === "logout" ? { ...fixture,
        config: { ...fixture.config, auth: { type: "oauth", client_secret: "<redacted>" } } } : fixture;
      return { result: { revision, data: { items: scope === "project" ? [] : [row] } } };
    },
    mcp_auth_start: () => ({ result: { data: { state: "pending", authorization_url: sentinel } } }),
    mcp_auth_status: () => ({ result: { data: { state: "pending" } } }),
    mcp_auth_cancel: () => ({ result: { data: { state: "cancelled" } } }),
    mcp_auth_logout: () => ({ result: { data: { state: "unauthorized" } } }),
  } }, check: async (app, authority, writes) => {
    const replacements: string[] = [];
    const popup = { opener: window as Window | null, closed: false, close() { this.closed = true; }, location: {
      replace(url: string) { expect(popup.opener).toBeNull(); replacements.push(url); },
    } };
    const open = spyOn(window, "open").mockReturnValue(popup as unknown as Window);
    const consoleCalls = ["log", "warn", "error", "debug", "info"].map(method => spyOn(console, method as "log"));
    try {
      const startReview = async () => {
        await click(select(app, tag("mcp.auth-start")));
        const dialog = app.getByRole("dialog", { name: "review OAuth sign-in" });
        expect(disabled(dialog.querySelector("button[type=submit]")!)).toBe(true);
        await click(app.getByRole("checkbox", { name: "i reviewed the scope" }));
        edited = changed;
        await act(async () => {
          fireEvent.submit(dialog.querySelector("form")!);
          expect(open).toHaveBeenCalledTimes(1);
        });
      };
      const initial = roles.length;
      if (action === "logout") {
        await click(select(app, tag("mcp.auth-logout")));
        const dialog = app.getByRole("dialog", { name: "review saved sign-in deletion" });
        const proof = app.getByRole("textbox", { name: `type ${name} to confirm` });
        await change(proof, "not-the-name");
        expect(disabled(dialog.querySelector("button[type=submit]")!)).toBe(true);
        await change(proof, name);
        expect(roles).toHaveLength(initial);
        edited = changed;
        await act(async () => { fireEvent.submit(dialog.querySelector("form")!); });
      } else {
        expect(app.container.querySelector(tag("mcp.auth-cancel"))).toBeNull();
        await startReview();
      }
      if (authority === "observer") {
        expect(app.getByRole("alert").textContent).toContain("too many tabs control zeta");
        expect(roles.slice(initial)).toEqual(["controller"]);
        expect(writes).toEqual([]);
        expect(replacements).toEqual([]);
        return;
      }
      if (changed) {
        expect(writes, `${action}: stale review must not send an OAuth write`).toEqual([]);
        expect(app.getByRole("alert").textContent).toContain("configuration changed elsewhere");
        expect(roles.slice(initial)).toEqual([]);
        expect(replacements).toEqual([]);
        if (action === "start") expect(popup.closed).toBe(true);
        return;
      }
      if (action === "cancel") {
        await click(select(app, tag("mcp.auth-cancel")));
        const group = app.getByRole("group", { name: /started saving the credential/ });
        expect(writes).toEqual(["mcp_auth_start"]);
        await click(group.querySelector(".confirmation-primary")!);
      }
      expect(writes).toEqual(action === "cancel" ? ["mcp_auth_start", "mcp_auth_cancel"] : [`mcp_auth_${action}`]);
      expect(roles.slice(initial)).toEqual([]);
      expect(replacements).toEqual(action === "logout" ? [] : [sentinel]);
      expect(JSON.stringify([document.documentElement.outerHTML, location.href, history.state,
        ...[localStorage, sessionStorage].map(store => Array.from({ length: store.length }, (_, i) => store.getItem(store.key(i)!))),
        ...consoleCalls.flatMap(spy => spy.mock.calls)])).not.toContain(sentinel);
    } finally { open.mockRestore(); consoleCalls.forEach(spy => spy.mockRestore()); }
  } };
}

test.each(["start", "logout"] as const)("OAuth %s refuses a review that went stale before confirm", async (action) => {
  const row = mcpOAuth(action, true);
  await withApp("controller", row.options ?? {}, (app, writes, requests) => row.check(app, "controller", writes, requests));
});

// /agents is read-only: a catalog tab is its own zeta controller with no session, so it cannot act on a chat's children.
// the controls stay registered for the chat tab, which gets them in a later slice.
function agentReadOnly(id: "agents.spawn" | "agents.cancel" | "agents.send"): Row {
  return { kind: "visible", options: { path: "/agents/session/fixture-run", rpc: {
    hello: (params) => ({ result: { protocol_version: "1.2", capabilities: { features: params.features, requests: ["agent_run_catalog"] } } }),
    agent_run_catalog: () => ({ result: { revision: "1", data: { items: [{ session_id: "session", run_id: "fixture-run", parent_run_id: null,
      agent_type: "fixture-profile", description: "fixture task", status: "idle", accepts_follow_ups: true, turns_used: 1,
      tool_count: 0, current_step: "waiting", started_at: "2026-01-01", finished_at: null, elapsed_seconds: 1 }] } } }),
  } }, check: async (app, _authority, writes) => {
    await app.findByRole("heading", { name: /fixture task/ });
    expect(app.getByText("control a chat's agents from its tab.")).toBeTruthy();
    expect(app.container.querySelector(tag(id))).toBeNull();
    expect(writes).toEqual([]);
  } };
}

const rows: Record<WriteSurfaceId, Row> = {
  "accounts.login": browserLogin(false),
  "accounts.login-cancel": browserLogin(true),
  "agents.spawn": agentReadOnly("agents.spawn"),
  "agents.cancel": agentReadOnly("agents.cancel"),
  "agents.send": agentReadOnly("agents.send"),
  "create.retry": creationAction("retry"),
  "create.discard": creationAction("discard"),
  "busy.retry": { kind: "visible", absent: true, options: { rpc: { status: (_params, requests) => ({ result: requests.filter((request) => request === "status").length <= 2 ? { state: "running", session: { session_id: "other" } } : { state: "idle" } }) } }, check: async (app, authority, writes) => {
    await click(select(app, tag("shell.new-chat")));
    const control = app.container.querySelector<HTMLElement>(tag("busy.retry"));
    if (authority === "observer") {
      expect(Boolean(control)).toBe(false);
      await keydown(select(app, '[data-part="composer"]'), "Enter");
    } else {
      expect(Boolean(control) && !disabled(control!)).toBe(true);
      const before = writes.length;
      await click(control!);
      didWrite(writes.slice(before), "new_session");
    }
  } },
  "approval.approve": approval("approve"),
  "approval.deny": approval("deny"),
  "delivery.retry": { kind: "visible", absent: true, options: { attached: true, unsent: true }, check: async (app, authority, writes) => {
    if (authority === "observer") {
      expect(Boolean(app.container.querySelector(tag("delivery.retry")))).toBe(false);
      await keydown(select(app, '[data-part="composer"]'), "Enter");
    } else {
      const before = writes.length;
      const retry = select(app, tag("delivery.retry"));
      expect(disabled(retry)).toBe(false);
      await click(retry);
      didWrite(writes.slice(before), "send");
    }
  } },
  "record.update": { kind: "visible", options: { tool: modify, page: { layout: { blocks: [{ type: "form", title: "edit book", tool: modify.name }, { type: "list", title: "books", collection: "books" }] } }, http: (path) => path.includes("/records/books") ? Response.json([existingBook]) : undefined }, check: async (app, authority, writes) => {
    await click(app.getByText("Old book", { exact: true }));
    const form = select(app, '.record-form form');
    const submit = select(app, '.record-form button[type="submit"]');
    if (authority === "controller") await change(select(app, '.record-form input[name="title"]'), "Updated fixture title");
    expect(disabled(submit)).toBe(authority === "observer");
    await act(async () => { fireEvent.submit(form); });
    if (authority === "controller") didWrite(writes, "POST /api/pages/page/tools/edit_book/invoke");
  } },

  "auth.login": recoveryWrite("auth.login", "login_start"),
  "auth.switch": recoveryWrite("auth.switch", "account_switch"),
  "auth.new-chat": recoveryWrite("auth.new-chat", "new_session"),
  "composer.account-switch": { kind: "command", options: accountFixture([]), check: async (app, authority, writes, requests) => {
    const run = async (text: string) => {
      const field = select(app, '[data-part="composer"] textarea');
      await change(field, text);
      await keydown(field, "Enter");
    };
    if (authority === "observer") {
      expect(select(app, '[data-part="composer"] textarea').getAttribute("placeholder")).toBe("read-only");
      expect(requests).not.toContain("account_list");
      return;
    }
    await run("/accounts");
    expect(app.queryByRole("dialog", { name: "review chat account switch" })).toBeNull();
    expect(writes).not.toContain("account_switch");
    await run(`/accounts ${toAccount}`);
    await click(await proveSwitch(app, writes));
    expect(writes.filter(write => write === "account_switch")).toHaveLength(1);
    expect(app.getByText(/Fixture chat: switched to/)).toBeTruthy();
    expect(writes).not.toContain("send");
  } },
  "settings.theme": setting("settings.theme", "theme", ' button[aria-selected="false"]'),
  "settings.ui-font": setting("settings.ui-font", "uiFont", ' button[aria-pressed="false"]'),
  "settings.code-font": setting("settings.code-font", "codeFont", ' button[aria-pressed="false"]'),
  "settings.size": setting("settings.size", "size", ' button[aria-pressed="false"]'),
  "settings.density": setting("settings.density", "density", ' button[aria-pressed="false"]'),
  "settings.vim": setting("settings.vim", "vim"),
  "settings.auto-approve": setting("settings.auto-approve", "autoApproveDefault", "", true),
  "settings.reset": setting("settings.reset", "size", "", true),
  "shell.new-chat": button(tag("shell.new-chat"), "new_session"),
  "page-chat.new": dockedWrite("page-chat.new", "new_session"),
  "composer.auto-approve": button(tag("composer.auto-approve"), "set_settings", { attached: true, rpc: { set_settings: (params) => ({ result: { approval_mode: params.approval_mode } }) } }),
  "composer.create-mode": button(tag("composer.create-mode"), "POST /api/pages/page/create-mode", { attached: true }),
  "composer.send": composer("send"),
  "composer.steer": composer("steer", running),
  "composer.abort": composer("abort", running),
  "empty.send": button(`${tag("empty.send")} button`, "send", { attached: true, tool: { ...insert, description: "Add a fixture book" } }),
  "empty.create": button(`${tag("empty.send")} button`, "mcp_refresh_tools", { attached: true }),
  "empty.continue": button(`${tag("empty.send")} button:last-child`, "resume", { chat: { ...chat, last_state: "approval" } }),
  "missing.new-chat": button(tag("missing.new-chat"), "new_session", { attached: true, http: (path) => path.startsWith("/api/chats?") ? Response.json({ chats: [], next: null, approval_count: 0 }) : undefined }),
  "header.rename": { kind: "visible", absent: true, options: { attached: true }, check: async (app, authority, writes) => {
    const title = select(app, tag("header.rename"));
    expect(title.getAttribute("role")).toBe(authority === "controller" ? "button" : null);
    await click(title);
    if (authority === "controller") {
      const editor = select(app, ".chat-title-edit");
      await change(editor, "renamed fixture");
      await keydown(editor, "Enter");
      didWrite(writes, 'PATCH /api/chats/session {"title":"renamed fixture"');
    } else expect(Boolean(app.container.querySelector(".chat-title-edit"))).toBe(false);
  } },
  "sidebar.rename": { kind: "visible", absent: true, options: { attached: true }, check: async (app, authority, writes) => {
    const control = app.container.querySelector<HTMLElement>(tag("sidebar.rename"));
    expect(Boolean(control)).toBe(authority === "controller");
    if (authority === "observer") { await keydown(select(app, ".chat-row"), "F2"); return; }
    await click(control!);
    const editor = select(app, '.chat-row input');
    await change(editor, "renamed from sidebar");
    await keydown(editor, "Enter");
    didWrite(writes, 'PATCH /api/chats/session {"title":"renamed from sidebar"');
  } },
  "keyboard.commands": { kind: "command", absent: true, check: async (_app, authority, writes) => {
    await keydown(window, "o", { ctrlKey: !isMac, metaKey: isMac, shiftKey: true });
    if (authority === "controller") didWrite(writes, "new_session");
  } },
  "history.restore": { kind: "visible", options: { page: { create_mode: true }, http: (path) => path.endsWith("/versions") ? Response.json({ layout: [1, 2].map((version) => ({ version, created_at: "2026-01-01", block_types: [], active: version === 2 })), tools: [] }) : undefined }, check: async (app, authority, writes) => {
    await click(select(app, '.chat-actions > button:not([data-write-surface])'));
    const restore = select(app, tag("history.restore"));
    expect(disabled(restore)).toBe(authority === "observer");
    await click(restore);
    if (authority === "controller") {
      await click(select(app, '.history-confirm ' + tag("history.restore")));
      didWrite(writes, "POST /api/pages/page/layout/restore");
    }
  } },
  "record.add": { kind: "local-only", options: records, check: async (app, authority, writes) => {
    const control = app.getByText("Add a book", { selector: "button", exact: true });
    const field = select(app, '.record-form input[name="title"]');
    expect(disabled(field)).toBe(authority === "observer");
    if (authority === "observer") expect(select(app, ".record-form .form-note").textContent).toContain("read-only");
    await click(control);
    expect(document.activeElement === field).toBe(authority === "controller");
    expect(writes).toEqual([]);
  } },
  "library.create": { kind: "visible", options: library(true), check: async (app, authority, writes) => {
    // library tabs start as observers either way; "+ new" takes control only if the controller slot is free.
    await click(select(app, tag("library.create")));
    if (authority === "observer") {
      expect(app.getByText(/^zeta is still full at .+\. close another zeta tab, then try again\.$/)).toBeTruthy();
      expect(app.container.querySelector(".library-editor")).toBeNull();
      return;
    }
    await change(select(app, '.library-editor input[aria-describedby$="-rules"]'), "fixture-skill");
    await change(app.getByLabelText("description") as HTMLElement, "synthetic skill");
    await click(app.getByText("save skill", { selector: "button", exact: true }));
    expect(await app.findByText(/^saved fixture-skill to home · skills\/fixture-skill\.md\. running sessions pick up the change at their next catalog refresh\.$/)).toBeTruthy();
    didWrite(writes, "skill_write");
  } },
  "library.edit": { kind: "visible", options: libraryFile, check: async (app, authority, writes) => {
    // the edit control appears on a revealed file that zeta sent as a raw document; it takes control like "+ new".
    await click(await app.findByRole("button", { name: /fixture-skill/ }));
    await click(app.getByText("show skill text", { selector: "button", exact: true }));
    await click(await app.findByText("edit", { selector: tag("library.edit"), exact: true }));
    if (authority === "observer") {
      expect(app.getByText(/^zeta is still full at .+\. close another zeta tab, then try again\.$/)).toBeTruthy();
      expect(app.container.querySelector(".library-editor")).toBeNull();
      return;
    }
    await change(select(app, ".library-editor textarea"), `${fixtureFile}more\n`);
    await click(app.getByText("save skill", { selector: "button", exact: true }));
    expect(await app.findByText(/^saved fixture-skill to home · skills\. running sessions pick up the change at their next catalog refresh\.$/)).toBeTruthy();
    didWrite(writes, "skill_write");
  } },
  "mcp.add": mcpAdd(),
  "mcp.enabled": mcpWrite("mcp.enabled", "mcp_server_set_enabled"),
  "mcp.trusted": mcpWrite("mcp.trusted", "mcp_server_set_trusted"),
  "mcp.test": mcpWrite("mcp.test", "mcp_server_test"),
  "mcp.auth-start": mcpOAuth("start"),
  "mcp.auth-cancel": mcpOAuth("cancel"),
  "mcp.auth-logout": mcpOAuth("logout"),
  "mcp.remove": mcpWrite("mcp.remove", "mcp_server_remove"),
  "settings.telemetry": { kind: "visible", options: homeSettings, check: async (app, authority, writes) => {
    // a controller tab sends the one update; a fallback observer tab (zeta full) is refused before it sends.
    await click(await app.findByText("turn on telemetry", { selector: tag("settings.telemetry") }));
    const dialog = await app.findByRole("dialog", { name: "turn on telemetry" });
    await click(app.getByRole("checkbox", { name: "i understand this applies to every zeta on this computer" }));
    await click(dialog.querySelector<HTMLElement>(".confirmation-primary")!);
    if (authority === "observer") {
      expect((await app.findByRole("alert")).textContent).toBe("not changed. too many tabs control zeta, or another app does. close one, then try again.");
      return;
    }
    // the time is its own element: match the receipt's whole text
    expect(await app.findByText((_, node) => node?.tagName === "P" && /^at .+: telemetry is on\. restart zeta to start recording\. a zeta without zeta\[otel\] does not start; turn it off here\.$/.test(node.textContent ?? ""))).toBeTruthy();
    expect(app.getByText("restart zeta serve. this list goes away when you leave this page.")).toBeTruthy();
    didWrite(writes, "home_settings_update");
  } },
  "record.insert": { kind: "visible", options: records, check: async (app, authority, writes) => {
    const form = select(app, '.record-form form');
    const submit = select(app, '.record-form button[type="submit"]');
    if (authority === "controller") await change(select(app, '.record-form input[name="title"]'), "Fixture title");
    expect(disabled(submit)).toBe(authority === "observer");
    await act(async () => { fireEvent.submit(form); });
    if (authority === "controller") didWrite(writes, "POST /api/pages/page/tools/add_book/invoke");
  } },
  "page.chat": { kind: "visible", absent: true, options: { page: { layout: { blocks: [{ type: "list", title: "Books", collection: "books" }] } }, attached: true }, check: async (app, authority, writes) => {
    const ask = app.queryByText("Ask the chat", { selector: "button", exact: true });
    expect(Boolean(ask)).toBe(authority === "controller");
    if (!ask) { await keydown(select(app, '[data-part="composer"]'), "Enter"); return; }
    await click(ask);
    const field = select(app, "textarea") as HTMLTextAreaElement;
    expect(field.value).toContain("add a book");
    await act(async () => { fireEvent.submit(field.closest("form")!); });
    didWrite(writes, "send");
  } },
  "sessions.continue": { kind: "visible", options: { ...sessionDetail(), roles: [] }, check: async (app, authority, writes, requests) => {
    const action = await app.findByRole("button", { name: "continue in chat" });
    expect(disabled(action)).toBe(false);
    // an observer here is the zeta-full case: its controller hello was refused first
    const opened = authority === "observer" ? ["controller", "observer"] : ["controller"];
    expect(rows["sessions.continue"].options!.roles).toEqual(opened);
    expect(writes).toEqual([]);
    action.focus();
    await click(action);
    expect(rows["sessions.continue"].options!.roles).toEqual(authority === "observer" ? [...opened, "controller"] : opened);
    if (authority === "observer") {
      expect(await app.findByText(/^zeta is still full at .+\. close another zeta tab, then try again\.$/)).toBeTruthy();
      expect(location.pathname).toBe("/sessions/session");
      expect(document.activeElement).toBe(action);
      expect(writes).toEqual([]);
    } else {
      expect(location.pathname + location.search + location.hash).toBe("/?chat=session#continue-chat");
      expect(writes).toEqual(['POST /api/pages/home/chats {"session_id":"session"}']);
    }
  } },
  "passive.last-state": { kind: "passive", options: { attached: true }, check: async (_app, authority, writes) => {
    if (authority === "controller") didWrite(writes, 'PATCH /api/chats/session {"last_state":');
  } },
  "passive.first-message": { kind: "passive", options: { attached: true, chat: { ...chat, title: null, message_sent: false, titled_by_user: false } }, check: async (app, authority, writes, requests) => {
    await composer("send").check(app, authority, writes, requests);
    if (authority === "controller") didWrite(writes, 'PATCH /api/chats/session {"first_message":"fixture prompt"');
  } },
  "passive.title": { kind: "passive", options: { attached: true, chat: { ...chat, titled_by_user: false }, rpc: { resume: () => ({ result: { session: { name: "updated title" } } }) } }, check: async (_app, authority, writes) => {
    if (authority === "controller") didWrite(writes, 'PATCH /api/chats/session {"title":"updated title"');
  } },
  "passive.attachment": { kind: "passive", options: { attached: true }, check: async (_app, authority, writes, requests) => {
    expect(requests).toContain("session_history_and_subscribe");
    if (authority === "controller") didWrite(writes, "resume");
  } },
  "passive.repair": { kind: "passive", options: { attached: true, chat: { ...chat, title: null, message_sent: false, titled_by_user: false }, joined: { messages: [userMessage] } }, check: async (_app, authority, writes) => {
    if (authority === "controller") didWrite(writes, 'PATCH /api/chats/session {"first_message":"Fixture history title"');
  } },
  "palette.commands": { kind: "command", options: { browserPreference: "vim" }, check: async (app, authority, writes) => {
    await click(select(app, ".palette-button"));
    expect(WRITE_SURFACES.find(({ id }) => id === "palette.commands")).toMatchObject({ channel: "http-and-storage", observer: "browser-only" });
    expect(Boolean(app.queryByText("toggle create mode", { exact: true }))).toBe(authority === "controller");
    await click(app.getByText("toggle vim mode", { exact: true }));
    expect(getSettings().vim).toBe(true);
    expect(JSON.parse(localStorage.getItem(SETTINGS_KEY)!).vim).toBe(true);
    expect(writes).toEqual([]);
  } },
};

test.each(WRITE_SURFACES)("public authority: $id", async ({ id, visibility }) => {
  expect(Object.keys(rows).sort()).toEqual(WRITE_SURFACES.map(({ id }) => id).sort());
  const row = rows[id]!;
  expect(row.kind === "local-only" ? "visible" : row.kind).toBe(visibility);
  for (const authority of ["observer", "controller"] as const) {
    await withApp(authority, row.options ?? {}, (app, writes, requests) => row.check(app, authority, writes, requests));
  }
});

test.each([
  ["child", { parent_session_id: "parent" }, "child sessions cannot continue as top-level chats. open the parent session instead."],
  ["leased", { in_use: true, owner_pid: 999999 }, "this session is active in another zeta process. close it there, then try again."],
  ["offline", {}, "connect to zeta to continue this session in chat."],
  ["pending", {}, "opening this session in chat…"],
] as const)("session continuation detail: %s", async (name, metadata, reason) => {
  const sockets: EventTarget[] = [];
  const options = { ...sessionDetail(metadata), sockets };
  await withApp("controller", options, async (app, writes) => {
    const action = await app.findByRole("button", { name: "continue in chat" });
    if (name === "offline") await act(async () => { sockets[0]!.dispatchEvent(new Event("close")); });
    if (name === "pending") {
      // The scheduled hello reply has not reached the app in this synchronous click task.
      act(() => { fireEvent.click(action); });
      expect(action.textContent).toBe("continuing…");
    }
    expect(disabled(action)).toBe(true);
    expect(document.getElementById(action.getAttribute("aria-describedby")!)?.textContent).toBe(reason);
    expect(app.container.textContent).not.toContain("999999");
    expect(writes).toEqual([]);
    if (name === "pending") await act(async () => {});
  });
});

for (const authority of ["controller", "observer"] as const) test(`continuation attachment and replay: ${authority}`, async () => {
  const divider = "today · continuing session session. zeta keeps the full history; new messages append to it.";
  await withApp(authority, { path: "/?chat=session#continue-chat", chat, joined: { messages: [userMessage] } }, async (app, writes, _requests, emit) => {
    const old = await app.findByText("Fixture history title", { selector: '.transcript *' });
    if (authority === "observer") {
      expect(writes).toEqual([]);
      expect(app.queryByText(divider)).toBeNull();
      expect(location.hash).toBe("#continue-chat");
      return;
    }
    const marker = await app.findByText(divider);
    expect(marker.getAttribute("role")).toBe("status");
    expect(old.compareDocumentPosition(marker) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(writes.filter((method) => method === "resume")).toHaveLength(1);
    expect(location.hash).toBe("");
    expect(document.activeElement).toBe(app.getByRole("textbox", { name: "message" }));
    await act(async () => { emit({ jsonrpc: "2.0", method: "event", params: { event: "user_message", session_id: "session", text: "Fixture appended message", mode: "send" } }); });
    const appended = await app.findByText("Fixture appended message");
    expect(marker.compareDocumentPosition(appended) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
  if (authority === "controller") await withApp(authority, { attached: true, joined: { messages: [userMessage] } }, async (app) => {
    await app.findByText("Fixture history title", { selector: '.transcript *' });
    expect(app.queryByText(divider)).toBeNull();
  });
});

test.each([
  [-32004, "session_owned", "this session is active in another zeta process. close it there, then try again."],
  [-32003, "session_not_found", "this session no longer exists. refresh sessions to update the list."],
] as const)("continuation attachment sanitizes %s %s", async (code, reason, copy) => {
  const resume = () => ({ error: { code, message: "fixture raw error 999999", data: { code: reason, owner: { pid: 999999, surface: "fixture surface" } } } });
  await withApp("controller", { path: "/?chat=session#continue-chat", chat, rpc: { resume } }, async (app, writes) => {
    expect(await app.findByText(copy, {}, { timeout: 3000 })).toBeTruthy();
    expect(writes).toEqual(Array(code === -32004 ? 4 : 1).fill("resume"));
    expect(app.container.textContent).not.toContain("999999");
    expect(app.queryByRole("textbox", { name: "message" })).toBeNull();
  });
});

test.each([
  ["no library_write_v1", library(true, false, true), false, false],
  ["the controller lacks skill_write", library(true, true, false), true, false],
  ["neither", library(false), false, false],
  ["both", library(true), true, true],
] as const)("library create control renders only with the write capability: %s", async (_name, options, shown, saves) => {
  await withApp("controller", options, async (app, writes) => {
    await app.findByText("no skills found");
    expect(Boolean(app.container.querySelector(tag("library.create")))).toBe(shown);
    if (shown) {
      // without the write method the control stays, disabled, and says why; with it, the form opens with save.
      expect(disabled(select(app, tag("library.create")))).toBe(!saves);
      expect(Boolean(app.queryByText("this zeta does not allow saving here"))).toBe(!saves);
      await click(select(app, tag("library.create")));
      expect(Boolean(app.container.querySelector(".library-editor"))).toBe(saves);
      expect(Boolean(app.queryByText(/^save/, { selector: "button" }))).toBe(saves);
    }
    expect(writes).toEqual([]);
  });
});

test("a library take-control refusal still shows after the observer socket is replaced during the attempt", async () => {
  const sockets: (EventTarget & { close(): void })[] = [];
  const base = library(true);
  const hello = base.rpc!.hello!;
  const options: Options = { ...base, sockets: sockets as EventTarget[], rpc: { ...base.rpc, hello: async (params, requests) => {
    if (params.role !== "controller") return hello(params, requests);
    if (sockets.length > 1) sockets.at(-2)!.close(); // after load: the observer drops while the controller handshake is in flight
    return { error: { code: -32001, message: "controller occupied" } };
  } } };
  await withApp("observer", options, async (app) => {
    await app.findByText("no skills found");
    await click(select(app, tag("library.create")));
    expect(await app.findByText(/^zeta is still full at .+\. close another zeta tab, then try again\.$/, {}, { timeout: 3_000 })).toBeTruthy();
    expect(await app.findByText("no skills found", {}, { timeout: 3_000 })).toBeTruthy();
    expect(app.getByText(/^zeta is still full at .+\. close another zeta tab, then try again\.$/)).toBeTruthy();
  });
});

test("a typed create draft comes back after the socket drops and reconnects", async () => {
  const sockets: (EventTarget & { close(): void })[] = [];
  await withApp("controller", { ...library(true), sockets: sockets as EventTarget[] }, async (app, writes) => {
    await app.findByText("no skills found");
    await click(select(app, tag("library.create")));
    await change(select(app, '.library-editor input[aria-describedby$="-rules"]'), "fixture-draft");
    await change(select(app, ".library-editor textarea"), "---\nname: fixture-draft\ndescription: typed by hand\n---\nunsaved text\n");
    await act(async () => { sockets.at(-1)!.close(); });
    expect(app.container.querySelector(".library-editor")).toBeNull(); // the module unmounts while zeta is away
    await app.findByText("no skills found", {}, { timeout: 3_000 }).catch(() => undefined);
    const text = await app.findByDisplayValue(/unsaved text/, {}, { timeout: 3_000 });
    expect((text as HTMLTextAreaElement).value).toBe("---\nname: fixture-draft\ndescription: typed by hand\n---\nunsaved text\n");
    expect((select(app, '.library-editor input[aria-describedby$="-rules"]') as HTMLInputElement).value).toBe("fixture-draft");
    expect(writes.filter((write) => write.endsWith("_write"))).toEqual([]);
  });
});

const requestApprovalChange = async (app: RenderResult) => {
  await click(select(app, tag("composer.auto-approve")));
};

const turnedOn = { result: { revision: `sha256:${"c".repeat(64)}`, settings: { telemetry: { enabled: true, source: "builtin", editable: true } }, settings_malformed: false } };
const staleRevision = { error: { code: -32009, message: "settings.toml changed since the given revision", data: { code: "stale_revision" } } };
const otelMissing = { error: { code: -32602, message: "invalid params", data: { code: "telemetry_unavailable", detail: "OpenTelemetry support is not installed; install zeta[otel]" } } };
test.each([
  ["a stale on", "off", staleRevision, "not changed. the state changed elsewhere; the row now shows the current state."],
  ["a stale off", "on", staleRevision, "not changed. the state changed elsewhere; the row now shows the current state."],
  ["an on refused for zeta[otel]", "off", otelMissing,
    "not changed. the state changed elsewhere; the row now shows the current state. zeta cannot record telemetry on this computer: OpenTelemetry support is not installed; install zeta[otel]"],
] as const)("%s whose reread shows it on elsewhere keeps the reason, shows no receipt, and focuses the row control", async (_name, start, reply, reason) => {
  // the file was turned on elsewhere meanwhile: the update fails, and the reread finds telemetry on at a new revision
  const off = { result: { revision: `sha256:${"a".repeat(64)}`, settings: { telemetry: { enabled: false, source: "off", editable: true } }, settings_malformed: false } };
  const before = start === "on" ? { result: { ...turnedOn.result, revision: `sha256:${"a".repeat(64)}` } } : off;
  const options: Options = { ...homeSettings, rpc: { ...homeSettings.rpc,
    home_settings_get: (_params, requests) => requests.includes("home_settings_update") ? turnedOn : before,
    home_settings_update: () => reply,
  } };
  await withApp("controller", options, async (app, writes) => {
    if (start === "off") {
      await click(await app.findByText("turn on telemetry", { selector: tag("settings.telemetry") }));
      const dialog = await app.findByRole("dialog", { name: "turn on telemetry" });
      await click(app.getByRole("checkbox", { name: "i understand this applies to every zeta on this computer" }));
      await click(dialog.querySelector<HTMLElement>(".confirmation-primary")!);
    } else {
      await click(await app.findByText("turn off", { selector: tag("settings.telemetry") }));
      await click(document.querySelector<HTMLElement>("#telemetry .confirmation-primary")!);
    }
    await app.findByText(reason);
    const turnOff = app.getByText("turn off", { selector: tag("settings.telemetry") });
    // compare markup: a failing element diff crashes bun
    expect(document.activeElement?.outerHTML).toBe(turnOff.outerHTML);
    // this tab wrote nothing: no on receipt, only the warning that holds whoever turned it on
    expect(app.queryByText(/restart zeta to start recording/)?.textContent ?? null).toBeNull();
    expect(app.getByText("a zeta without zeta[otel] does not start; turn it off here.")).toBeTruthy();
    expect(app.queryByRole("dialog")).toBeNull();
    expect(writes.filter((write) => write === "home_settings_update")).toHaveLength(1);
  });
});

test("tool approval waits for the turn end and reports the authoritative result", async () => {
  let busy = true;
  const rpc = {
    status: () => ({ result: { state: busy ? "running" : "idle", session: { session_id: "session" } } }),
    set_settings: (params: Record<string, unknown>) => ({ result: { approval_mode: params.approval_mode } }),
  };
  await withApp("controller", { ...docked, rpc }, async (app, writes, _requests, emit) => {
    await requestApprovalChange(app);
    expect(writes).not.toContain("set_settings");
    expect(app.getByText("waiting for the turn to finish…")).toBeTruthy();
    expect(select(app, tag("composer.auto-approve")).getAttribute("aria-checked")).toBe("true");
    busy = false;
    await act(async () => { emit({ jsonrpc: "2.0", method: "event", params: { event: "agent_end", session_id: "session" } }); });
    expect(writes).toContain("set_settings");
    expect(select(app, tag("composer.auto-approve")).getAttribute("aria-checked")).toBe("false");
  });
});

test("tool approval errors leave the old setting and a stale chat never writes", async () => {
  let reads = 0;
  let release!: (result: object) => void;
  const held = new Promise<object>((resolve) => { release = resolve; });
  const settings = { result: { model: "fixture", approval_mode: "allow" } };
  await withApp("controller", { ...docked, extraChat: { ...chat, title: "Other fixture chat", session_id: "other" }, rpc: {
    session_settings: (params) => params.session_id === "session" && ++reads === 3 ? held : settings,
    set_settings: () => ({ error: { code: -32000, message: "fixture refused" } }),
    resume: (params) => ({ result: { session: { session_id: params.session_id } } }),
  } }, async (app, writes) => {
    try {
      await requestApprovalChange(app);
      expect(app.getByText("could not change tool approval; try again")).toBeTruthy();
      expect(select(app, tag("composer.auto-approve")).getAttribute("aria-checked")).toBe("true");
      await click(select(app, tag("composer.auto-approve")));
      expect(app.getByText("saving…")).toBeTruthy();
      await click(select(app, '[aria-haspopup="listbox"]'));
      await click(app.getByRole("option", { name: /Other fixture chat/ }));
      await act(async () => { release(settings); });
      expect(writes.filter((method) => method === "set_settings")).toHaveLength(1);
      expect(select(app, "#page-chat-title").textContent).toBe("Other fixture chat");
      expect(app.queryByText("could not change tool approval; try again")).toBeNull();
    } finally { release(settings); }
  });
});

test("the composer holds the chat's modes and model; the header and sidebar have no mode controls", async () => {
  await withApp("controller", { attached: true, rpc: { session_settings: () => ({ result: { model: "fixture-model", approval_mode: "allow" } }) } }, async (app) => {
    const modes = select(app, '[data-part="composer"] [data-part="composer-modes"]');
    expect(modes.querySelector(tag("composer.create-mode"))?.getAttribute("role")).toBe("switch");
    expect(modes.querySelector(tag("composer.auto-approve"))?.getAttribute("aria-checked")).toBe("true");
    expect(modes.querySelector('[data-part="composer-model"]')?.textContent).toBe("fixture-model");
    expect(app.container.querySelector(".chat-header [aria-pressed], .chat-header .approval-mode, .create-split button")).toBeNull();
  });
});

test("a server that forces tool approval holds the composer switch off and says why", async () => {
  await withApp("controller", { attached: true, page: { approval_mode: "ask" }, rpc: { session_settings: () => ({ result: { model: "fixture-model", approval_mode: "ask" } }) } }, async (app, writes) => {
    const toggle = select(app, tag("composer.auto-approve"));
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(disabled(toggle)).toBe(true);
    expect(toggle.getAttribute("title")).toBe("this server requires tool approval");
    await click(toggle);
    expect(writes).not.toContain("set_settings");
  });
});

test("a new chat's composer shows zeta's default model", async () => {
  await withApp("controller", { rpc: { state_settings: () => ({ result: { model: "default-model", provider: null, approval_mode: null, max_depth: 1 } }) } }, async (app) => {
    expect((await app.findByText("default-model", { selector: '[data-part="composer-model"]' })).textContent).toBe("default-model");
  });
});

test.each([["allow", "ask"], ["ask", "allow"]] as const)("an observer shows the chat's own modes and model (server %s, session %s)", async (server, session) => {
  await withApp("observer", { attached: true, page: { approval_mode: server }, rpc: { session_settings: () => ({ result: { model: "chat-model", approval_mode: session } }) } }, async (app) => {
    expect(select(app, tag("composer.auto-approve")).getAttribute("aria-checked")).toBe("false");
    expect(select(app, '[data-part="composer-model"]').textContent).toBe("chat-model");
  });
});

test("a create mode failure that cannot be retried shows once on a page with blocks", async () => {
  const expired = { error: { code: -32005, message: "refresh failed", data: { reason: "MCP HTTP 404: Session not found" } } };
  await withApp("controller", { ...docked, rpc: { mcp_refresh_tools: () => expired },
    http: (path, method) => method === "POST" && path.endsWith("/create-mode") ? Response.json({ create_mode: true }) : undefined }, async (app) => {
    await click(select(app, tag("composer.create-mode")));
    expect(app.getAllByText(/restart zeta serve/)).toHaveLength(1);
    expect(app.getByText(/restart zeta serve/).closest('[role="alert"]')?.hasAttribute("hidden")).toBe(false);
  });
});
