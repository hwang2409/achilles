import { expect, test } from "bun:test";
import { gradeCheck, gradeTask, structurallyContains, validateTask } from "./eval-grade";

const task = { id: "x-task", page_plan: [{ alias: "p", source: "fixture", bind_chat: true, create_mode: false }], agent_turns: 2, steps: [{ id: "do-work", kind: "prompt", page: "p", chat: "chat-a", prompt: "work" }], checks: [{ id: "page", type: "page_exists", page: "p" }] };

test("task schema is closed and count checks name real collections", () => {
  expect(validateTask(task).id).toBe("x-task");
  expect(() => validateTask({ ...task, extra: true })).toThrow("unknown key");
  expect(() => validateTask({ ...task, checks: [{ id: "missing", type: "count", page: "p", name: "invalid_tool_versions", count: 0 }] })).toThrow("known collection");
  expect(validateTask({ ...task, prompt: "one source", steps: [{ id: "do-work", kind: "prompt", page: "p", chat: "chat-a" }] }).prompt).toBe("one source");
  expect(() => validateTask({ ...task, prompt: "duplicate" })).toThrow("prompt source");
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

test("schema roundtrip accepts an agent-designed title field", () => {
  const check = { id: "roundtrip", type: "schema_roundtrip" as const, page: "p", value: ["synthetic note"] }; const pages = [{ id: "p1", alias: "p" }];
  const version = { page_id: "p1", name: "add_note", collection: "notes", operation: "insert", data_schema: { type: "object", properties: { title: { type: "string" } }, required: ["title"] } };
  const snapshot = { pages, tool_versions: [version], records: [{ page_id: "p1", collection: "notes", data: { title: "synthetic note" } }], results: [{ page_id: "p1", tool: "achilles__add_note", success: true, data: { title: "synthetic note" } }] };
  expect(gradeCheck(check, snapshot).pass).toBe(true);
  expect(gradeCheck(check, { ...snapshot, tool_versions: [{ ...version, data_schema: { type: "object", properties: { text: { type: "string" } } } }] }).pass).toBe(false);
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

test("page counts use the resolved id while other collections stay page-owned", () => {
  const pages = [{ id: "p1", alias: "p" }, { id: "p2" }];
  expect(gradeCheck({ id: "pages", type: "count", page: "p", name: "pages", count: 1 }, { pages }).pass).toBe(true);
  expect(gradeCheck({ id: "tools", type: "count", page: "p", name: "tools", count: 1 }, { pages, tools: [{ id: "t1", page_id: "p2" }] }).pass).toBe(false);
});

test("reserved tool refusal requires the exact current or baseline error", () => {
  const check = { id: "refused", type: "refused_tool_name" as const, page: "p", name: "create_tool" }; const pages = [{ id: "p1", alias: "p" }];
  const calls = [{ id: "call-1", page_id: "p1", tool: "achilles__create_tool", arguments: { bundle: { name: "create_tool" } } }];
  const grade = (data: unknown) => gradeCheck(check, { pages, calls, results: [{ call_id: "call-1", page_id: "p1", success: false, data }] }).pass;
  expect(grade({ code: "invalid_input", path: "/bundle/name", expected: "not one of: create_page,create_tool" })).toBe(true);
  expect(grade("invalid or reserved tool name")).toBe(true);
  expect(grade({ code: "invalid_input", path: "/bundle/input_schema", expected: "object" })).toBe(false);
});

test("record-crud list matching is order-independent, distinct, and complete", () => {
  const pages = [{ id: "p1", alias: "p" }];
  const check = { id: "list", type: "successful_result" as const, page: "p", tool: "achilles__list_records", value: [{ id: "record-1", status: "done" }, { id: "record-2" }] };
  const result = (records: unknown[]) => gradeCheck(check, { pages, results: [{ page_id: "p1", tool: "achilles__list_records", success: true, data: { records } }] }).pass;
  expect(result([{ id: "record-2", extra: true }, { id: "record-1", status: "done", extra: true }])).toBe(true);
  expect(result([{ id: "record-1", status: "done" }])).toBe(false);
  expect(structurallyContains([{ id: "record-1" }], [{ id: "record-1" }, { id: "record-1" }])).toBe(false);
});

test("reading-list carries one record id through insert, update, and read", () => {
  const pages = [{ id: "p1", alias: "p" }]; const final = { title: "Synthetic Book", status: "read" };
  const check = { id: "updated", type: "updated_record" as const, page: "p", chat: "reading-chat", value: { before: ["Synthetic Book", "unread"], after: ["Synthetic Book", "read"] } };
  const data_schema = { type: "object", properties: { title: { type: "string" }, status: { type: "string" } } };
  const tool_versions = [{ page_id: "p1", name: "add_book", collection: "books", operation: "insert", data_schema }, { page_id: "p1", name: "update_book", collection: "books", operation: "update", data_schema }, { page_id: "p1", name: "list_books", collection: "books", operation: "list", data_schema }];
  const result = (tool: string, record_id: string, data: object) => ({ page_id: "p1", chat_id: "reading-chat", tool, success: true, data: { ...data, record_id } });
  const insertA = result("achilles__add_book", "a", { title: "Synthetic Book", status: "unread" });
  const updateB = result("achilles__update_book", "b", final); const readB = { page_id: "p1", chat_id: "reading-chat", tool: "achilles__list_books", success: true, data: { records: [{ ...final, record_id: "b" }] } };
  expect(gradeCheck(check, { pages, tool_versions, results: [insertA, updateB, readB] }).pass).toBe(false);
  const updateA = result("achilles__update_book", "a", final); const readA = { ...readB, data: { records: [{ ...final, record_id: "a" }] } };
  expect(gradeCheck(check, { pages, tool_versions, results: [insertA, updateA, readA] }).pass).toBe(true);
});

test("exact page records reject extra reconnect, approval, and crud writes", () => {
  const pages = [{ id: "p1", alias: "p" }]; const page = (data: object) => ({ page_id: "p1", data });
  const notes = { id: "notes", type: "records_exact" as const, page: "p", value: [{ text: "reconnect note" }] };
  expect(gradeCheck(notes, { pages, records: [page({ text: "reconnect note" })] }).pass).toBe(true);
  expect(gradeCheck(notes, { pages, records: [page({ text: "reconnect note" }), page({ text: "wrong extra note" })] }).pass).toBe(false);
  const crud = { id: "crud", type: "records_exact" as const, page: "p", value: [{ id: "record-1", status: "done" }, { id: "record-2" }] };
  expect(gradeCheck(crud, { pages, records: [page({ id: "record-2" }), page({ id: "record-1", status: "done" }), page({ id: "wrong" })] }).pass).toBe(false);
});

test("workflow, approval, and reconnect checks use page-local structured evidence", () => {
  const pages = [{ id: "p1", alias: "p" }];
  expect(gradeCheck({ id: "ops", type: "operations", page: "p", value: ["insert", "update"] }, { pages, tool_versions: [{ page_id: "p1", collection: "books", operation: "insert" }, { page_id: "p1", collection: "books", operation: "update" }] }).pass).toBe(true);
  expect(gradeCheck({ id: "ops", type: "operations", page: "p", value: ["insert", "update"] }, { pages, tool_versions: [{ page_id: "p1", collection: "a", operation: "insert" }, { page_id: "p1", collection: "b", operation: "update" }] }).pass).toBe(false);
  const approval = { id: "approval", type: "approval" as const, page: "p", tool: "achilles__add_note", count: 1 };
  expect(gradeCheck(approval, { pages, approvals: [{ page_id: "p1", tool: "achilles__other" }] }).pass).toBe(false);
  expect(gradeCheck(approval, { pages, approvals: [{ page_id: "p1", tool: "achilles__add_note" }] }).pass).toBe(true);
  expect(gradeCheck(approval, { pages, approvals: [{ page_id: "p1", tool: "achilles__add_note" }, { page_id: "p1", tool: "achilles__add_note" }] }).pass).toBe(false);
  expect(gradeCheck({ id: "resume", type: "reconnect", page: "p" }, { pages, reconnects: [{ page_id: "p1", original_session_id: "s", resumed_session_id: "s", history_continuity: true }] }).pass).toBe(true);
});
