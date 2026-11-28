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

function mount(completePaths?: CompletePaths, draft?: string) {
  const submitted: string[] = [];
  const store = createRunStore();
  const composer = (chatId: string, complete?: CompletePaths, defaultValue = draft) => React.createElement(RunProvider, { store }, React.createElement(PlainComposer, {
    state: "idle" as const,
    onSubmit: async (text: string) => { submitted.push(text); },
    onDraftChange: () => {},
    onDraftSubmit: () => {},
    chatId,
    label: "message",
    completePaths: complete,
    defaultValue,
  }));
  const chat = `path-test-${chatSeq++}`;
  const result = render(composer(chat, completePaths));
  const field = result.container.querySelector("textarea") as HTMLTextAreaElement;
  /** what the app does when another window edits this chat's draft */
  const remoteDraft = (value: string) => act(() => { result.rerender(composer(chat, completePaths, value)); });
  /** what the app does on a chat switch: a new chat id and a new completer bound to it */
  const switchChat = (complete?: CompletePaths) => act(() => { result.rerender(composer(`path-test-${chatSeq++}`, complete)); });
  const type = (value: string) => act(() => { fireEvent.change(field, { target: { value } }); });
  const key = (name: string, init: KeyboardEventInit = {}) => act(() => { fireEvent.keyDown(field, { key: name, ...init }); });
  const options = () => [...result.container.querySelectorAll('[role="option"]')].map((option) => `${option.getAttribute("aria-selected") === "true" ? ">" : ""}${option.textContent}`);
  return { field, type, key, options, submitted, switchChat, remoteDraft, unmount: result.unmount, listbox: () => result.getByRole("listbox", { name: "path completions" }) };
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
  await act(() => { fireEvent.keyUp(composer.field, { key: "ArrowLeft" }); });
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

test("a send before the pause ends asks nothing and shows no list over the empty composer", async () => {
  const asked: string[] = [];
  const composer = mount(async (text) => { asked.push(text); return entries(entry("src/", -1)); });
  await composer.type("@s");
  await composer.key("Enter");
  expect(composer.submitted).toEqual(["@s"]);
  await settle();
  expect(composer.field.value).toBe("");
  expect(composer.options()).toEqual([]);
  expect(asked).toEqual([]);
});

test("editing the same token keeps only the entries that still match, and enter sends when none do", async () => {
  const replies: Array<(result: PathCompletionResult) => void> = [];
  const composer = mount(() => new Promise((resolve) => { replies.push(resolve); }));
  await composer.type("@s");
  await settle();
  await act(async () => { replies[0](entries(entry("scripts/", -1), entry("src/", -1), entry('"stuff dir/', -1))); });
  expect(composer.options()).toEqual([">@scripts/", "@src/", '@"stuff dir/']);
  // a path with a space comes back quoted; it still matches the bare token
  await composer.type("@st");
  expect(composer.options()).toEqual(['>@"stuff dir/']);
  await composer.type("@sx");
  expect(composer.options()).toEqual([]);
  await composer.key("Enter");
  expect(composer.field.value).toBe("");
  expect(composer.submitted).toEqual(["@sx"]);
  await composer.type("@s");
  await settle();
  await act(async () => { replies[1](entries(entry("scripts/", -1), entry("src/", -1))); });
  // a fast enter before the reply for the new text takes the entry that still matches
  await composer.type("@sr");
  expect(composer.options()).toEqual([">@src/"]);
  await composer.key("Enter");
  expect(composer.field.value).toBe("@src/");
});

test("a quoted path inserts after the quote and keeps the text after the caret", async () => {
  const asked: string[] = [];
  const composer = mount(async (text) => { asked.push(text); return entries(entry("my file.txt\"", -5, "file")); });
  await act(() => {
    fireEvent.change(composer.field, { target: { value: 'read @"my fi now' } });
    composer.field.setSelectionRange(12, 12);
    fireEvent.keyUp(composer.field, { key: "ArrowLeft" });
  });
  await settle();
  expect(asked.at(-1)).toBe('read @"my fi');
  expect(composer.options()).toEqual(['>@my file.txt"']);
  await composer.key("Enter");
  expect(composer.field.value).toBe('read @"my file.txt" now');
  expect(composer.field.selectionStart).toBe(19);
  expect(composer.options()).toEqual([]);
  expect(composer.submitted).toEqual([]);
});

const asking = () => {
  const asked: string[] = [];
  const complete: CompletePaths = async (text) => { asked.push(text); return entries(entry("src/", -1)); };
  return { asked, complete };
};

test("a chat switch inside the pause asks nothing and shows no list", async () => {
  const { asked, complete } = asking();
  const composer = mount(complete);
  await composer.type("@s");
  // the app binds a new completer to each chat
  await composer.switchChat((text, signal) => complete(text, signal));
  await settle();
  expect(asked).toEqual([]);
  expect(composer.options()).toEqual([]);
});

test("an unmount inside the pause asks nothing", async () => {
  const { asked, complete } = asking();
  const composer = mount(complete);
  await composer.type("@s");
  composer.unmount();
  await settle();
  expect(asked).toEqual([]);
});

test("a restored draft that ends in an @ token asks nothing and shows no list, so enter sends it", async () => {
  const asked: string[] = [];
  const composer = mount(async (text) => { asked.push(text); return entries(entry("src/", -1)); }, "look @s");
  // what the app does after a chat switch or a reload: focus the field, which a browser reports as a selection change
  await act(() => { composer.field.focus(); document.dispatchEvent(new Event("selectionchange")); });
  await settle();
  expect(asked).toEqual([]);
  expect(composer.options()).toEqual([]);
  await composer.key("Enter");
  expect(composer.submitted).toEqual(["look @s"]);
});

test("a remote draft edit asks nothing and closes a list shown for the old text", async () => {
  const asked: string[] = [];
  const composer = mount(async (text) => { asked.push(text); return entries(entry("src/", -1)); });
  await composer.type("@s");
  await settle();
  expect(composer.options()).toEqual([">@src/"]);
  await composer.remoteDraft("hi @s");
  await settle();
  expect(asked).toEqual(["@s"]);
  expect(composer.options()).toEqual([]);
  // the user's own caret move in the new text may open a list again
  await composer.key("ArrowLeft");
  await act(() => { fireEvent.keyUp(composer.field, { key: "ArrowLeft" }); });
  await settle();
  expect(asked).toEqual(["@s", "hi @s"]);
});

test("a caret move with no keyup or mouseup (a touch trackpad, selection handles) closes a list it left; a focus from code opens none", async () => {
  const asked: string[] = [];
  const composer = mount(async (text) => { asked.push(text); return entries(entry("src/", -1)); });
  await act(() => { composer.field.focus(); });
  await composer.type("look @s");
  await settle();
  expect(composer.options()).toEqual([">@src/"]);
  await act(() => { composer.field.setSelectionRange(2, 2); document.dispatchEvent(new Event("selectionchange")); });
  expect(composer.options()).toEqual([]);
  await act(() => { composer.field.blur(); composer.field.setSelectionRange(7, 7); composer.field.focus(); document.dispatchEvent(new Event("selectionchange")); });
  await settle();
  expect(asked).toEqual(["look @s"]);
  expect(composer.options()).toEqual([]);
});

test("a click in the field is a caret move: a restored draft's @ token then lists", async () => {
  const asked: string[] = [];
  const composer = mount(async (text) => { asked.push(text); return entries(entry("src/", -1)); }, "look @s");
  await settle();
  expect(asked).toEqual([]);
  await act(() => { composer.field.setSelectionRange(7, 7); fireEvent.mouseUp(composer.field); });
  await settle();
  expect(asked).toEqual(["look @s"]);
  expect(composer.options()).toEqual([">@src/"]);
});
