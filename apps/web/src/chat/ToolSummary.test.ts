import { describe, expect, test } from "bun:test";
import { summarizeToolOutput, toolArgumentSummary } from "./ToolSummary";
import type { ToolBodyProps, ToolItem } from "@fulcrum/react";

const output = (text: string, extra: Partial<ToolBodyProps["output"]> = {}): ToolBodyProps["output"] => ({
  version: 1, length: text.length, bytes: text.length, lines: text.split("\n").length, retainedBytes: text.length,
  omission: null, protocolTruncated: false, *chunks() { yield { start: 0, line: 0, text }; }, ...extra,
});
const item = (arguments_: unknown): ToolItem => ({ id: "tool", type: "tool", tool_call: { id: "call", name: "list_books", arguments: arguments_ }, output: output("[]"), active: false, is_error: false, canceled: false, version: 1 });

describe("tool summaries", () => {
  test("summarizes list rows, stable statuses, and the remainder", () => {
    const rows = Array.from({ length: 5 }, (_, index) => ({ title: `book ${index}`, status: index === 0 ? "reading" : "done", record_id: `secret-${index}` }));
    const { lines } = summarizeToolOutput(output(JSON.stringify(rows)));
    expect(lines).toEqual(["5 rows · 1 reading, 4 done", "title book 0 · status reading", "title book 1 · status done", "title book 2 · status done", "+ 2 more"]);
  });

  test("selects human fields from one record", () => {
    const { lines } = summarizeToolOutput(output(JSON.stringify({ record_id: "hidden", revision: 4, name: "book", state: "done", nested: { no: "raw" } })));
    expect(lines).toEqual(["name book · state done"]);
  });

  test("renders error documents as one line", () => {
    expect(summarizeToolOutput(output(JSON.stringify({ code: "not_found", message: "book missing" })), true).lines).toEqual(["failed: book missing"]);
  });

  test.each([
    ["malformed", "{oops"], ["primitive", "42"], ["oversized", "x".repeat(64_001)],
  ])("falls back safely for %s output", (_name, raw) => {
    const result = summarizeToolOutput(output(raw));
    expect(result.lines[0]).toContain(raw === "42" ? "42" : raw.slice(0, 20));
  });

  test("does not claim complete rows for omitted or truncated output", () => {
    const omitted = summarizeToolOutput(output("[{\"title\":\"book\"}]", { omission: { reason: "limit", start: 0, end: 1, bytes: 1 } as never }));
    const truncated = summarizeToolOutput(output("[]", { protocolTruncated: true }));
    expect(omitted.lines[0]).toContain("book");
    expect(truncated.raw).toContain("truncated");
  });

  test("bounds hostile arguments and summarizes scalar arrays", () => {
    const summary = toolArgumentSummary(item({ status: ["done", "reading"], filter: { nested: "secret" }, giant: "x".repeat(1_000) }));
    expect(summary).toContain("status in [done, reading]");
    expect(summary).toContain("filter …");
    expect(summary.length).toBeLessThanOrEqual(260);
  });
});
