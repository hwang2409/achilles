import "../test-dom";
import { afterEach, expect, test } from "bun:test";
import React, { act } from "react";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { createRunStore } from "@fulcrum/core";
import { RunProvider } from "@fulcrum/react";
import type { PathCompletionResult, SlashCommandInfo } from "@fulcrum/zeta";
import { PlainComposer } from "./PlainComposer";
import { PATH_DEBOUNCE_MS } from "./pathCompletion";

afterEach(cleanup);

const row = (name: string, description: string): SlashCommandInfo => ({ name, description, kind: "builtin", source: "builtin", client_only: false, unavailable: null });
const paths: PathCompletionResult = { kind: "entries", entries: [{ text: "xs/", display: "@xs/", kind: "directory", startPosition: -1 }], truncated: false };
const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, PATH_DEBOUNCE_MS + 30)));

test("with both lists on, / at the start opens only the slash menu, a later @x opens only the path list, and enter with neither sends", async () => {
  const asked: string[] = [];
  const sent: string[] = [];
  const ran: string[] = [];
  const { container } = render(React.createElement(RunProvider, { store: createRunStore() }, React.createElement(PlainComposer, {
    state: "idle" as const,
    onSubmit: async (text: string) => { sent.push(text); },
    onDraftChange: () => {},
    onDraftSubmit: () => {},
    onCommand: (command) => { ran.push(command.name); return true; },
    chatId: "both-lists",
    label: "message",
    slashCommands: [row("help", "list commands"), row("status", "show session status")],
    completePaths: async (text) => { asked.push(text); return paths; },
  })));
  const field = container.querySelector("textarea")!;
  const type = (value: string) => act(() => { fireEvent.change(field, { target: { value } }); });
  const key = (name: string) => act(() => { fireEvent.keyDown(field, { key: name }); });
  const slashMenu = () => container.querySelector('[role="listbox"][aria-label="commands"]');
  const pathList = () => container.querySelector('[role="listbox"][aria-label="path completions"]');

  await type("/");
  await settle();
  expect(slashMenu()).not.toBeNull();
  expect(pathList()).toBeNull();
  expect(asked).toEqual([]);
  // the field points at the open slash menu, not at the closed path list
  expect(field.getAttribute("aria-controls")).toBe(slashMenu()!.id);
  await key("ArrowDown");
  await key("Enter");
  expect(ran).toEqual(["status"]);
  expect(sent).toEqual([]);

  await type("look at @x");
  await settle();
  expect(slashMenu()).toBeNull();
  expect(pathList()).not.toBeNull();
  expect(field.getAttribute("aria-controls")).toBe(pathList()!.id);
  await key("Enter");
  // enter took the path, not the send
  expect(field.value).toBe("look at @xs/");
  expect(sent).toEqual([]);

  await key("Escape");
  expect(pathList()).toBeNull();
  await key("Enter");
  expect(sent).toEqual(["look at @xs/"]);
  expect(ran).toEqual(["status"]);
});
