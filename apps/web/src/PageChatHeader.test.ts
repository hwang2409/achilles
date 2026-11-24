import "./test-dom";
import { expect, test } from "bun:test";
import { act, createElement } from "react";
import { PageChatCatalog, type Chat } from "./surface/AgentNavAdapter";
import { PageChatHeader } from "./PageChatHeader";

const { fireEvent, render, waitFor } = await import("@testing-library/react");
const row = (id: string, page_id = "page", title = id): Chat => ({ session_id: id, purpose: "chat", page_id, page_route: "/fixture", page_title: "fixture", title, last_state: "approval", created_at: "2026-01-01", updated_at: "2026-01-01" });
const longTitle = "notes on a very long synthetic reading list ".repeat(4).trim();

function setup() {
  const called: string[] = [];
  const value = { chats: [row("recent", "page", longTitle), row("outside", "other"), row("current"), row("older")], loading: false, error: false, next: "cursor" as string | null, reload: () => called.push("reload"), more: () => called.push("more"), clearSearch: () => {}, builds: [], onScreen: () => {} };
  const shell = () => createElement(PageChatCatalog.Provider, { value }, createElement(PageChatHeader, {
    pageId: "page", sessionId: "current", title: "fixture", state: "idle", stateLabel: "idle", onSelect: (chat) => called.push(chat.session_id), newChat: () => {}, approval: { checked: true, action: () => called.push("approval") }, create: { checked: true, action: () => called.push("create") }, close: () => called.push("close"), closeRef: null,
  }));
  const app = render(shell());
  return { app, called, update: (changes: Partial<typeof value>) => { Object.assign(value, changes); app.rerender(shell()); } };
}

test("switcher keeps the shared catalog order and uses its continuation and retry", async () => {
  const { app, called, update } = setup();
  try {
    fireEvent.keyDown(app.getByRole("button", { name: "fixture, 3 chats" }), { key: "Enter" });
    const rows = app.getAllByRole("option");
    expect(rows.map((node) => node.firstElementChild?.textContent)).toEqual([longTitle, "current", "older"]);
    expect(rows[0].firstElementChild?.getAttribute("title")).toBe(longTitle);
    expect(rows[0].textContent).toContain("needs you");
    expect(rows[1].getAttribute("aria-selected")).toBe("true");
    await waitFor(() => expect(document.activeElement === rows[1]).toBe(true));
    fireEvent.keyDown(rows[1], { key: "Home" });
    await waitFor(() => expect(document.activeElement === rows[0]).toBe(true));
    fireEvent.keyDown(rows[0], { key: "End" });
    await waitFor(() => expect(document.activeElement?.textContent).toBe("load older chats"));
    fireEvent.click(document.activeElement!);
    fireEvent.keyDown(document.activeElement!, { key: "ArrowUp" });
    await waitFor(() => expect(document.activeElement === rows[2]).toBe(true));
    fireEvent.click(document.activeElement!);
    expect(called).toEqual(["more", "older"]);
    expect(app.queryByRole("listbox")).toBeNull();
    update({ chats: [], error: true, next: null });
    fireEvent.keyDown(app.getByRole("button", { name: "fixture, 0 chats" }), { key: "Enter" });
    fireEvent.click(app.getByRole("menuitem", { name: "retry" }));
    expect(called.at(-1)).toBe("reload");
    update({ error: false, loading: true });
    expect(app.getByText("loading chats…")).toBeTruthy();
    update({ loading: false });
    expect(app.getByText("no chats for this page · use + to start one")).toBeTruthy();
  } finally { app.unmount(); }
});

test("confirmation and menu consume Escape before the page chat sheet", async () => {
  const { app } = setup();
  const sheetEscape = (event: KeyboardEvent) => { if (event.key === "Escape" && !event.defaultPrevented) escaped++; };
  let escaped = 0;
  window.addEventListener("keydown", sheetEscape);
  try {
    const trigger = app.getByRole("button", { name: "page chat options" });
    fireEvent.keyDown(trigger, { key: "Enter" });
    const item = app.getByRole("menuitemcheckbox", { name: "create mode" });
    fireEvent.click(item);
    const confirm = app.getByRole("button", { name: "confirm" });
    expect(document.activeElement === confirm).toBe(true);
    fireEvent.keyDown(confirm, { key: "Escape" });
    expect(document.activeElement === item).toBe(true);
    fireEvent.keyDown(item, { key: "Escape" });
    await waitFor(() => expect(document.activeElement === trigger).toBe(true));
    expect(escaped).toBe(0);
    act(() => { fireEvent.keyDown(trigger, { key: "Escape" }); });
    expect(escaped).toBe(1);
  } finally { window.removeEventListener("keydown", sheetEscape); app.unmount(); }
});
