import "../test-dom";
import { createElement, act } from "react";
import { afterEach, expect, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { createRunStore, type TextSourceSnapshot } from "@fulcrum/core";
import { RunProvider, type ToolItem } from "@fulcrum/react";
import { CompactTool } from "./CompactTool";

afterEach(cleanup);

test.each(["retention cut", "protocol truncation"] as const)("compact tool result shows its %s notice", async (kind) => {
  const cut = kind === "retention cut";
  const source: TextSourceSnapshot = {
    version: 1, length: cut ? 110 : 4, bytes: cut ? 110 : 4, lines: 1, retainedBytes: cut ? 8 : 4,
    omission: cut ? { kind: "omitted", reason: "item-cap", start: 4, end: 106, bytes: 102, whole: false } : null,
    protocolTruncated: !cut,
    *chunks() { yield { start: 0, line: 0, text: "head" }; if (cut) yield { start: 106, line: 0, text: "tail" }; },
  };
  const item: ToolItem = {
    id: "tool", type: "tool", version: 1, tool_call: { id: "call", name: "read", arguments: {} },
    active: false, is_error: false, canceled: false,
    output: { ...source, omission: null, protocolTruncated: false, *chunks() {} },
    result: { tool_call_id: "call", is_error: false, relation: "same", blocks: [{ metadata: { type: "reasoning" }, text: source }] },
  };
  const store = { ...createRunStore(), getItem: () => item };
  const { container } = render(createElement(RunProvider, { store }, createElement(CompactTool, { id: "tool" })));
  fireEvent.click(container.querySelector('[data-part="tool-header"]')!);
  const reasoning = container.querySelector<HTMLDetailsElement>('[data-part="reasoning"]')!;
  await act(async () => { reasoning.open = true; fireEvent(reasoning, new Event("toggle")); });
  await waitFor(() => expect(container.querySelector('[data-part="reasoning-body"]')?.textContent).toBe(
    cut ? "head\n102 bytes not kept\ntail" : "head\nhost did not provide the complete output",
  ));
});
