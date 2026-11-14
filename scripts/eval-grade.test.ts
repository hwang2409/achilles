import { expect, test } from "bun:test";
import { gradeCheck, gradeTask, structurallyContains, validateTask } from "./eval-grade";

const task = { id: "x-task", page_plan: [{ alias: "p", source: "fixture", bind_chat: true, create_mode: false }], agent_turns: 2, steps: [{ id: "do-work", kind: "prompt", page: "p", chat: "chat-a", prompt: "work" }], checks: [{ id: "page", type: "page_exists", page: "p" }] };

test("task schema is closed and created pages declare routes", () => {
  expect(validateTask(task).id).toBe("x-task");
  expect(() => validateTask({ ...task, extra: true })).toThrow("unknown key");
  expect(() => validateTask({ ...task, page_plan: [{ alias: "new", source: "created", bind_chat: true, create_mode: true }] })).toThrow("needs route");
});

test("same-page grading rejects empty and wrong-page evidence", () => {
  const check = { id: "same", type: "same_page" as const, page: "p" };
  const base = { pages: [{ id: "p1", alias: "p" }] };
  expect(gradeCheck(check, { ...base, related_page_ids: [] }).pass).toBe(false);
  expect(gradeCheck(check, { ...base, related_page_ids: ["p1", "p2"] }).pass).toBe(false);
  expect(gradeCheck(check, { ...base, related_page_ids: ["p1"] }).pass).toBe(true);
});

test("structured outcomes cannot pass on unrelated text", () => {
  const check = { id: "result", type: "successful_result" as const, page: "p", tool: "achilles__add_annotation", value: { run_id: "run-002", verdict: "bad" } };
  const pages = [{ id: "p1", alias: "p" }];
  expect(gradeCheck(check, { pages, results: [{ page_id: "p1", tool: "achilles__add_annotation", success: true, data: { note: "run-002 was bad" } }] }).pass).toBe(false);
  expect(gradeCheck(check, { pages, results: [{ page_id: "p1", tool: "achilles__add_annotation", success: true, data: { run_id: "run-002", verdict: "bad" } }] }).pass).toBe(true);
  expect(structurallyContains({ records: [{ run_id: "run-002", verdict: "bad", extra: 1 }] }, { run_id: "run-002", verdict: "bad" })).toBe(true);
});

test("second-chat unavailable sentinel fails from durable history", () => {
  const check = { id: "available", type: "history_absent" as const, chat: "chat-b", text: "MCP server achilles is unavailable" };
  expect(gradeCheck(check, { chats: [{ chat_id: "chat-b", history: "MCP server achilles is unavailable" }] }).pass).toBe(false);
});

test("page-aware approvals and strict route checks do not accept other pages", () => {
  const t = validateTask({ ...task, checks: [{ id: "approval", type: "count", page: "p", name: "approvals", count: 1 }, { id: "route", type: "page_exists", page: "p", route: "/wanted" }] });
  const failed = gradeTask(t, { pages: [{ id: "p1", alias: "p", route: "/wrong" }], approvals: [{ page_id: "other" }] });
  expect(failed.checks.every(check => !check.pass)).toBe(true);
});
