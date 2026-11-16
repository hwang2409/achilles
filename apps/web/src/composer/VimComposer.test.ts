import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import React from "react";
import { cleanup, render } from "@testing-library/react";
import { createRunStore } from "@fulcrum/core";
import { RunProvider } from "@fulcrum/react";
import { VimComposer } from "./VimComposer";

GlobalRegistrator.register();
afterAll(() => GlobalRegistrator.unregister());
beforeAll(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(cleanup);

let chatSeq = 0;

async function mountComposer(defaultValue: string) {
  let draft = defaultValue;
  const store = createRunStore();
  let container!: HTMLElement;
  await act(async () => {
    const result = render(
      React.createElement(RunProvider, { store }, React.createElement(VimComposer, {
        state: "idle" as const,
        onSubmit: async () => {},
        onDraftChange: (text: string) => { draft = text; },
        onDraftSubmit: () => {},
        chatId: `vim-test-${chatSeq++}`,
        defaultValue,
        label: "message",
      })),
    );
    container = result.container;
    await Promise.resolve();
  });
  const content = container.querySelector(".cm-content") as HTMLElement;
  const field = container.querySelector('[data-part="composer-field"]') as HTMLElement;
  const key = (k: string) => content.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
  const send = async (keys: string[]) => { await act(async () => { for (const k of keys) key(k); await Promise.resolve(); }); };
  return { container, content, field, send, draft: () => draft };
}

// each row is blocked on base 20666eb (the normal-mode allow-list drops the key, or undo has no history()),
// so the key changes nothing there; the inverted deny-list lets codemirror-vim run it.
const matrix: Array<{ name: string; doc: string; keys: string[]; expected: string }> = [
  { name: "r replaces the char under the cursor", doc: "hello", keys: ["Escape", "0", "r", "Z"], expected: "Zello" },
  { name: "~ toggles case", doc: "hello", keys: ["Escape", "0", "~"], expected: "Hello" },
  { name: "J joins lines", doc: "foo\nbar", keys: ["Escape", "g", "g", "J"], expected: "foo bar" },
  { name: 'di" deletes inside quotes', doc: 'x"hi"', keys: ["Escape", "0", "d", "i", '"'], expected: 'x""' },
  { name: ". repeats the last change", doc: "aaaa", keys: ["Escape", "0", "x", "."], expected: "aa" },
  { name: "u undoes the last edit", doc: "hello", keys: ["Escape", "0", "x", "u"], expected: "hello" },
];

test.each(matrix)("normal-mode key: $name", async ({ doc, keys, expected }) => {
  const composer = await mountComposer(doc);
  await composer.send(keys);
  expect(composer.draft()).toBe(expected);
});

test("typing : in normal mode shows the ex-off note and keeps the draft", async () => {
  const composer = await mountComposer("hello");
  await composer.send(["Escape", ":"]);
  expect(composer.draft()).toBe("hello");
  const hint = composer.container.querySelector('[data-part="composer-hint"]') as HTMLElement;
  expect(hint.textContent).toContain("ex commands are off");
});

test("blurred j/k scroll the real transcript scroller, not the .transcript section", async () => {
  const transcript = document.createElement("section");
  transcript.className = "transcript";
  const scroller = document.createElement("div");
  scroller.setAttribute("data-part", "timeline-scroll");
  transcript.appendChild(scroller);
  document.body.appendChild(transcript);
  const transcriptCalls: number[] = [];
  const scrollerCalls: number[] = [];
  (transcript as unknown as { scrollBy: (o: { top: number }) => void }).scrollBy = (o) => transcriptCalls.push(o.top);
  (scroller as unknown as { scrollBy: (o: { top: number }) => void }).scrollBy = (o) => scrollerCalls.push(o.top);

  const composer = await mountComposer("hello");
  await act(async () => { composer.content.dispatchEvent(new FocusEvent("blur", { bubbles: true })); await Promise.resolve(); });
  await act(async () => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "j", bubbles: true, cancelable: true }));
    await Promise.resolve();
  });

  expect(scrollerCalls).toEqual([96]);
  expect(transcriptCalls).toEqual([]);
  document.body.removeChild(transcript);
});
