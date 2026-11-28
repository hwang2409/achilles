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
  const { result } = renderHook(() => useComposerCommands(client, { id: "s1", title: "chat" }, true, "/", () => {}));
  expect(result.current.slashList).toBeNull();
  act(() => { result.current.run({ name: "help", arg: "" }, null, "/help"); });
  expect(requests).toEqual([]);
  expect(result.current.output).toEqual({ text: "commands are not available here: /help. use // to send a literal slash.", error: true });
});

test("enter on an exact name runs that name, even when a longer name that starts with it is listed first", () => {
  const c = mount([row("project-instructions", "edit AGENTS.md"), row("project", "show the project")]);
  c.type("/project");
  expect(c.selected()).toBe("/project");
  c.key("Enter");
  expect(c.ran).toEqual([{ name: "project", arg: "" }]);
});

type Reply = unknown | Error;
function slashHook(replies: Record<string, Reply[]>, features = ["model_input_ids"]) {
  const calls: [string, unknown][] = [];
  const restored: string[] = [];
  const client = {
    features,
    request: async (method: string, params: unknown) => {
      calls.push([method, params]);
      const reply = replies[method]?.shift();
      if (reply instanceof Error) throw reply;
      return reply;
    },
  } as unknown as ZetaClient;
  const hook = renderHook(({ draft }) => useComposerCommands(client, { id: "s1", title: "chat" }, true, draft, (text) => restored.push(text), () => true), { initialProps: { draft: "" } });
  const run = async (draft: string) => {
    const parsed = /^\/(\S+)\s*([\s\S]*)$/.exec(draft)!;
    await act(async () => { hook.result.current.run({ name: parsed[1]!, arg: parsed[2]!.trim() }, null, draft); });
  };
  return { hook, calls, restored, run, slashRuns: () => calls.filter(([method]) => method === "slash_run") };
}

const long = "/review  look at the parser,\n  then the tests ";

test.each([
  ["a busy refusal (a turn is running)", [new Error("a turn is already running")], "a turn is already running"],
  ["an error reply", [{ kind: "error", text: "no such model" }], "no such model"],
  ["a terminal-only command", [{ kind: "client_only", name: "review" }], "/review look at the parser,\n  then the tests runs only in the zeta terminal."],
  ["an unknown command", [{ kind: "unknown", name: "review" }], "/review look at the parser,\n  then the tests is not a command. use // to send it as a message."],
  ["a reply the page cannot read", [{ kind: "later" }], "zeta sent a reply this page cannot read."],
])("%s shows the reason and gives back the exact draft", async (_name, reply, text) => {
  const h = slashHook({ slash_run: reply });
  await h.run(long);
  expect(h.slashRuns()).toEqual([["slash_run", { session_id: "s1", text: "/review look at the parser,\n  then the tests" }]]);
  expect(h.hook.result.current.output).toEqual({ text, error: true });
  expect(h.restored).toEqual([long]);
});

test("output shows the text and keeps the draft cleared", async () => {
  const h = slashHook({ slash_run: [{ kind: "output", text: "built-in commands:" }] });
  await h.run("/help");
  expect(h.hook.result.current.output).toEqual({ text: "built-in commands:", command: true });
  expect(h.restored).toEqual([]);
});

test("model input goes out once by its id and keeps the draft cleared; a refused send gives the draft back", async () => {
  const sent = slashHook({ slash_run: [{ kind: "model_input", input_id: "in-1", display_text: "/review x" }], send: [{ accepted: true, session_id: "s1" }] });
  await sent.run("/review x");
  expect(sent.calls.filter(([method]) => method === "send")).toEqual([["send", { session_id: "s1", input_id: "in-1" }]]);
  expect(sent.hook.result.current.output).toBeNull();
  expect(sent.restored).toEqual([]);

  const refused = slashHook({ slash_run: [{ kind: "model_input", input_id: "in-2", display_text: "/review y" }], send: [{}] });
  await refused.run("/review y");
  expect(refused.hook.result.current.output).toEqual({ text: "zeta did not accept the command's message.", error: true });
  expect(refused.restored).toEqual(["/review y"]);
});

test("a zeta without model input ids shows no menu and sends no request", async () => {
  const h = slashHook({}, []);
  h.hook.rerender({ draft: "/" });
  expect(h.hook.result.current.slashList).toBeNull();
  act(() => { h.hook.result.current.run({ name: "help", arg: "" }, null, "/help"); });
  expect(h.calls).toEqual([]);
  expect(h.hook.result.current.output).toEqual({ text: "commands are not available here: /help. use // to send a literal slash.", error: true });
});

test("a failed command list is read again on the next /", async () => {
  const h = slashHook({ slash_list: [new Error("socket closed"), { commands: [row("help", "list commands")] }] });
  await act(async () => { h.hook.rerender({ draft: "/" }); });
  expect(h.hook.result.current.slashList).toEqual([]);
  await act(async () => { h.hook.rerender({ draft: "/h" }); });
  expect(h.calls.filter(([method]) => method === "slash_list")).toHaveLength(1);
  await act(async () => { h.hook.rerender({ draft: "" }); });
  await act(async () => { h.hook.rerender({ draft: "/" }); });
  expect(h.calls.filter(([method]) => method === "slash_list")).toHaveLength(2);
  expect(h.hook.result.current.slashList?.map((command) => command.name)).toEqual(["help"]);
});

test("a refused command's restored draft opens no menu, so the reason stays visible; a caret move or typing opens it again", async () => {
  const client = { features: ["model_input_ids"], request: async (method: string) => {
    if (method === "slash_list") return { commands };
    throw new Error("a turn is already running");
  } } as unknown as ZetaClient;
  function Composer() {
    const [draft, setDraft] = React.useState("");
    const commands = useComposerCommands(client, { id: "s1", title: "chat" }, true, draft, setDraft, () => true);
    return React.createElement(PlainComposer, {
      state: "idle", label: "message", chatId: `slash-test-${chatSeq++}`, defaultValue: draft,
      onSubmit: async () => {}, onDraftChange: setDraft, onDraftSubmit: () => {},
      onCommand: (command, text) => commands.run(command, null, text),
      commandOutput: commands.output && React.createElement("p", { role: "alert" }, commands.output.text),
      slashCommands: commands.slashList,
    });
  }
  const view = render(React.createElement(RunProvider, { store: createRunStore() }, React.createElement(Composer)));
  const field = view.getByLabelText("message", { selector: "textarea" }) as HTMLTextAreaElement;
  const options = () => view.container.querySelectorAll('[role="listbox"][aria-label="commands"] [role="option"]').length;
  await act(async () => { fireEvent.change(field, { target: { value: "/status" } }); await new Promise((resolve) => setTimeout(resolve, 0)); });
  expect(options()).toBe(1);
  await act(async () => { fireEvent.keyDown(field, { key: "Enter" }); await new Promise((resolve) => setTimeout(resolve, 0)); });
  expect(field.value).toBe("/status");
  expect(options()).toBe(0);
  expect(view.container.querySelector('p[role="alert"]')?.textContent).toBe("a turn is already running");
  // the enter keyup after the restore is not a caret move
  await act(() => { fireEvent.keyUp(field, { key: "Enter" }); });
  expect(options()).toBe(0);
  await act(() => { fireEvent.keyUp(field, { key: "ArrowLeft" }); });
  expect(options()).toBe(1);
  await act(() => { fireEvent.keyDown(field, { key: "Escape" }); fireEvent.keyUp(field, { key: "Escape" }); });
  expect(options()).toBe(0);
  await act(() => { fireEvent.mouseUp(field); });
  expect(options()).toBe(1);
});
