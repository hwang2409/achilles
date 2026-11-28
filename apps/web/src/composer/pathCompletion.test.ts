import "../test-dom";
import { afterEach, expect, test } from "bun:test";
import React, { act } from "react";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { createRunStore } from "@fulcrum/core";
import { RunProvider } from "@fulcrum/react";
import type { PathCompletionEntry, PathCompletionResult } from "@fulcrum/zeta";
import { PlainComposer } from "./PlainComposer";
import { PATH_DEBOUNCE_MS, pathTokenStart, type CompletePaths } from "./pathCompletion";

afterEach(cleanup);

let chatSeq = 0;
const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, PATH_DEBOUNCE_MS + 30)));
const entry = (text: string, startPosition: number, kind: "directory" | "file" = "directory"): PathCompletionEntry => ({ text, display: `@${text}`, kind, startPosition });
const entries = (...rows: PathCompletionEntry[]): PathCompletionResult => ({ kind: "entries", entries: rows, truncated: false });

function mount(completePaths?: CompletePaths) {
  const submitted: string[] = [];
  const result = render(React.createElement(RunProvider, { store: createRunStore() }, React.createElement(PlainComposer, {
    state: "idle" as const,
    onSubmit: async (text: string) => { submitted.push(text); },
    onDraftChange: () => {},
    onDraftSubmit: () => {},
    chatId: `path-test-${chatSeq++}`,
    label: "message",
    completePaths,
  })));
  const field = result.container.querySelector("textarea") as HTMLTextAreaElement;
  const type = (value: string) => act(() => { fireEvent.change(field, { target: { value } }); });
  const key = (name: string, init: KeyboardEventInit = {}) => act(() => { fireEvent.keyDown(field, { key: name, ...init }); });
  const options = () => [...result.container.querySelectorAll('[role="option"]')].map((option) => `${option.getAttribute("aria-selected") === "true" ? ">" : ""}${option.textContent}`);
  return { field, type, key, options, submitted, listbox: () => result.getByRole("listbox", { name: "path completions" }) };
}

test("the token rule matches zeta's: an @ at a word start, quoted or bare, up to the cursor", () => {
  expect(pathTokenStart("see @sr")).toBe(5);
  expect(pathTokenStart("@")).toBe(1);
  expect(pathTokenStart('read @"my fi')).toBe(7);
  expect(pathTokenStart("mail a@b")).toBeNull();
  expect(pathTokenStart("@src done")).toBeNull();
});

test("typing @ asks once after the pause; arrows choose; enter inserts the directory and lists its children", async () => {
  const asked: string[] = [];
  const composer = mount(async (text) => {
    asked.push(text);
    return text.endsWith("src/") ? entries(entry("src/app.ts", -4, "file")) : entries(entry("scripts/", -2), entry("src/", -2));
  });
  await composer.type("see @s");
  await composer.type("see @sr");
  await settle();
  expect(asked).toEqual(["see @sr"]);
  expect(composer.options()).toEqual([">@scripts/", "@src/"]);
  expect(composer.field.getAttribute("aria-activedescendant")).toBe(composer.listbox().children[0].id);
  await composer.key("ArrowDown");
  expect(composer.options()).toEqual(["@scripts/", ">@src/"]);
  await composer.key("Enter");
  expect(composer.field.value).toBe("see @src/");
  expect(composer.field.selectionStart).toBe(9);
  expect(composer.submitted).toEqual([]);
  await settle();
  expect(asked).toEqual(["see @sr", "see @src/"]);
  expect(composer.options()).toEqual([">@src/app.ts"]);
  await composer.key("Tab");
  expect(composer.field.value).toBe("see @src/app.ts");
  expect(composer.options()).toEqual([]);
  expect(composer.field.getAttribute("aria-controls")).toBeNull();
  await composer.key("Enter");
  expect(composer.submitted).toEqual(["see @src/app.ts"]);
});

test("a reply that arrives after a newer edit is dropped", async () => {
  const replies: Array<(result: PathCompletionResult) => void> = [];
  const composer = mount((_text, signal) => new Promise((resolve) => {
    replies.push(resolve);
    // the stale reply still resolves; only the newer one may show
    signal.addEventListener("abort", () => {});
  }));
  await composer.type("@a");
  await settle();
  await composer.type("@b");
  await settle();
  expect(replies.length).toBe(2);
  await act(async () => { replies[1](entries(entry("beta/", -1))); });
  await act(async () => { replies[0](entries(entry("alpha/", -1))); });
  expect(composer.options()).toEqual([">@beta/"]);
});

test("escape closes the list and keeps it closed until the text changes", async () => {
  const asked: string[] = [];
  const composer = mount(async (text) => { asked.push(text); return entries(entry("src/", -1)); });
  await composer.type("@s");
  await settle();
  expect(composer.options()).toEqual([">@src/"]);
  await composer.key("Escape");
  expect(composer.options()).toEqual([]);
  await act(() => { fireEvent.select(composer.field); });
  await settle();
  expect(asked).toEqual(["@s"]);
  await composer.type("@sr");
  await settle();
  expect(composer.options()).toEqual([">@src/"]);
});

test("without path completion (an older zeta, or an observer) nothing asks and enter sends", async () => {
  const composer = mount(undefined);
  await composer.type("@s");
  await settle();
  expect(composer.options()).toEqual([]);
  expect(composer.field.getAttribute("aria-autocomplete")).toBeNull();
  await composer.key("Enter");
  expect(composer.submitted).toEqual(["@s"]);
});
