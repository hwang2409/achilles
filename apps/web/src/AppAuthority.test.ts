import "./test-dom";
import { expect, test } from "bun:test";
import { act, createElement } from "react";
import type { RenderResult } from "@testing-library/react";

import { isMac } from "./keyboard";
import { draftStore } from "./draftStore";
import { getSettings, SETTINGS_KEY, updateSettings } from "./settings";
import { WRITE_SURFACES, type WriteSurfaceId } from "./writeSurfaces";

const { fireEvent, render } = await import("@testing-library/react");

const chat = { session_id: "session", page_id: "page", page_route: "/", title: "Fixture chat", message_sent: true, titled_by_user: true, last_state: "idle", updated_at: "2026-01-01" };
const page = { id: "page", route: "/", title: "Fixture page", zeta_session_id: null, workspace: "/fixture", create_mode: false, layout: { blocks: [] } };
const reads = new Set(["hello", "status", "session_settings", "session_history_and_subscribe", "session_history", "unsubscribe", "delivery_status", "account_list", "login_status", "skill_catalog", "skill_read", "home_settings_get", "state_settings"]);
const pendingRecord = JSON.stringify([{ sessionId: "session", pageId: "page", mode: "allow", stage: "created" }]);
type Authority = "observer" | "controller";
// `path`: the route to open (default the chats route). `observerBanner: false`: this route shows no observer banner.
// `slot`: like zeta, one controller at a time across every socket (a second controller hello gets -32001); `roles`
// records each hello role.
type Options = { path?: string; observerBanner?: false; sockets?: EventTarget[]; slot?: boolean; roles?: string[]; browserPreference?: keyof ReturnType<typeof getSettings>; unsent?: boolean; pending?: boolean; attached?: boolean; extraChat?: typeof chat; page?: Record<string, unknown>; tool?: object; chat?: object; joined?: object; rpc?: Record<string, (params: Record<string, unknown>, requests: readonly string[]) => object | Promise<object>>; http?: (path: string, method: string) => Response | undefined };

async function withApp(authority: Authority, options: Options, check: (app: RenderResult, writes: string[], requests: string[], emit: (event: object) => void) => Promise<void>) {
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
    constructor() { super(); socket = this; options.sockets?.push(this); queueMicrotask(() => this.dispatchEvent(new Event("open"))); }
    close() { controllers.delete(this); this.dispatchEvent(new Event("close")); }
    send(raw: string) {
      const { id, method, params } = JSON.parse(raw);
      requests.push(method);
      if (!reads.has(method)) writes.push(method);
      if (method === "hello") options.roles?.push(params.role);
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
    updateSettings({ vim: false, size: 15 });
    const { SurfaceRouter } = await import("./surface/SurfaceRouter");
    app = render(createElement(SurfaceRouter));
    await act(async () => {});
    const banner = app.container.querySelector(".observer-banner");
    if (options.observerBanner === false) {
      expect(banner).toBeNull();
    } else if (authority === "observer") {
      expect(banner?.textContent).toContain("live and read-only");
      expect(banner?.getAttribute("hidden")).toBeNull();
    } else {
      expect(banner).toBeNull();
      expect(requests).toContain("hello");
    }
    await check(app, writes, requests, emit);
    if (authority === "observer") {
      expect(writes).toEqual([]);
      const expected = { ...oldSettings, vim: false, size: 15 };
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
    expect(select(app, '[data-part="composer-reason"]').textContent).toContain("read-only");
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
  if (id !== "page-chat.new") await click(select(app, '[aria-label="page chat options"]'));
  const control = select(app, tag(id));
  expect(disabled(control)).toBe(authority === "observer");
  if (authority === "observer") {
    const description = select(app, `#${CSS.escape(control.getAttribute("aria-describedby")!)}`);
    expect(description.textContent).toContain("this tab is read-only");
  }
  await click(control);
  if (authority === "controller") {
    if (id !== "page-chat.new") await click(app.getByRole("button", { name: "confirm", exact: true }));
    didWrite(writes, write);
  }
} });
const userMessage = { id: "message", role: "user", content: [{ type: "text", text: "Fixture history title" }] };
const pendingKey = "achilles-pending-chats";
const sha256 = async (text: string) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
// The skills route with library_read_v1, and library_write_v1 + skill_write when `writes` (each part can be withheld).
// Like zeta, hello lists a controller-write method only to a controller.
const library = (writes: boolean, feature = writes, method = writes): Options => ({ path: "/skills", observerBanner: false, rpc: {
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
const homeSettings: Options = { path: "/settings", observerBanner: false, rpc: {
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

const accountFixture: Options = {
  attached: true,
  joined: { messages: [{ id: "prompt", role: "user", content: [{ type: "text", text: "fixture prompt" }], failed_turn: { code: "auth_error", message: "fixture login failed" } }] },
  rpc: {
    hello: (params) => params.role === "observer"
      ? { result: { protocol_version: "1.2", capabilities: { features: params.features } } }
      : { result: { protocol_version: "1.2", capabilities: { features: params.features, requests: ["account_list", "account_switch", "login_start", "login_status"] } } },
    account_list: () => ({ result: { accounts: [
      { account: "anthropic:default", current: true, available: true },
      { account: "anthropic:personal", current: false, available: true },
    ] } }),
    login_start: (params) => ({ result: params.provider === "claude" ? { state: "succeeded" } : { state: "failed" } }),
  },
};
const recoveryWrite = (id: WriteSurfaceId, request: string): Row => ({ kind: "visible", options: accountFixture, check: async (app, authority, writes, requests) => {
  const card = select(app, ".transcript .chat-auth-error");
  const control = select(app, tag(id));
  expect(disabled(control)).toBe(authority === "observer");
  await click(control);
  if (authority === "observer") {
    expect(card.textContent).toContain("this chat is pinned to its account, which failed to sign in.");
    expect(card.textContent).toContain("read-only");
    expect(card.textContent).not.toContain("anthropic:");
    expect(requests).not.toContain("account_list");
  } else {
    didWrite(writes, request);
    if (id === "auth.login") expect(card.textContent).toContain("logged in. send your message again");
  }
} });

const rows: Record<WriteSurfaceId, Row> = {
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
  "composer.account-switch": { kind: "command", options: accountFixture, check: async (app, authority, writes, requests) => {
    const run = async (text: string) => {
      const field = select(app, '[data-part="composer"] textarea');
      await change(field, text);
      await keydown(field, "Enter");
    };
    if (authority === "observer") {
      expect(select(app, '[data-part="composer-reason"]').textContent).toContain("read-only");
      expect(requests).not.toContain("account_list");
      return;
    }
    await run("/accounts");
    await click(select(app, tag("composer.account-switch")));
    expect(writes.filter((write) => write === "account_switch")).toHaveLength(1);
    await run("/accounts anthropic:personal");
    expect(writes.filter((write) => write === "account_switch")).toHaveLength(2);
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
  "page-chat.auto-approve": dockedWrite("page-chat.auto-approve", "set_settings", { ...docked, rpc: { set_settings: (params) => ({ result: { approval_mode: params.approval_mode } }) } }),
  "page-chat.create-mode": dockedWrite("page-chat.create-mode", "POST /api/pages/page/create-mode"),
  "header.create": button(`${tag("header.create")}`, "POST /api/pages/page/create-mode", { attached: true }),
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
    await click(select(app, '.chat-actions > button:not([data-write-surface]):not(.header-overflow)'));
    const restore = select(app, tag("history.restore"));
    expect(disabled(restore)).toBe(authority === "observer");
    await click(restore);
    if (authority === "controller") {
      await click(select(app, '.history-confirm ' + tag("history.restore")));
      didWrite(writes, "POST /api/pages/page/layout/restore");
    }
  } },
  "record.add": { kind: "local-only", options: records, check: async (app, authority, writes) => {
    const control = app.getByText("add a book", { selector: "button", exact: true });
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
      expect(app.getByText(/another tab had control\. a chat tab keeps it while it is open; try again after it finishes or closes\.$/)).toBeTruthy();
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
      expect(app.getByText(/another tab had control\. a chat tab keeps it while it is open; try again after it finishes or closes\.$/)).toBeTruthy();
      expect(app.container.querySelector(".library-editor")).toBeNull();
      return;
    }
    await change(select(app, ".library-editor textarea"), `${fixtureFile}more\n`);
    await click(app.getByText("save skill", { selector: "button", exact: true }));
    expect(await app.findByText(/^saved fixture-skill to home · skills\. running sessions pick up the change at their next catalog refresh\.$/)).toBeTruthy();
    didWrite(writes, "skill_write");
  } },
  "settings.telemetry": { kind: "visible", options: homeSettings, check: async (app, authority, writes) => {
    // the settings place browses as an observer; confirming the change borrows control for the one update.
    await click(await app.findByText("turn on telemetry", { selector: tag("settings.telemetry") }));
    const dialog = await app.findByRole("dialog", { name: "turn on telemetry" });
    await click(app.getByRole("checkbox", { name: "i understand this applies to every zeta on this computer" }));
    await click(dialog.querySelector<HTMLElement>(".confirmation-primary")!);
    if (authority === "observer") {
      expect((await app.findByRole("alert")).textContent).toBe("not changed. another tab has control; a chat tab keeps it while it is open. try again after it finishes or closes.");
      return;
    }
    // the time is its own element: match the receipt's whole text
    expect(await app.findByText((_, node) => node?.tagName === "P" && /^at .+: telemetry is on\. if zeta\[otel\] is not installed, turn it off here before you restart zeta\.$/.test(node.textContent ?? ""))).toBeTruthy();
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
  "page.chat": { kind: "visible", absent: true, options: { ...records, attached: true }, check: async (app, authority, writes) => {
    const ask = app.queryByText("ask the chat", { selector: "button", exact: true });
    expect(Boolean(ask)).toBe(authority === "controller");
    if (!ask) { await keydown(select(app, '[data-part="composer"]'), "Enter"); return; }
    await click(ask);
    const field = select(app, "textarea") as HTMLTextAreaElement;
    expect(field.value).toContain("add a book");
    await act(async () => { fireEvent.submit(field.closest("form")!); });
    didWrite(writes, "send");
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
  ["no library_write_v1", library(true, false, true), false, false],
  ["the controller lacks skill_write", library(true, true, false), true, false],
  ["neither", library(false), false, false],
  ["both", library(true), true, true],
] as const)("library create control renders only with the write capability: %s", async (_name, options, observer, controller) => {
  await withApp("controller", options, async (app, writes) => {
    await app.findByText("no skills found");
    // an observer hello never lists write methods, so the observer view depends on the feature alone.
    expect(Boolean(app.container.querySelector(tag("library.create")))).toBe(observer);
    if (observer) await click(select(app, tag("library.create")));
    // after take control the form opens; without the write method it is read-only, says why, and has no save.
    expect(Boolean(app.container.querySelector(".library-editor"))).toBe(observer);
    if (observer) {
      expect(Boolean(app.queryByText(/^save/, { selector: "button" }))).toBe(controller);
      expect(Boolean(app.queryByText("this zeta does not allow saving here. your text is kept; nothing was sent."))).toBe(!controller);
      expect((select(app, ".library-editor textarea") as HTMLTextAreaElement).readOnly).toBe(!controller);
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
    sockets[0]!.close(); // the observer drops while the controller handshake is in flight
    return { error: { code: -32001, message: "controller occupied" } };
  } } };
  await withApp("observer", options, async (app) => {
    await app.findByText("no skills found");
    await click(select(app, tag("library.create")));
    expect(await app.findByText(/another tab had control\. a chat tab keeps it while it is open; try again after it finishes or closes\.$/, {}, { timeout: 3_000 })).toBeTruthy();
    expect(await app.findByText("no skills found", {}, { timeout: 3_000 })).toBeTruthy();
    expect(app.getByText(/another tab had control\. a chat tab keeps it while it is open; try again after it finishes or closes\.$/)).toBeTruthy();
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

// A second tab asking zeta for the controller slot: the hello reply says whether it got it.
const chatTabHello = () => new Promise<{ result?: object; error?: { code: number } }>((resolve) => {
  const tab = new WebSocket("ws://fixture.invalid");
  tab.addEventListener("message", (event) => { resolve(JSON.parse((event as MessageEvent).data)); tab.close(); });
  tab.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "hello", params: { role: "controller", features: [] } }));
});

test.each([
  ["create + save", library(true), async (app: RenderResult) => {
    await app.findByText("no skills found");
    await click(select(app, tag("library.create")));
    expect((await chatTabHello()).error?.code).toBe(-32001); // the library tab holds the slot while its editor is open
    await change(select(app, '.library-editor input[aria-describedby$="-rules"]'), "fixture-skill");
    await change(app.getByLabelText("description") as HTMLElement, "synthetic skill");
    await click(app.getByText("save skill", { selector: "button", exact: true }));
    await app.findByText(/^saved fixture-skill to home · skills\/fixture-skill\.md\. running sessions/);
  }],
  ["edit + save + close", libraryFile, async (app: RenderResult) => {
    await click(await app.findByRole("button", { name: /fixture-skill/ }));
    await click(app.getByText("show skill text", { selector: "button", exact: true }));
    await click(await app.findByText("edit", { selector: tag("library.edit"), exact: true }));
    expect((await chatTabHello()).error?.code).toBe(-32001);
    await change(select(app, ".library-editor textarea"), `${fixtureFile}more\n`);
    await click(app.getByText("save skill", { selector: "button", exact: true }));
    await app.findByText(/^saved fixture-skill/);
    await click(app.getByText("close", { selector: ".library-editor button", exact: true }));
  }],
] as const)("a library tab gives control back after %s, so a chat tab can then take control", async (_name, options, write) => {
  const roles: string[] = [];
  await withApp("controller", { ...options, slot: true, roles }, async (app, writes) => {
    await write(app);
    didWrite(writes, "skill_write");
    await act(async () => {});
    expect((await chatTabHello()).result, `hello roles ${JSON.stringify(roles)}`).toBeTruthy();
    expect(roles).toEqual(["observer", "controller", "controller", "observer", "controller"]);
  });
});

test("a library tab reconnects as observer once its editor closed, and as controller while one is open", async () => {
  const roles: string[] = [];
  const sockets: (EventTarget & { close(): void })[] = [];
  await withApp("controller", { ...library(true), slot: true, roles, sockets: sockets as EventTarget[] }, async (app) => {
    await app.findByText("no skills found");
    await click(select(app, tag("library.create")));
    await change(select(app, '.library-editor input[aria-describedby$="-rules"]'), "fixture-draft");
    await act(async () => { sockets.at(-1)!.close(); });
    expect(await app.findByDisplayValue("fixture-draft", {}, { timeout: 3_000 })).toBeTruthy();
    expect(roles.at(-1)).toBe("controller");
    await click(app.getByText("discard", { selector: "button", exact: true }));
    await click(app.getByText("discard changes", { selector: "button", exact: true }));
    await act(async () => {});
    await act(async () => { sockets.at(-1)!.close(); });
    expect(await app.findByText("no skills found", {}, { timeout: 3_000 })).toBeTruthy();
    await act(async () => {});
    expect(roles).toEqual(["observer", "controller", "controller", "observer", "observer"]);
  });
});

const requestApprovalChange = async (app: RenderResult) => {
  await click(select(app, '[aria-label="page chat options"]'));
  await click(select(app, tag("page-chat.auto-approve")));
  await click(app.getByRole("button", { name: "confirm", exact: true }));
};

test("a stale telemetry change whose reread shows it on elsewhere keeps the reason and focuses the row control", async () => {
  // the file was turned on elsewhere: the update is stale, and the reread finds telemetry on at a new revision
  const turnedOn = { result: { revision: `sha256:${"c".repeat(64)}`, settings: { telemetry: { enabled: true, source: "builtin", editable: true } }, settings_malformed: false } };
  const options: Options = { ...homeSettings, rpc: { ...homeSettings.rpc,
    home_settings_get: (params, requests) => requests.includes("home_settings_update") ? turnedOn : homeSettings.rpc!.home_settings_get!(params, requests),
    home_settings_update: () => ({ error: { code: -32009, message: "settings.toml changed since the given revision", data: { code: "stale_revision" } } }),
  } };
  await withApp("controller", options, async (app, writes) => {
    await click(await app.findByText("turn on telemetry", { selector: tag("settings.telemetry") }));
    const dialog = await app.findByRole("dialog", { name: "turn on telemetry" });
    await click(app.getByRole("checkbox", { name: "i understand this applies to every zeta on this computer" }));
    await click(dialog.querySelector<HTMLElement>(".confirmation-primary")!);
    const turnOff = await app.findByText("turn off", { selector: tag("settings.telemetry") });
    // compare markup: a failing element diff crashes bun
    expect(document.activeElement?.outerHTML).toBe(turnOff.outerHTML);
    expect(app.getByText("not changed. the state changed elsewhere; the row now shows the current state.")).toBeTruthy();
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
    expect(select(app, tag("page-chat.auto-approve")).getAttribute("aria-checked")).toBe("true");
    busy = false;
    await act(async () => { emit({ jsonrpc: "2.0", method: "event", params: { event: "agent_end", session_id: "session" } }); });
    expect(writes).toContain("set_settings");
    expect(select(app, tag("page-chat.auto-approve")).getAttribute("aria-checked")).toBe("false");
    expect(app.getByText(/ask before running tools · saved/)).toBeTruthy();
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
      expect(select(app, tag("page-chat.auto-approve")).getAttribute("aria-checked")).toBe("true");
      await click(select(app, tag("page-chat.auto-approve")));
      await click(app.getByRole("button", { name: "confirm", exact: true }));
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
