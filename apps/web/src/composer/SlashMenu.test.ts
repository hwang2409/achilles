import "../test-dom";
import { afterEach, expect, test } from "bun:test";
import React, { act } from "react";
import { cleanup, fireEvent, render, renderHook } from "@testing-library/react";
import { createRunStore } from "@fulcrum/core";
import { RunProvider } from "@fulcrum/react";
import type { SlashCommandInfo, ZetaClient } from "@fulcrum/zeta";
import { PlainComposer } from "./PlainComposer";
import { useComposerCommands } from "./ComposerCommands";

afterEach(cleanup);

const row = (name: string, description: string): SlashCommandInfo => ({ name, description, kind: "builtin", source: "builtin", client_only: false, unavailable: null });
const commands = [row("help", "list commands"), row("compact", "compact the context now"), row("status", "show session status")];
let chatSeq = 0;

function mount(slashCommands: readonly SlashCommandInfo[] | null) {
  const ran: { name: string; arg: string }[] = [];
  const sent: string[] = [];
  const { container } = render(React.createElement(RunProvider, { store: createRunStore() }, React.createElement(PlainComposer, {
    state: "idle" as const,
    onSubmit: async (text: string) => { sent.push(text); },
    onDraftChange: () => {},
    onDraftSubmit: () => {},
    onCommand: (command) => { ran.push(command); return true; },
    chatId: `slash-test-${chatSeq++}`,
    defaultValue: "",
    label: "message",
    slashCommands,
  })));
  const field = container.querySelector("textarea")!;
  const type = (value: string) => act(() => { fireEvent.change(field, { target: { value } }); });
  const key = (k: string) => act(() => { fireEvent.keyDown(field, { key: k }); });
  const options = () => [...container.querySelectorAll('[role="listbox"][aria-label="commands"] [role="option"]')];
  const selected = () => container.querySelector('[role="option"][aria-selected="true"]')?.querySelector("span")?.textContent ?? null;
  return { container, field, type, key, options, selected, ran, sent };
}

test("typing / lists the session's commands with their descriptions, and the field points at the chosen one", () => {
  const c = mount(commands);
  c.type("/");
  expect(c.options().map((option) => option.textContent)).toEqual(["/helplist commands", "/compactcompact the context now", "/statusshow session status"]);
  expect(c.field.getAttribute("aria-expanded")).toBe("true");
  expect(c.field.getAttribute("aria-activedescendant")).toBe(c.options()[0]!.id);
  c.type("/st");
  expect(c.options().map((option) => option.querySelector("span")!.textContent)).toEqual(["/status"]);
});

test("arrows, tab, and a click never run a command; enter runs the chosen one", () => {
  const c = mount(commands);
  c.type("/");
  c.key("ArrowDown");
  expect(c.selected()).toBe("/compact");
  c.key("ArrowUp");
  c.key("ArrowUp");
  expect(c.selected()).toBe("/status");
  c.key("Tab");
  expect(c.field.value).toBe("/status ");
  act(() => { fireEvent.change(c.field, { target: { value: "/" } }); });
  act(() => { fireEvent.click(c.options()[1]!); });
  expect(c.field.value).toBe("/compact ");
  // a side-effecting command waits for the user's enter
  expect(c.ran).toEqual([]);
  c.type("/co");
  c.key("Enter");
  expect(c.ran).toEqual([{ name: "compact", arg: "" }]);
  expect(c.sent).toEqual([]);
});

test("escape closes the menu and keeps the draft; typing opens it again", () => {
  const c = mount(commands);
  c.type("/he");
  c.key("Escape");
  expect(c.options()).toEqual([]);
  expect(c.field.value).toBe("/he");
  expect(c.field.hasAttribute("aria-expanded")).toBe(false);
  c.key("Enter");
  // the menu is closed, so enter runs the typed draft, not a menu choice
  expect(c.ran).toEqual([{ name: "he", arg: "" }]);
  c.type("/h");
  expect(c.options()).toHaveLength(1);
});

test("no command list (an older zeta) shows no menu", () => {
  const c = mount(null);
  c.type("/");
  expect(c.options()).toEqual([]);
  expect(c.field.hasAttribute("aria-expanded")).toBe(false);
});

test("a zeta that did not offer slash_list gets no list request and keeps the old refusal", () => {
  const requests: string[] = [];
  const client = { features: ["model_input_ids"], request: async (method: string) => { requests.push(method); return {}; } } as unknown as ZetaClient;
  const { result } = renderHook(() => useComposerCommands(client, { id: "s1", title: "chat" }, true, "/"));
  expect(result.current.slashList).toBeNull();
  act(() => { result.current.run({ name: "help", arg: "" }, null); });
  expect(requests).toEqual([]);
  expect(result.current.output).toEqual({ text: "commands are not available here: /help. use // to send a literal slash.", error: true });
});
