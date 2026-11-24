import "../test-dom";
import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import React from "react";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { displayPath, formatToolArguments, summarizeToolOutput, ToolSummaryBody, toolArgumentSummary } from "./ToolSummary";
import { RunProvider, type ToolBodyProps, type ToolItem } from "@fulcrum/react";
import { createRunStore } from "@fulcrum/core";
import { CompactTool } from "./CompactTool";

const output = (text: string, extra: Partial<ToolBodyProps["output"]> = {}): ToolBodyProps["output"] => ({
  version: 1, length: text.length, bytes: text.length, lines: text.split("\n").length, retainedBytes: text.length,
  omission: null, protocolTruncated: false, *chunks() { yield { start: 0, line: 0, text }; }, ...extra,
});
const item = (arguments_: unknown): ToolItem => ({ id: "tool", type: "tool", tool_call: { id: "call", name: "list_books", arguments: arguments_ }, output: output("[]"), active: false, is_error: false, canceled: false, version: 1 });

afterEach(cleanup);

describe("tool summaries", () => {
  test("summarizes list rows, stable statuses, and the remainder", () => {
    const rows = Array.from({ length: 5 }, (_, index) => ({ title: `book ${index}`, status: index === 0 ? "reading" : "done", record_id: `secret-${index}` }));
    const { lines } = summarizeToolOutput(output(JSON.stringify(rows)));
    expect(lines).toEqual(["5 rows · 1 reading, 4 done", "book 0 · reading", "book 1 · done", "book 2 · done", "+ 2 more"]);
  });

  test("selects human fields from one record", () => {
    const { lines } = summarizeToolOutput(output(JSON.stringify({ record_id: "hidden", revision: 4, name: "book", state: "done", nested: { no: "raw" } })));
    expect(lines).toEqual(["book · done"]);
  });

  test("renders error documents as one line", () => {
    expect(summarizeToolOutput(output(JSON.stringify({ code: "not_found", message: "book missing" })), true).lines).toEqual(["failed: book missing"]);
  });

  test.each([
    ["malformed", "{oops"], ["primitive", "42"], ["oversized", "x".repeat(64_001)],
  ])("falls back safely for %s output", (_name, raw) => {
    const result = summarizeToolOutput(output(raw));
    expect(result.lines[0]).toContain(raw === "42" ? "42" : raw === "{oops" ? "oops" : "truncated");
  });

  test("does not claim complete rows for omitted or truncated output", () => {
    const omitted = summarizeToolOutput(output("[{\"title\":\"book\"}]", { omission: { reason: "limit", start: 0, end: 1, bytes: 1 } as never }));
    const truncated = summarizeToolOutput(output("[]", { protocolTruncated: true }));
    expect(omitted.lines[0]).toContain("truncated");
    expect(truncated.lines[0]).toContain("truncated");
  });

  test("bounds hostile arguments and summarizes scalar arrays", () => {
    const summary = toolArgumentSummary(item({ status: ["done", "reading"], filter: { nested: "secret" }, giant: "x".repeat(1_000) }));
    expect(summary).toContain("status in [done, reading]");
    expect(summary).toContain("filter …");
    expect(summary.length).toBeLessThanOrEqual(260);
  });

  test("marks a locally truncated retained result and keeps the complete-body route", () => {
    const result = summarizeToolOutput(output(JSON.stringify({ title: "book", tail: "MISSING_TAIL" }) + "x".repeat(64_001)));
    expect(result.lines).toEqual(["output truncated or omitted"]);
    expect(result.fallback).toBe(true);
  });

  test("bounds production-shaped json arguments without throwing", () => {
    const huge = JSON.parse(JSON.stringify(Object.fromEntries(Array.from({ length: 1_024 }, (_, index) => [`key_${index}`, { deep: { value: "x" } }]))));
    expect(() => toolArgumentSummary(item(huge))).not.toThrow();
    expect(toolArgumentSummary(item(huge)).length).toBeLessThanOrEqual(260);
  });

  test.each([
    ["read", { path: "/w/src/app/config.py", limit: 20 }, "src/app/config.py"],
    ["Edit", { old_string: "a", new_string: "b", file_path: "/w/src/main.py" }, "src/main.py"],
    ["write", { content: "x", path: "/elsewhere/notes.md" }, "/elsewhere/notes.md"],
    ["bash", { command: "cd /w && wc -l /w/src/*.py /wx/a.py", timeout: 5 }, "cd . && wc -l src/*.py /wx/a.py"],
    ["grep", { pattern: "TODO", path: "/w/src" }, "TODO"],
    ["websearch", { query: "orca ui" }, "orca ui"],
    ["fetch", { url: "https://example.com/a" }, "https://example.com/a"],
  ])("shows only the primary argument of %s", (name, args, expected) => {
    expect(toolArgumentSummary({ ...item(args), tool_call: { id: "call", name, arguments: args } }, "/w/")).toBe(expected);
  });

  test("falls back to key summaries for unknown tools and missing primaries", () => {
    expect(toolArgumentSummary(item({ status: "done", path: "/w/a" }), "/w")).toBe("status done · path /w/a");
    expect(toolArgumentSummary({ ...item({ limit: 2 }), tool_call: { id: "call", name: "read", arguments: { limit: 2 } } })).toBe("limit 2");
  });

  test("never makes a path relative to a sibling dir, uses ~ for home, and keeps the file name when cut", () => {
    expect(displayPath("/w/abc/x.py", "/w/a")).toBe("/w/abc/x.py");
    expect(displayPath("/Users/me/notes/x.py", null)).toBe("~/notes/x.py");
    expect(displayPath("/home/me", null)).toBe("~");
    expect(displayPath("src/home/me/x.py", null)).toBe("src/home/me/x.py");
    const long = displayPath("/Users/me/.zeta/scratch/achilles/orca-look/home-ux-final/cwd/src/app/config.py", null);
    expect(long.length).toBeLessThanOrEqual(56);
    expect(long).toStartWith("~/");
    expect(long).toEndWith("/src/app/config.py");
    expect(long).toContain("…");
    const giant = displayPath(`/${"d".repeat(300)}/${"f".repeat(300)}.py`, null);
    expect(giant.length).toBeLessThanOrEqual(56);
    expect(giant).toEndWith(".py");
  });

  test("keeps the caps for hostile primary arguments", () => {
    const summary = toolArgumentSummary({ ...item({}), tool_call: { id: "call", name: "bash", arguments: { command: `echo ${"x".repeat(5_000)}\u0000\n` } } });
    expect(summary.length).toBeLessThanOrEqual(200);
    expect(summary).not.toMatch(/[\u0000-\u001f]/);
  });

  test("marks omitted scalar array values", () => {
    expect(toolArgumentSummary(item({ status: ["a", "b", "c", "d", "e", "f", "g", "h", "i"] }))).toContain("in [a, b, c, d, e, f, g, h, … 1 more]");
  });

  test("prioritizes date tokens without matching ordinary substrings", () => {
    const { lines } = summarizeToolOutput(output(JSON.stringify({ title: "book", location: "shelf", description: "plain", updated_at: "today" })));
    expect(lines).toEqual(["book · today · shelf"]);
  });

  test("marks raw production-shaped json when the preview budget is reached", () => {
    const huge = JSON.parse(JSON.stringify(Object.fromEntries(Array.from({ length: 1_024 }, (_, index) => [`key_${index}`, { deep: { value: 1 } }]))));
    expect(formatToolArguments(huge)).toContain("[truncated]");
    expect(formatToolArguments({ deep: { deeper: { value: 1 } } })).toContain('"value": 1');
  });

  test("indents raw arguments with real line breaks", () => {
    expect(formatToolArguments({ route: "/example", title: "first\nsecond" }))
      .toBe('{\n  "route": "/example",\n  "title": "first\\nsecond"\n}');
  });

  test("shows zeta argument truncation in the visible raw disclosure", async () => {
    const base = item({ query: "large" });
    const truncated = { ...base, tool_call: { ...base.tool_call, meta: { argumentsTruncated: true } } };
    const mounted = render(React.createElement(ToolSummaryBody, { item: truncated, output: output("{}"), state: "done" }));
    await act(async () => { fireEvent.click(mounted.getByText("raw")); });
    expect(mounted.getByText(/arguments truncated by zeta/)).toBeTruthy();
  });

  test("uses the fulcrum fallback for valid json while streaming", () => {
    const result = summarizeToolOutput(output('[{"title":"still changing"}]'), false, "streaming");
    expect(result.lines).toEqual(["output still streaming"]);
    expect(result.fallback).toBe(true);
  });
});

test.each([
  ["middle omission", output("headtail", {
    omission: { kind: "omitted", reason: "item-cap", whole: false, start: 4, end: 2052, bytes: 2048 },
    *chunks() { yield { start: 0, line: 0, text: "head" }; yield { start: 2052, line: 1, text: "tail" }; },
  }), "head\n2.0 KB not kept\ntail"],
  ["protocol truncation", output("head", { protocolTruncated: true }), "head\nhost did not provide the complete output"],
] as const)("compact tool result block shows %s", async (_name, text, expected) => {
  const base = item({});
  const tool: ToolItem = { ...base, result: {
    tool_call_id: base.tool_call.id, relation: "same", is_error: false,
    blocks: [{ metadata: { type: "reasoning" }, text }],
  } };
  const store = { ...createRunStore(), getItem: () => tool };
  const mounted = render(React.createElement(RunProvider, { store }, React.createElement(CompactTool, { id: tool.id })));
  fireEvent.click(mounted.getByText("list_books"));
  const reasoning = mounted.container.querySelector<HTMLDetailsElement>('details[data-part="reasoning"]')!;
  await act(async () => { reasoning.open = true; });
  expect(reasoning.querySelector('[data-part="reasoning-body"]')?.textContent).toBe(expected);
});
