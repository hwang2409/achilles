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
const reads = new Set(["hello", "status", "session_settings", "session_history_and_subscribe", "session_history", "unsubscribe", "delivery_status"]);
const pendingRecord = JSON.stringify([{ sessionId: "session", pageId: "page", mode: "allow", stage: "created" }]);
type Authority = "observer" | "controller";
type Options = { unsent?: boolean; pending?: boolean; attached?: boolean; page?: Record<string, unknown>; tool?: object; chat?: object; joined?: object; rpc?: Record<string, (params: Record<string, unknown>, requests: readonly string[]) => object>; http?: (path: string, method: string) => Response | undefined };

async function withApp(authority: Authority, options: Options, check: (app: RenderResult, writes: string[], requests: string[]) => Promise<void>) {
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
  let app: RenderResult | undefined;
  class Socket extends EventTarget {
    constructor() { super(); queueMicrotask(() => this.dispatchEvent(new Event("open"))); }
    close() { this.dispatchEvent(new Event("close")); }
    send(raw: string) {
      const { id, method, params } = JSON.parse(raw);
      requests.push(method);
      if (!reads.has(method)) writes.push(method);
      const custom = options.rpc?.[method]?.(params, requests);
      const response = custom ?? (method === "hello" && authority === "observer" && params.role === "controller"
        ? { error: { code: -32001, message: "controller occupied" } }
        : { result: ({
          hello: { protocol_version: "1.2", capabilities: { features: params.features } },
          new_session: { session: { session_id: "session" } },
          resume: { session: { session_id: "session" } },
          session_settings: { approval_mode: "allow" }, status,
          send: { accepted: true }, steer: { accepted: true }, delivery_status: { status: "delivered" },
          session_history_and_subscribe: { messages: [], next_before: null, status, ...options.joined },
        } as Record<string, unknown>)[method] ?? {} });
      queueMicrotask(() => this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ jsonrpc: "2.0", id, ...response }) })));
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
    (window as unknown as { happyDOM: { setURL(url: string): void } }).happyDOM.setURL(`http://fixture.invalid/${options.attached ? "?chat=session" : ""}`);
    updateSettings({ vim: false, size: 15 });
    const { App } = await import("./App");
    app = render(createElement(App));
    await act(async () => {});
    const banner = app.container.querySelector(".observer-banner");
    if (authority === "observer") {
      expect(banner?.textContent).toContain("live and read-only");
      expect(banner?.getAttribute("hidden")).toBeNull();
    } else {
      expect(banner).toBeNull();
      expect(requests).toContain("hello");
    }
    await check(app, writes, requests);
    if (authority === "observer") {
      expect(writes).toEqual([]);
      expect(localStorage.getItem(SETTINGS_KEY)).toBe(JSON.stringify({ ...oldSettings, vim: false, size: 15 }));
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
const setting = (id: WriteSurfaceId, key: keyof ReturnType<typeof getSettings>, child = ""): Row => ({ kind: "visible", check: async (app, authority) => {
  await click(select(app, ".settings-button"));
  const control = select(app, tag(id) + child);
  const before = getSettings()[key];
  expect(disabled(control)).toBe(authority === "observer");
  await click(control);
  if (authority === "controller") {
    expect(getSettings()[key]).not.toBe(before);
    expect(JSON.parse(localStorage.getItem(SETTINGS_KEY)!)[key]).toBe(getSettings()[key]);
  }
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
const userMessage = { id: "message", role: "user", content: [{ type: "text", text: "Fixture history title" }] };
const pendingKey = "achilles-pending-chats";
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

  "settings.theme": setting("settings.theme", "theme", ' button[aria-selected="false"]'),
  "settings.ui-font": setting("settings.ui-font", "uiFont", ' button[aria-pressed="false"]'),
  "settings.code-font": setting("settings.code-font", "codeFont", ' button[aria-pressed="false"]'),
  "settings.size": setting("settings.size", "size", ' button[aria-pressed="false"]'),
  "settings.density": setting("settings.density", "density", ' button[aria-pressed="false"]'),
  "settings.vim": setting("settings.vim", "vim"),
  "settings.auto-approve": setting("settings.auto-approve", "autoApproveDefault"),
  "settings.reset": setting("settings.reset", "size"),
  "shell.new-chat": button(tag("shell.new-chat"), "new_session"),
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
  "palette.commands": { kind: "command", absent: true, check: async (app, authority) => {
    await click(select(app, ".palette-button"));
    const option = app.queryByText("toggle vim mode", { exact: true });
    if (authority === "observer") {
      expect(Boolean(option)).toBe(false);
      const search = select(app, ".command-palette input");
      await change(search, "toggle vim mode");
      await keydown(search, "Enter");
    }
    else {
      await click(option!);
      expect(getSettings().vim).toBe(true);
      expect(JSON.parse(localStorage.getItem(SETTINGS_KEY)!).vim).toBe(true);
    }
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
