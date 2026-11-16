import { expect, test } from "bun:test";
import { type EvalSnapshot, expectationTokens, gradeCheck, gradeReference, gradeTask, mentions, structurallyContains, validateTask } from "./eval-grade";
import countTaskJson from "../evals/tasks/count-question.json";
import judgeTaskJson from "../evals/tasks/judge-page-and-annotate.json";
import metricTaskJson from "../evals/tasks/reading-metric-count.json";
import readingListTaskJson from "../evals/tasks/reading-list-one-prompt.json";
import staleRevisionTaskJson from "../evals/tasks/stale-revision-after-form-edit.json";
import staleRevisionReferences from "../evals/references/stale-revision-after-form-edit.json";
import deniedTaskJson from "../evals/tasks/denied-write-stops.json";
import deniedReferences from "../evals/references/denied-write-stops.json";
import bulkEditTaskJson from "../evals/tasks/bulk-edit-deny-midway.json";
import bulkEditReferences from "../evals/references/bulk-edit-deny-midway.json";
import createModeOffTaskJson from "../evals/tasks/create-mode-off-request.json";
import createModeOffReferences from "../evals/references/create-mode-off-request.json";

const task = { id: "x-task", page_plan: [{ alias: "p", source: "fixture", bind_chat: true, create_mode: false }], agent_turns: 2, steps: [{ id: "do-work", kind: "prompt", page: "p", chat: "chat-a", prompt: "work" }], checks: [{ id: "page", type: "page_exists", page: "p" }] };

test("static file failures are harness errors, not agent failures", () => {
  const result = gradeReference(task, { browser: [{ text: "static file not found" }] });
  expect(result.status).toBe("harness_error");
  expect(result.pass).toBe(false);
});

test("status checks match whole normalized tokens and declared synonyms", () => {
  const task = validateTask(readingListTaskJson);
  const storedCheck = task.checks.find(check => check.id === "record")!;
  const visibleCheck = task.checks.find(check => check.id === "visible-status")!;
  const snapshot = (status: string) => ({
    pages: [{ id: "reading-id", alias: "reading" }],
    tool_versions: [{ page_id: "reading-id", name: "list_books", collection: "books", data_schema: { type: "object", properties: { title: { type: "string" }, status: { type: "string" } } } }],
    records: [{ page_id: "reading-id", collection: "books", data: { title: "Synthetic Book", status } }],
    results: [{ page_id: "reading-id", tool: "achilles__list_books", success: true, data: [{ title: "Synthetic Book", status }] }],
  });
  for (const [status, expected] of [["to-read", false], ["Read", true], ["finished", true], ["reading", false]] as const) {
    expect(gradeCheck(storedCheck, snapshot(status)).pass, `stored ${status}`).toBe(expected);
  }
  for (const [text, expected] of [["to-read", false], ["read", true], ["reading", false]] as const) {
    expect(gradeCheck(visibleCheck, { ...snapshot("read"), browser: [{ page_id: "reading-id", text }] }).pass, `visible ${text}`).toBe(expected);
  }
});

test("a setup task without an initial snapshot is a harness error", () => {
  const setupTask = validateTask({ ...task, setup: { tools: [{ name: "list_records", operation: "list", collection: "records" }], records: [] } });
  const result = gradeReference(setupTask, { pages: [{ id: "home", alias: "p" }], pages_seen: [], results: [], turns: 0 });
  expect(result.status).toBe("harness_error");
  expect(result.checks[0]?.actual).toEqual(["setup precondition unverifiable"]);
});

test("a missing seeded layout is a harness error before grading", () => {
  const original = { blocks: [{ type: "text", text: "seeded" }] }; const added = { type: "text", text: "added" };
  const layoutTask = validateTask({ ...task, setup: { tools: [], records: [], initial_layout: original }, checks: [{ id: "layout", type: "layout_update", page: "p", value: { original, added, version: 2 } }] });
  const result = gradeReference(layoutTask, { initial: { layouts: [] }, pages: [{ id: "home", alias: "p" }], layouts: [{ page_id: "home", version: 1, document: original }, { page_id: "home", version: 2, document: { blocks: [...original.blocks, added] } }], turns: 0 });
  expect(result.status).toBe("harness_error");
  expect(result.turns).toBe(0);
});

test("task schema is closed and count checks name real collections", () => {
  expect(validateTask(task).id).toBe("x-task");
  expect(() => validateTask({ ...task, extra: true })).toThrow("unknown key");
  expect(() => validateTask({ ...task, checks: [{ id: "missing", type: "count", page: "p", name: "invalid_tool_versions", count: 0 }] })).toThrow("known collection");
  expect(() => validateTask({ ...task, checks: [{ id: "detail", type: "detail_selects", page: "p", value: "run-002" }] })).toThrow("collection");
  expect(validateTask({ ...task, prompt: "one source", steps: [{ id: "do-work", kind: "prompt", page: "p", chat: "chat-a" }] }).prompt).toBe("one source");
  expect(() => validateTask({ ...task, prompt: "duplicate" })).toThrow("prompt source");
});

test("task expectation lint rejects undeclared record keys and literals", () => {
  const task = { id: "lint-task", page_plan: [{ alias: "p", source: "fixture", bind_chat: true, create_mode: false }], agent_turns: 1, steps: [{ id: "do", kind: "prompt", page: "p", chat: "c", prompt: "do work with wanted" }], setup: { tools: [{ name: "add_note", operation: "insert", collection: "notes" }], records: [] }, checks: [{ id: "record", type: "records_exact", page: "p", value: [{ text: "undocumented literal" }] }] };
  expect(() => validateTask(task)).toThrow("without a prompt quote or declared schema");
  expect(() => validateTask({ ...task, checks: [{ id: "record", type: "record", page: "p", value: { type: "wanted" } }] })).toThrow('expects "type"');
});

test("expectation tokens cover each literal-bearing check shape", () => {
  const cases = [
    [{ id: "page", type: "page_exists", page: "p", route: "/wanted" }, ["/wanted"]],
    [{ id: "count", type: "count", page: "p", name: "records", count: 1 }, ["records"]],
    [{ id: "tool", type: "tool", page: "p", name: "add_note" }, ["add_note"]],
    [{ id: "approval", type: "approval", page: "p", tool: "achilles__add_note", count: 1 }, ["add_note"]],
    [{ id: "record", type: "record", page: "p", value: { text: "wanted" } }, ["text", "wanted"]],
    [{ id: "browser", type: "browser_text", page: "p", text: "visible" }, ["visible"]],
    [{ id: "layout", type: "layout_contains", page: "p", value: { type: "list" } }, ["type", "list"]],
    [{ id: "layout-update", type: "layout_update", page: "p", value: { original: { blocks: [] }, added: { type: "list" }, version: 2 } }, ["original", "blocks", "added", "type", "list", "version"]],
  ] as const;
  for (const [check, expected] of cases) expect(expectationTokens(check as never), check.type).toEqual(expected);
});

const toolEvolutionCheck = { id: "v2-used", type: "tool_evolution" as const, page: "reading", chat: "fresh-chat", value: { tool: "add_book", from: 1, to: 2, new_value: 5, legacy_record: "legacy-book", read_tool: "list_books" } };
const toolEvolutionTask = (initial: Record<string, unknown>) => validateTask({
  id: "tool-version-fresh-chat",
  page_plan: [{ alias: "reading", source: "setup", bind_chat: true, create_mode: true }],
  agent_turns: 10,
  steps: [{ id: "publish-v2", kind: "prompt", page: "reading", chat: "author-chat", prompt: "add an optional numeric rating" }, { id: "use-v2", kind: "prompt", page: "reading", chat: "fresh-chat", prompt: "add Dune with a rating of 5, then list all books" }],
  setup: {
    tools: [
      { name: "add_book", operation: "insert", collection: "books", input_schema: { type: "object", properties: { title: { type: "string" } }, required: ["title"], additionalProperties: false } },
      { name: "list_books", operation: "list", collection: "books" },
    ],
    records: [{ id: "legacy-book", collection: "books", data: { title: "Legacy Book" } }],
  },
  checks: [toolEvolutionCheck],
  ...initial,
});
const toolEvolutionSnapshot = (field = "score", fieldSchema: Record<string, unknown> = { type: "number" }, stringValid = false) => {
  const v1 = { type: "object", properties: { title: { type: "string" } }, required: ["title"], additionalProperties: false };
  const v2 = { type: "object", properties: { title: { type: "string" }, [field]: fieldSchema }, required: ["title"], additionalProperties: false };
  const initial = {
    pages: [{ id: "home", alias: "reading" }],
    tools: [{ id: "add-id", page_id: "home", name: "add_book" }, { id: "list-id", page_id: "home", name: "list_books" }],
    assignments: [{ page_id: "home", tool_id: "add-id", active_version: 1 }, { page_id: "home", tool_id: "list-id", active_version: 1 }],
    tool_versions: [
      { page_id: "home", tool_id: "add-id", name: "add_book", version: 1, operation: "insert", collection: "books", input_schema: v1 },
      { page_id: "home", tool_id: "list-id", name: "list_books", version: 1, operation: "list", collection: "books", input_schema: { type: "object", additionalProperties: false } },
    ],
    records: [{ page_id: "home", collection: "books", id: "legacy-book", version: 1, data: { title: "Legacy Book" } }],
  };
  return {
    initial,
    pages: initial.pages,
    tools: initial.tools,
    assignments: [{ page_id: "home", tool_id: "add-id", active_version: 2 }, initial.assignments[1]],
    tool_versions: [...initial.tool_versions, { page_id: "home", tool_id: "add-id", name: "add_book", version: 2, operation: "insert", collection: "books", description: "insert a rated book", input_schema: v2 }],
    records: [structuredClone(initial.records[0]), { page_id: "home", collection: "books", id: "new-book", version: 2, data: { title: "Dune", [field]: 5 } }],
    tool_schema_validations: [{ tool: "add_book", version: 2, field, number_valid: true, string_valid: stringValid }],
    calls: [
      { id: "add-call", page_id: "home", chat_id: "fresh-chat", tool: "achilles__add_book", arguments: { title: "Dune", [field]: 5 } },
      { id: "list-call", page_id: "home", chat_id: "fresh-chat", tool: "achilles__list_books", arguments: {} },
    ],
    results: [
      { call_id: "add-call", page_id: "home", chat_id: "fresh-chat", tool: "achilles__add_book", success: true, data: { record_id: "new-book", title: "Dune", [field]: 5 } },
      { call_id: "list-call", page_id: "home", chat_id: "fresh-chat", tool: "achilles__list_books", success: true, data: [{ record_id: "legacy-book", title: "Legacy Book" }, { record_id: "new-book", title: "Dune", [field]: 5 }] },
    ],
  };
};

for (const testCase of [
  { name: "number field named score with a description change", snapshot: toolEvolutionSnapshot("score"), status: "pass" },
  { name: "empty field schema", snapshot: toolEvolutionSnapshot("score", {}, true), status: "agent_fail" },
  { name: "number or string field", snapshot: toolEvolutionSnapshot("score", { anyOf: [{ type: "number" }, { type: "string" }] }, true), status: "agent_fail" },
  { name: "integer field named stars", snapshot: toolEvolutionSnapshot("stars", { type: "integer" }), status: "pass" },
  { name: "anyOf accepts number or null", snapshot: toolEvolutionSnapshot("score", { anyOf: [{ type: "number" }, { type: "null" }] }), status: "pass" },
  { name: "type array accepts number or null", snapshot: toolEvolutionSnapshot("score", { type: ["number", "null"] }), status: "pass" },
  { name: "anyOf accepts integer or null", snapshot: toolEvolutionSnapshot("stars", { anyOf: [{ type: "integer" }, { type: "null" }] }), status: "pass" },
  { name: "string or null rejects numeric use", snapshot: (() => { const snapshot = toolEvolutionSnapshot("score", { anyOf: [{ type: "string" }, { type: "null" }] }); snapshot.results[0].success = false; return snapshot; })(), status: "agent_fail" },
  { name: "two new fields with one used", snapshot: (() => { const snapshot = toolEvolutionSnapshot(); (snapshot.tool_versions.at(-1)!.input_schema as any).properties.note = { type: "string" }; return snapshot; })(), status: "pass" },
  { name: "publication does not depend on a specific authoring tool", snapshot: toolEvolutionSnapshot(), status: "pass" },
  { name: "v2 published but fresh chat uses cached v1", snapshot: (() => { const snapshot = toolEvolutionSnapshot(); (snapshot.calls[0].arguments as any) = { title: "Dune" }; return snapshot; })(), status: "agent_fail" },
  { name: "fresh chat uses v2 but list omits legacy row", snapshot: (() => { const snapshot = toolEvolutionSnapshot(); (snapshot.results[1].data as any[]) = [(snapshot.results[1].data as any[])[1]]; return snapshot; })(), status: "agent_fail" },
  { name: "v2 makes the new field required", snapshot: (() => { const snapshot = toolEvolutionSnapshot(); (snapshot.tool_versions.at(-1)!.input_schema as any).required.push("score"); return snapshot; })(), status: "agent_fail" },
  { name: "agent deletes the v1 row", snapshot: (() => { const snapshot = toolEvolutionSnapshot(); snapshot.records = snapshot.records.slice(1); return snapshot; })(), status: "agent_fail" },
  { name: "agent rewrites the v1 row as v2", snapshot: (() => { const snapshot = toolEvolutionSnapshot(); snapshot.records[0].version = 2; return snapshot; })(), status: "agent_fail" },
  { name: "v2 row stored at version 1", snapshot: (() => { const snapshot = toolEvolutionSnapshot(); snapshot.records[1].version = 1; return snapshot; })(), status: "agent_fail" },
  { name: "stored value changed before final list", snapshot: (() => { const snapshot = toolEvolutionSnapshot(); (snapshot.records[1].data as any).score = 4; return snapshot; })(), status: "agent_fail" },
  { name: "stored value deleted before final list", snapshot: (() => { const snapshot = toolEvolutionSnapshot(); delete (snapshot.records[1].data as any).score; return snapshot; })(), status: "agent_fail" },
  { name: "final list omits the value", snapshot: (() => { const snapshot = toolEvolutionSnapshot(); delete ((snapshot.results[1].data as any[])[1] as any).score; return snapshot; })(), status: "agent_fail" },
  { name: "earlier correct list followed by incomplete list", snapshot: (() => { const snapshot = toolEvolutionSnapshot(); snapshot.results.push({ page_id: "home", chat_id: "fresh-chat", tool: "achilles__list_books", success: true, data: [{ record_id: "legacy-book", title: "Legacy Book" }, { record_id: "new-book", title: "Dune" }] }); return snapshot; })(), status: "agent_fail" },
  { name: "earlier incomplete list followed by correct list", snapshot: (() => { const snapshot = toolEvolutionSnapshot(); snapshot.results[1].data = [{ record_id: "new-book", title: "Dune" }]; snapshot.results.push({ page_id: "home", chat_id: "fresh-chat", tool: "achilles__list_books", success: true, data: [{ record_id: "legacy-book", title: "Legacy Book" }, { record_id: "new-book", title: "Dune", score: 5 }] }); return snapshot; })(), status: "pass" },
  { name: "product validator unavailable", snapshot: (() => { const snapshot = toolEvolutionSnapshot(); delete (snapshot as any).tool_schema_validations; (snapshot as any).tool_schema_validation_error = "uv unavailable"; return snapshot; })(), status: "harness_error" },
] as const) test(`tool_evolution: ${testCase.name}`, () => {
  expect(gradeReference(toolEvolutionTask({}), testCase.snapshot as never).status).toBe(testCase.status);
});

test("tool_evolution reports broken v1 seeds as harness errors", () => {
  for (const mutate of [
    (snapshot: ReturnType<typeof toolEvolutionSnapshot>) => { snapshot.initial.assignments[0].active_version = 2; },
    (snapshot: ReturnType<typeof toolEvolutionSnapshot>) => { snapshot.initial.tool_versions = snapshot.initial.tool_versions.filter(row => row.name !== "list_books"); },
    (snapshot: ReturnType<typeof toolEvolutionSnapshot>) => { snapshot.initial.records[0].version = 2; },
  ]) {
    const snapshot = toolEvolutionSnapshot(); mutate(snapshot);
    expect(gradeReference(toolEvolutionTask({}), snapshot as never).status).toBe("harness_error");
  }
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

const judgeDetailCheck = validateTask(judgeTaskJson).checks.find(check => check.id === "detail-layout")!;
const detailSnapshot = (block: Record<string, unknown> | Array<Record<string, unknown>>, records: Array<{ id?: string; collection: string; data: Record<string, unknown> }>) => ({
  pages: [{ id: "review-page", alias: "review" }],
  layouts: [{ page_id: "review-page", version: 1, document: { blocks: Array.isArray(block) ? block : [block] } }],
  records: records.map(record => ({ page_id: "review-page", ...record })),
});
const annotation = (data: Record<string, unknown>, id = "annotation-1", collection = "annotations") => ({ id, collection, data });
const listCheck = (spec: { collection?: string; value?: string }) => ({ id: "list", type: "list_shows" as const, page: "review", ...spec });

for (const testCase of [
  { name: "list on annotations, judge spec", check: listCheck({ collection: "annotations" }), blocks: [{ type: "list", collection: "annotations" }], records: [annotation({ run_id: "run-002" })], pass: true },
  { name: "list on other, judge spec", check: listCheck({ collection: "annotations" }), blocks: [{ type: "list", collection: "other" }], records: [annotation({ run_id: "run-002" })], pass: false, reason: "list on other, expected annotations" },
  { name: "two lists, one right", check: listCheck({ collection: "annotations" }), blocks: [{ type: "list", collection: "other" }, { type: "list", collection: "annotations" }], records: [], pass: true },
  { name: "no list", check: listCheck({ collection: "annotations" }), blocks: [{ type: "text" }], records: [], pass: false },
  { name: "reading list holds Synthetic Book", check: listCheck({ value: "Synthetic Book" }), blocks: [{ type: "list", collection: "books" }], records: [annotation({ title: "Synthetic Book" }, "book-1", "books")], pass: true },
  { name: "Synthetic Book is only in another collection", check: listCheck({ value: "Synthetic Book" }), blocks: [{ type: "list", collection: "books" }], records: [annotation({ title: "Synthetic Book" }, "book-1", "reading_list")], pass: false },
  { name: "book identity field is agent-designed", check: listCheck({ value: "Synthetic Book" }), blocks: [{ type: "list", collection: "books" }], records: [annotation({ name: "Synthetic Book" }, "book-1", "books")], pass: true },
  { name: "list filter excludes the value record", check: listCheck({ value: "Synthetic Book" }), blocks: [{ type: "list", collection: "books", filter: { field: "status", equals: "unread" } }], records: [annotation({ title: "Synthetic Book", status: "read" }, "book-1", "books")], pass: false },
] as const) test(`list_shows: ${testCase.name}`, () => {
  const result = gradeCheck(testCase.check, detailSnapshot([...testCase.blocks], [...testCase.records]));
  expect(result.pass).toBe(testCase.pass);
  if ("reason" in testCase) expect(result.reason).toBe(testCase.reason);
});

test("list_shows requires a collection or value", () => {
  expect(() => validateTask({ ...task, checks: [{ id: "list", type: "list_shows", page: "p" }] })).toThrow("collection or string value");
});

test("list_shows grades only the final stored layout", () => {
  const snapshot = detailSnapshot({ type: "list", collection: "books" }, [annotation({ title: "Synthetic Book" }, "book-1", "books")]);
  snapshot.layouts.push({ page_id: "review-page", version: 2, document: { blocks: [{ type: "text" }] } });
  expect(gradeCheck(listCheck({ value: "Synthetic Book" }), snapshot).pass).toBe(false);
});

for (const testCase of [
  { name: "filter run_id=run-002, record has run_id run-002", block: { type: "detail", collection: "annotations", filter: { field: "run_id", equals: "run-002" } }, records: [annotation({ run_id: "run-002" })], pass: true },
  { name: "filter record_id=run-002, record has run_id run-002", block: { type: "detail", collection: "annotations", filter: { field: "record_id", equals: "run-002" } }, records: [annotation({ run_id: "run-002" })], pass: false, reason: 'filter {"field":"record_id","equals":"run-002"} matches 0 records' },
  { name: "filter on another field holding run-002", block: { type: "detail", collection: "annotations", filter: { field: "run", equals: "run-002" } }, records: [annotation({ run: "run-002" })], pass: true },
  { name: "filter matches 2 records", block: { type: "detail", collection: "annotations", filter: { field: "run", equals: "run-002" } }, records: [annotation({ run: "run-002" }), annotation({ run: "run-002" }, "annotation-2")], pass: false },
  { name: "filter matches 1 record without run-002", block: { type: "detail", collection: "annotations", filter: { field: "status", equals: "bad" } }, records: [annotation({ status: "bad" })], pass: false },
  { name: "detail block on a different collection", block: { type: "detail", collection: "other", filter: { field: "run", equals: "run-002" } }, records: [annotation({ run: "run-002" })], pass: false },
  { name: "different collection with its own matching record", block: { type: "detail", collection: "other", filter: { field: "run", equals: "run-002" } }, records: [annotation({ run: "run-002" }, "other-1", "other")], pass: false },
  { name: "one wrong and one correct detail block", block: [{ type: "detail", collection: "other", filter: { field: "run", equals: "run-002" } }, { type: "detail", collection: "annotations", filter: { field: "run", equals: "run-002" } }], records: [annotation({ run: "run-002" }), annotation({ run: "run-002" }, "other-1", "other")], pass: true },
  { name: "no detail block", block: { type: "text", text: "run-002" }, records: [annotation({ run: "run-002" })], pass: false },
  { name: "where alias shape", block: { type: "detail", collection: "annotations", where: { field: "run", equals: "run-002" } }, records: [annotation({ run: "run-002" })], pass: true },
  { name: "old record-id selector naming the run-002 record", block: { type: "detail", collection: "annotations", record_id: "annotation-1" }, records: [annotation({ run: "run-002" })], pass: true },
  { name: "old record selector naming the run-002 record", block: { type: "detail", collection: "annotations", record: "annotation-1" }, records: [annotation({ run: "run-002" })], pass: true },
  { name: "list block only", block: { type: "list", collection: "annotations", filter: { field: "run", equals: "run-002" } }, records: [annotation({ run: "run-002" })], pass: false },
] as const) test(`detail_selects: ${testCase.name}`, () => {
  const result = gradeCheck(judgeDetailCheck, detailSnapshot(testCase.block, [...testCase.records]));
  expect(result.pass).toBe(testCase.pass);
  if ("reason" in testCase) expect(result.reason).toBe(testCase.reason);
});

const metricCheck = { id: "done-count", type: "metric_count" as const, page: "reading", value: { collection: "books", where: { field: "status", equals: "done" }, count: 2, position: "first" } };
const metricSnapshot = ({ block = { type: "metric", label: "Done books", collection: "books", count: true, where: { field: "status", equals: "done" } }, value = 2, records = [{ status: "done" }, { status: "done" }, { status: "reading" }] }: { block?: Record<string, unknown>; value?: number; records?: Array<Record<string, unknown>> } = {}) => ({
  pages: [{ id: "reading-page", alias: "reading" }],
  layouts: [{ page_id: "reading-page", version: 2, document: { blocks: [block, { type: "list", collection: "books" }] } }],
  records: records.map((data, index) => ({ page_id: "reading-page", id: `book-${index}`, collection: "books", data })),
  results: [{ page_id: "reading-page", tool: "achilles__inspect_page", success: true, data: { metric_values: [{ block: 0, value }] } }],
});

for (const testCase of [
  { name: "computed count with any label", snapshot: metricSnapshot(), pass: true },
  { name: "stale inspect value", snapshot: metricSnapshot({ value: 1 }), pass: false },
  { name: "static metric value", snapshot: metricSnapshot({ block: { type: "metric", label: "Done books", value: "2" } }), pass: false },
  { name: "wrong filter", snapshot: metricSnapshot({ block: { type: "metric", label: "Done books", collection: "books", count: true, where: { field: "status", equals: "reading" } } }), pass: false },
  { name: "wrong position", snapshot: { ...metricSnapshot(), layouts: [{ page_id: "reading-page", version: 2, document: { blocks: [{ type: "text", text: "Reading" }, { type: "metric", label: "Done books", collection: "books", count: true, where: { field: "status", equals: "done" } }] } }] }, pass: false },
  { name: "stored count disagrees", snapshot: metricSnapshot({ records: [{ status: "done" }, { status: "reading" }] }), pass: false },
] as const) test(`metric_count: ${testCase.name}`, () => {
  expect(gradeCheck(metricCheck as never, testCase.snapshot).pass).toBe(testCase.pass);
});

test("metric_count follows the task's schema choices instead of fixed field names or labels", () => {
  const check = { ...metricCheck, value: { collection: "books", where: { field: "state", equals: "finished" }, count: 2, position: "first" } };
  const snapshot = metricSnapshot({
    block: { type: "metric", label: "Completed reading", collection: "books", count: true, where: { field: "state", equals: "finished" } },
    records: [{ state: "finished" }, { state: "finished" }, { state: "queued" }],
  });
  expect(gradeCheck(check as never, snapshot).pass).toBe(true);
});

test("reading metric seed defects are harness errors", () => {
  const task = validateTask(metricTaskJson); const layout = { blocks: [{ type: "list", title: "Books", collection: "books" }] };
  const tools = [{ page_id: "home", name: "list_books", operation: "list", collection: "books" }];
  const records = [
    { page_id: "home", id: "b1", collection: "books", data: { title: "A", status: "done" } },
    { page_id: "home", id: "b2", collection: "books", data: { title: "B", status: "done" } },
    { page_id: "home", id: "b3", collection: "books", data: { title: "C", status: "reading" } },
  ];
  const valid = { tool_versions: tools, records, layouts: [{ page_id: "home", version: 1, document: layout }] };
  for (const [name, initial] of [
    ["one done book", { ...valid, records: records.map(row => row.id === "b2" ? { ...row, data: { ...row.data, status: "reading" } } : row) }],
    ["missing layout", { ...valid, layouts: [] }],
    ["wrong collection", { ...valid, records: records.map(row => ({ ...row, collection: "reading_list" })) }],
  ] as const) expect(gradeReference(task, { ...metricSnapshot(), initial }).status, name).toBe("harness_error");
});

test("detail_selects grades only the final stored layout", () => {
  const snapshot = detailSnapshot({ type: "detail", collection: "annotations", filter: { field: "run", equals: "run-002" } }, [annotation({ run: "run-002" })]);
  snapshot.layouts.push({ page_id: "review-page", version: 2, document: { blocks: [{ type: "list" }] } });
  expect(gradeCheck(judgeDetailCheck, snapshot).pass).toBe(false);
});

test("schema roundtrip accepts an agent-designed title field", () => {
  const check = { id: "roundtrip", type: "schema_roundtrip" as const, page: "p", value: ["synthetic note"] }; const pages = [{ id: "p1", alias: "p" }];
  const version = { page_id: "p1", name: "add_note", collection: "notes", operation: "insert", data_schema: { type: "object", properties: { title: { type: "string" } }, required: ["title"] } };
  const snapshot = { pages, tool_versions: [version], records: [{ page_id: "p1", collection: "notes", data: { title: "synthetic note" } }], results: [{ page_id: "p1", tool: "achilles__add_note", success: true, data: { title: "synthetic note" } }] };
  expect(gradeCheck(check, snapshot).pass).toBe(true);
  expect(gradeCheck(check, { ...snapshot, tool_versions: [{ ...version, data_schema: { type: "object", properties: { text: { type: "string" } } } }] }).pass).toBe(false);
});

const readingTransition = { id: "update", type: "updated_record" as const, page: "p", chat: "c", value: "Synthetic Book", transition: { before: ["unread", "want_to_read"], after: ["read", "finished"] } };
const readingSnapshot = (inserted: Record<string, string>, final: Record<string, string>) => {
  const pages = [{ id: "p1", alias: "p" }];
  const properties = Object.fromEntries(Object.keys(inserted).filter(field => field !== "record_id").map(field => [field, { type: "string" }]));
  const schema = { type: "object", properties };
  const tool_versions = ["insert", "update", "list"].map(operation => ({ page_id: "p1", name: `${operation}_book`, collection: "books", operation, data_schema: schema }));
  const result = (operation: string, data: object) => ({ page_id: "p1", chat_id: "c", tool: `achilles__${operation}_book`, success: true, data });
  return { pages, tool_versions, results: [result("insert", inserted), result("update", final), result("list", { records: [final] })] };
};

test("reading transition accepts schema-shaped want_to_read to finished and unread to read", () => {
  expect(gradeCheck(readingTransition, readingSnapshot({ record_id: "book-1", title: "Synthetic Book", progress: "want_to_read" }, { record_id: "book-1", title: "Synthetic Book", progress: "finished" })).pass).toBe(true);
  expect(gradeCheck(readingTransition, readingSnapshot({ record_id: "book-1", title: "Synthetic Book", state: "unread" }, { record_id: "book-1", title: "Synthetic Book", state: "read" })).pass).toBe(true);
});

test("reading transition rejects unrelated, unmapped, identity, and split field changes", () => {
  const grade = (inserted: Record<string, string>, final: Record<string, string>) => gradeCheck(readingTransition, readingSnapshot(inserted, final));
  expect(grade({ record_id: "book-1", title: "Synthetic Book", progress: "unread", format: "paper" }, { record_id: "book-1", title: "Synthetic Book", progress: "unread", format: "ebook" }).pass, "an unrelated format change is not the requested transition").toBe(false);
  const unmapped = grade({ record_id: "book-1", title: "Synthetic Book", progress: "unread" }, { record_id: "book-1", title: "Synthetic Book", progress: "bogus" });
  expect(unmapped.pass, "an unmapped final value is not the requested transition").toBe(false);
  expect(unmapped.reason).toBe("unmapped_after_value: progress=unread->bogus");
  expect(grade({ record_id: "book-1", title: "Synthetic Book", progress: "unread" }, { record_id: "book-1", title: "Other", progress: "read" }).pass, "changing the identity cannot satisfy the transition").toBe(false);
  expect(grade({ record_id: "book-1", title: "Synthetic Book", progress: "unread", completion: "pending" }, { record_id: "book-1", title: "Synthetic Book", progress: "unread", completion: "read" }).pass, "before and after values must use one field").toBe(false);
});

test("page-aware approvals and strict route checks do not accept other pages", () => {
  const t = validateTask({ ...task, steps: [{ ...task.steps[0], prompt: "work on /wanted" }], checks: [{ id: "approval", type: "count", page: "p", name: "approvals", count: 1 }, { id: "route", type: "page_exists", page: "p", route: "/wanted" }] });
  const failed = gradeTask(t, { pages: [{ id: "p1", alias: "p", route: "/wrong" }], approvals: [{ page_id: "other" }] });
  expect(failed.checks.every(check => !check.pass)).toBe(true);
});

test("page counts use the resolved id while other collections stay page-owned", () => {
  const pages = [{ id: "p1", alias: "p" }, { id: "p2" }];
  expect(gradeCheck({ id: "pages", type: "count", page: "p", name: "pages", count: 1 }, { pages }).pass).toBe(true);
  expect(gradeCheck({ id: "tools", type: "count", page: "p", name: "tools", count: 1 }, { pages, tools: [{ id: "t1", page_id: "p2" }] }).pass).toBe(false);
});

test("reserved tool refusal requires target-validator proof and structured name errors when available", () => {
  const check = { id: "refused", type: "refused_tool_name" as const, page: "p", name: "create_tool" }; const pages = [{ id: "p1", alias: "p" }];
  const grade = (data: unknown, valid: boolean) => gradeCheck(check, { pages, calls: [{ id: "call-1", page_id: "p1", tool: "achilles__create_tool", arguments: { bundle: { name: "create_tool" } } }], results: [{ call_id: "call-1", page_id: "p1", success: false, data }], bundle_validations: [{ call_id: "call-1", valid }] }).pass;
  expect(grade("synthetic unstructured failure", true)).toBe(true);
  expect(grade("synthetic unstructured failure", false)).toBe(false);
  expect(grade({ code: "invalid_input", path: "/bundle/name", expected: "changed product wording" }, true)).toBe(true);
  expect(grade({ code: "invalid_input", path: "/bundle/input_schema", expected: "object" }, true)).toBe(false);
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
  const check = { id: "updated", type: "updated_record" as const, page: "p", chat: "reading-chat", value: "Synthetic Book", transition: { before: ["unread"], after: ["read"] } };
  const data_schema = { type: "object", properties: { title: { type: "string" }, status: { type: "string" } } };
  const tool_versions = [{ page_id: "p1", name: "add_book", collection: "books", operation: "insert", data_schema }, { page_id: "p1", name: "update_book", collection: "books", operation: "update", data_schema }, { page_id: "p1", name: "list_books", collection: "books", operation: "list", data_schema }];
  const result = (tool: string, record_id: string, data: object) => ({ page_id: "p1", chat_id: "reading-chat", tool, success: true, data: { ...data, record_id } });
  const insertA = result("achilles__add_book", "a", { title: "Synthetic Book", status: "unread" });
  const updateB = result("achilles__update_book", "b", final); const readB = { page_id: "p1", chat_id: "reading-chat", tool: "achilles__list_books", success: true, data: { records: [{ ...final, record_id: "b" }] } };
  expect(gradeCheck(check, { pages, tool_versions, results: [insertA, updateB, readB] }).pass).toBe(false);
  const updateA = result("achilles__update_book", "a", final); const readA = { ...readB, data: { records: [{ ...final, record_id: "a" }] } };
  expect(gradeCheck(check, { pages, tool_versions, results: [insertA, updateA, readA] }).pass).toBe(true);
});

test("exact page records reject extra writes and accept task values in an agent-chosen field", () => {
  const pages = [{ id: "p1", alias: "p" }]; const page = (data: object) => ({ page_id: "p1", data });
  const notes = { id: "notes", type: "records_exact" as const, page: "p", value: [{ text: "reconnect note" }] };
  expect(gradeCheck(notes, { pages, records: [page({ text: "reconnect note" })] }).pass).toBe(true);
  expect(gradeCheck(notes, { pages, records: [page({ text: "reconnect note" }), page({ text: "wrong extra note" })] }).pass).toBe(false);
  const crud = { id: "crud", type: "records_exact" as const, page: "p", value: [["record-1", "done"], ["record-2"]] };
  const records = [page({ name: "record-2" }), page({ name: "record-1", status: "done" })];
  expect(gradeCheck(crud, { pages, records }).pass).toBe(true);
  expect(gradeCheck(crud, { pages, records: [...records, page({ name: "wrong" })] }).pass).toBe(false);
  const listed = { id: "list", type: "successful_result" as const, page: "p", tool: "achilles__list_records", value: crud.value };
  expect(gradeCheck(listed, { pages, results: [{ page_id: "p1", tool: listed.tool, success: true, data: records.map(row => row.data) }] }).pass).toBe(true);
});

test("layout_update requires the original layout and one versioned block", () => {
  const pages = [{ id: "p1", alias: "p" }];
  const original = [{ type: "text", text: "Records dashboard" }];
  const check = { id: "layout", type: "layout_update" as const, page: "p", value: { original: { blocks: original }, added: { type: "list", collection: "records" }, version: 2 } };
  const good = { pages, layouts: [{ page_id: "p1", version: 1, document: { blocks: original } }, { page_id: "p1", version: 2, document: { blocks: [...original, { type: "list", collection: "records" }] } }] };
  expect(gradeCheck(check, good).pass).toBe(true);
  expect(gradeCheck(check, { ...good, layouts: [...good.layouts.slice(0, 1), { page_id: "p1", version: 2, document: { blocks: [{ type: "list", collection: "other" }] } }] }).pass).toBe(false);
  expect(gradeCheck(check, { ...good, layouts: [...good.layouts, { page_id: "other", version: 2, document: { blocks: [] } }] }).pass).toBe(false);
});

test("layout failures require a later successful update", () => {
  const pages = [{ id: "p1", alias: "p" }];
  const check = { id: "retry", type: "no_unrecovered_error" as const, page: "p" };
  const failed = { page_id: "p1", chat_id: "c", tool: "achilles__update_layout", success: false };
  const succeeded = { page_id: "p1", chat_id: "c", tool: "achilles__update_layout", success: true };
  const grade = (results: typeof failed[]) => gradeCheck(check, { pages, results, errors: results.filter(result => !result.success) }).pass;
  expect(grade([failed, succeeded])).toBe(true);
  expect(grade([succeeded, failed])).toBe(false);
  expect(grade([failed])).toBe(false);
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

test("assigned_tools_only rejects calls to tools the page does not assign", () => {
  const check = { id: "assigned", type: "assigned_tools_only" as const, page: "p" };
  const base = { pages: [{ id: "p1", alias: "p" }], tool_versions: [{ page_id: "p1", name: "add_contact" }, { page_id: "other", name: "delete_all" }] };
  const grade = (...tools: string[]) => gradeCheck(check, { ...base, calls: tools.map(tool => ({ page_id: "p1", tool })) });
  const rows: Array<[string, ReturnType<typeof grade>, boolean]> = [
    ["assigned tool only", grade("achilles__add_contact"), true],
    ["tool discovery is allowed", grade("mcp_discover", "achilles__add_contact"), true],
    ["page read is allowed", grade("achilles__inspect_page", "achilles__add_contact"), true],
    ["authoring tool attempt", grade("achilles__create_tool", "achilles__add_contact"), false],
    ["another page's tool", grade("achilles__delete_all"), false],
    ["host tool", grade("bash"), false],
  ];
  for (const [name, result, pass] of rows) expect(result.pass, `${name}: ${result.reason}`).toBe(pass);
  expect(gradeCheck(check, { ...base, calls: [{ page_id: "other", tool: "achilles__create_tool" }] }).pass).toBe(true);
});

test("no_new_page fails only on a page id that was not in the initial snapshot", () => {
  const task = validateTask(createModeOffTaskJson);
  const good = createModeOffReferences.good as never as EvalSnapshot;
  const failing = (snapshot: EvalSnapshot) => gradeReference(task, snapshot).checks.filter(check => !check.pass).map(check => `${check.id}: ${check.reason}`);
  const rows: Array<[string, EvalSnapshot, string[]]> = [
    ["same pages", good, []],
    ["new page", { ...good, pages: [...good.pages!, { id: "page-movies", route: "/movies" }] }, ["no-new-page: new pages: /movies"]],
    ["page removed", { ...good, initial: { ...good.initial!, pages: [...good.initial!.pages!, { id: "page-old", route: "/old" }] } }, []],
  ];
  for (const [name, snapshot, expected] of rows) expect(failing(snapshot), name).toEqual(expected);
  expect(gradeCheck(task.checks.find(check => check.type === "no_new_page")!, { ...good, initial: undefined }).reason).toBe("no initial snapshot to compare pages with");
});

test("layout_restore requires a restore_version that appends a copy of v1", () => {
  const check = { id: "restored", type: "layout_restore" as const, page: "p" };
  const v1 = { blocks: [{ type: "text", text: "Team tasks" }, { type: "list", title: "All tasks", collection: "tasks" }] };
  const v2 = { blocks: [{ type: "metric", label: "Tasks", collection: "tasks", count: true }, { type: "list", title: "All tasks", collection: "tasks" }] };
  const layout = (version: number, document: unknown) => ({ page_id: "p1", version, document });
  const update = (version: number) => ({ page_id: "p1", tool: "achilles__update_layout", success: true, data: { version } });
  const restore = (version: number) => ({ page_id: "p1", tool: "achilles__restore_version", success: true, data: { kind: "layout", version, restored_from: 1 } });
  const grade = (active: number, layouts: unknown[], results: unknown[]) => gradeCheck(check, { pages: [{ id: "p1", alias: "p", active_layout_version: active }], layouts, results } as never);
  const rows: Array<[string, ReturnType<typeof grade>, boolean]> = [
    ["restore appends v1 copy", grade(3, [layout(1, v1), layout(2, v2), layout(3, v1)], [update(2), restore(3)]), true],
    ["layout restore then a tool restore", grade(3, [layout(1, v1), layout(2, v2), layout(3, v1)], [update(2), restore(3), { page_id: "p1", tool: "achilles__restore_version", success: true, data: { kind: "tool", version: 3, restored_from: 1 } }]), true],
    ["hand rebuild with update_layout", grade(3, [layout(1, v1), layout(2, v2), layout(3, v1)], [update(2), update(3)]), false],
    ["restore then another change", grade(4, [layout(1, v1), layout(2, v2), layout(3, v1), layout(4, v2)], [update(2), restore(3), update(4)]), false],
    ["restore to the wrong version", grade(3, [layout(1, v1), layout(2, v2), layout(3, v2)], [update(2), restore(3)]), false],
    ["no change before the undo", grade(2, [layout(1, v1), layout(2, v1)], [restore(2)]), false],
    ["active pointer moved back instead of appending", grade(1, [layout(1, v1), layout(2, v2)], [update(2), restore(1)]), false],
    ["history rewritten", grade(3, [layout(1, v1), layout(3, v1)], [update(2), restore(3)]), false],
    ["restore result names another version", grade(3, [layout(1, v1), layout(2, v2), layout(3, v1)], [update(2), restore(2)]), false],
    ["superset of v1 is not a copy", grade(3, [layout(1, v1), layout(2, v2), layout(3, { blocks: [...v1.blocks, { type: "text", text: "x" }] })], [update(2), restore(3)]), false],
  ];
  for (const [name, result, pass] of rows) expect(result.pass, `${name}: ${result.reason}`).toBe(pass);
});

test("user write steps grade the agent only after the user write bumped the revision", () => {
  const staleTask = validateTask(staleRevisionTaskJson);
  const { good, bad } = staleRevisionReferences as unknown as { good: Record<string, any>; bad: Record<string, any> };
  const withWrite = (write: Record<string, unknown> | undefined) => ({ ...good, user_writes: write ? [{ ...good.user_writes[0], ...write }] : [] });
  const rows: Array<[string, Record<string, any>, string]> = [
    ["user edit kept after a recovered conflict", good, "pass"],
    ["lost update puts the status back", bad, "agent_fail"],
    ["user write rejected", withWrite({ ok: false, status: 409, revision_after: null }), "harness_error"],
    ["user write did not bump the revision", withWrite({ revision_after: 1 }), "harness_error"],
    ["user write never ran", withWrite(undefined), "harness_error"],
    ["turn cap hit before the user write ran", { pages: good.pages, initial: good.initial, user_writes: [], results: [], records: [{ page_id: "p", collection: "books", id: "dune", data: { title: "Dune", status: "reading", pages: 400 } }], turns: staleTask.agent_turns }, "agent_fail"],
    ["last update_book failed after a later read", { ...good, results: [...good.results.slice(0, 2), { ...good.results[0] }, good.results[1]] }, "agent_fail"],
  ];
  for (const [name, snapshot, status] of rows) expect(gradeReference(staleTask, snapshot).status, name).toBe(status);
  expect(gradeReference(staleTask, good).diagnostics.conflict_seen).toBe(true);
  expect(gradeReference(staleTask, { ...good, results: good.results.slice(1) }).diagnostics.conflict_seen).toBe(false);
  expect(() => validateTask({ ...staleRevisionTaskJson, checks: [...staleRevisionTaskJson.checks, { id: "answer", type: "answer_mentions", page: "books", step: "form-edit", value: ["Dune"] }] })).toThrow("names step form-edit, which is not a prompt step");
  expect(() => validateTask({ ...staleRevisionTaskJson, steps: [{ id: "w", kind: "user_write", page: "books", chat: "form", tool: "update_book", arguments: { record_id: "dune", revision: 1 } }] })).toThrow("no revision");
});

test("answer_mentions matches any value case-insensitively as a whole token", () => {
  const rows: Array<[string, string, boolean]> = [
    ["3 of your 5 books are done", "3", true],
    ["You have **3** finished books.", "3", true],
    ["done: 3.", "3", true],
    ["3/5 are done", "3", true],
    ["THREE books are done", "three", true],
    ["Three.", "three", true],
    ["120 books", "12", false],
    ["312 books", "12", false],
    ["12.5 books", "12", false],
    ["1,120 books", "120", false],
    ["the 12th book", "12", false],
    ["v12 shipped", "12", false],
    ["threefold", "three", false],
    ["thirty-three books", "three", false],
    ["5", "3", false],
  ];
  for (const [answer, value, expected] of rows) expect(mentions(answer, value), `${JSON.stringify(value)} in ${JSON.stringify(answer)}`).toBe(expected);
  const task = validateTask(countTaskJson); const check = task.checks.find(item => item.type === "answer_mentions")!;
  const grade = (answers?: Record<string, string>) => gradeCheck(check, { pages: [{ id: "home", alias: "books" }], answers });
  expect(grade({ ask: "3 of your 5 books are done" }).pass).toBe(true);
  expect(grade({ ask: "three are done" }).pass).toBe(true);
  expect(grade({ ask: "5" }).pass).toBe(false);
  expect(grade({ ask: "13 are done" }).pass).toBe(false);
  expect(grade(undefined).reason).toBe("no final answer captured for step ask");
});

test("answer_mentions only expects facts the seeded records hold, on a real prompt step", () => {
  const withCheck = (check: Record<string, unknown>) => () => validateTask({ ...countTaskJson, checks: [{ id: "answer", type: "answer_mentions", page: "books", step: "ask", ...check }] });
  expect(withCheck({ value: ["5", "five", "Dune", "dune"] })).not.toThrow();
  expect(withCheck({ value: ["4"] })).toThrow("not a seeded record value or count");
  expect(withCheck({ value: ["four"] })).toThrow("not a seeded record value or count");
  expect(withCheck({ value: ["Neuromancer"] })).toThrow("not a seeded record value or count");
  expect(withCheck({ value: ["3"], step: "missing" })).toThrow("names step missing");
  expect(withCheck({ value: [] })).toThrow("needs a step and non-empty mention values");
});

test("a denied step accepts only ask-mode prompt steps, and approval max bounds the retries", () => {
  const step = deniedTaskJson.steps[0];
  const withStep = (change: Record<string, unknown>, mode = "ask") => () => validateTask({ ...deniedTaskJson, approval_mode: mode, steps: [{ ...step, ...change }] });
  expect(withStep({})).not.toThrow();
  expect(withStep({}, "allow")).toThrow("approval_mode ask");
  const { approval_mode: _, ...noMode } = deniedTaskJson;
  expect(() => validateTask(noMode)).toThrow("approval_mode ask");
  expect(withStep({ approval: "maybe" })).toThrow("approve, deny, or");
  expect(withStep({ kind: "reconnect", prompt: undefined })).toThrow("approve, deny, or");
  expect(withStep({ approval: { tool: "achilles__add_note", decisions: ["approve", "deny"] } })).not.toThrow();
  expect(withStep({ approval: { tool: "achilles__add_note", decisions: [] } })).toThrow("{ tool, decisions }");
  expect(withStep({ approval: { tool: "achilles__add_note", decisions: ["skip"] } })).toThrow("{ tool, decisions }");
  expect(withStep({ approval: { tool: "add_note", decisions: ["deny"] } })).toThrow("{ tool, decisions }");
  expect(withStep({ approval: { tool: "achilles__add_note", decisions: ["deny"], extra: 1 } })).toThrow("unknown key extra");
  expect(withStep({ approval: { tool: "achilles__add_note", decisions: ["deny"] } }, "allow")).toThrow("approval_mode ask");
  const withCheck = (change: Record<string, unknown>) => () => validateTask({ ...deniedTaskJson, checks: [{ id: "a", type: "approval", page: "notes", tool: "achilles__add_note", ...change }] });
  expect(withCheck({ max: 0 })).toThrow("count or max");
  expect(withCheck({ max: 2, count: 1 })).toThrow("count or max");
  expect(() => validateTask({ ...deniedTaskJson, checks: [{ id: "r", type: "records_exact", page: "notes", value: [], max: 2 }] })).toThrow("only approval takes max");
  const denied = validateTask(deniedTaskJson); const good = deniedReferences.good as Record<string, any>;
  for (const [count, status] of [[0, "agent_fail"], [1, "pass"], [2, "pass"], [3, "agent_fail"]] as const) {
    const snapshot = { ...good, approvals: Array.from({ length: count }, () => good.approvals[0]) };
    expect(gradeReference(denied, snapshot).status, `${count} approvals`).toBe(status);
  }
});

test("form_submit passes on one new record and names the field a chat-only form needs", () => {
  const check = validateTask(readingListTaskJson).checks.find(item => item.type === "form_submit")!;
  expect(check.required).toBe(false);
  const graded = (rows: Array<Record<string, unknown>>) => gradeCheck(check, { pages: [{ id: "reading-id", alias: "reading" }], form_submits: rows.map(row => ({ page_id: "reading-id", tool: "add_book", collection: "books", ...row })) });
  expect(graded([{ status: 200, new_records: 1 }]).pass).toBe(true);
  const chatOnly = graded([{ unsupported: "tags" }]);
  expect(chatOnly.pass).toBe(false);
  expect(chatOnly.reason).toContain("this form needs the chat");
  expect(chatOnly.evidence).toMatchObject({ tool: "add_book", field: "tags" });
  expect(graded([{ status: 200, new_records: 2 }]).reason).toContain("added 2 records");
  expect(graded([{ status: 200, new_records: 0 }]).pass).toBe(false);
  expect(graded([{ status: 422, error: "submit failed (422)" }]).pass).toBe(false);
  expect(graded([]).reason).toBe("the page has no insert form");
});

test("form_submit needs a value map of input strings", () => {
  const withValue = (value: unknown) => () => validateTask({ ...readingListTaskJson, checks: [{ id: "form", type: "form_submit", page: "reading", value }] });
  expect(withValue({ string: "Form Book", integer: "2" })).not.toThrow();
  expect(withValue(undefined)).toThrow("needs value");
  expect(withValue({ integer: "2" })).toThrow("string value");
  expect(withValue({ string: "x", integer: "2.5" })).toThrow("integer string");
  expect(withValue({ string: "x", date: "2026" })).toThrow("unknown key date");
});

test("approval_outcomes grades targets, denied retries, and untouched records from the approvals log", () => {
  const task = validateTask(bulkEditTaskJson); const good = bulkEditReferences.good as EvalSnapshot & Record<string, any>;
  const grade = (snapshot: EvalSnapshot) => gradeCheck(task.checks[0], snapshot);
  expect(grade(good).pass).toBe(true);
  const records = (change: (row: Record<string, any>) => void) => good.records!.map(row => { const copy = structuredClone(row); change(copy); return copy; });
  expect(grade({ ...good, records: records(row => { if (row.id === "t-02") row.data.status = "escalated"; }) }).reason).toBe("record t-02 changed without an approved write");
  expect(grade({ ...good, records: records(row => { if (row.id === "t-05") row.data.status = "escalated"; }) }).reason).toBe("record t-05 changed without an approved write");
  expect(grade({ ...good, records: records(row => { if (row.id === "t-07") row.data.status = "open"; }) }).reason).toContain("approved record t-07 does not have");
  expect(grade({ ...good, calls: good.calls!.map(call => call.id === "update-0" ? { ...call, arguments: { status: "escalated" } } : call) }).reason).toContain("has no record_id");
  expect(grade({ ...good, approvals: good.approvals!.filter(row => !["update-2", "update-4"].includes(String(row.request_id))) }).reason).toBe('asked to write ["t-01","t-04"], expected ["t-01","t-04","t-07"]');
  const withValue = (value: unknown) => () => validateTask({ ...bulkEditTaskJson, checks: [{ ...bulkEditTaskJson.checks[0], value }] });
  expect(withValue({ records: ["t-01", "t-99"], set: { status: "escalated" } })).toThrow("not seeded in tickets");
  expect(withValue({ records: ["t-01"], set: { status: "archived" } })).toThrow("without a prompt quote");
  expect(withValue({ records: [], set: { status: "escalated" } })).toThrow("unique record ids");
  expect(withValue({ records: ["t-01"], set: {} })).toThrow("non-empty set");
});

test("list_shows fields need the exact column order and a prompt or schema source", () => {
  const check = { id: "cols", type: "list_shows" as const, page: "tickets", collection: "tickets", fields: ["title", "status"] };
  const snapshot = (fields: string[]) => ({ pages: [{ id: "home", alias: "tickets" }], layouts: [{ page_id: "home", version: 2, document: { blocks: [{ type: "list", title: "T", collection: "tickets", fields }] } }] });
  expect(gradeCheck(check, snapshot(["title", "status"])).pass).toBe(true);
  expect(gradeCheck(check, snapshot(["status", "title"])).reason).toContain("in that order");
  expect(gradeCheck(check, snapshot(["title", "status", "priority"])).pass).toBe(false);
  const withCheck = (change: Record<string, unknown>) => () => validateTask({ ...bulkEditTaskJson, checks: [{ ...check, ...change }] });
  expect(withCheck({})).not.toThrow();
  expect(withCheck({ fields: ["title", "owner"] })).toThrow("list field \"owner\"");
  expect(withCheck({ collection: undefined, value: "Login page times out" })).toThrow("fields must be a list_shows check");
  expect(withCheck({ type: "record", value: {} })).toThrow("fields must be a list_shows check");
});

test("no_duplicate_writes names two records that share the checked fields even when the calls differ", () => {
  const check = { id: "dup", type: "no_duplicate_writes" as const, page: "p", tool: "achilles__add_contact", collection: "contacts", fields: ["email"] };
  const snapshot: EvalSnapshot = { pages: [{ id: "home", alias: "p" }], calls: [
    { page_id: "home", tool: "achilles__add_contact", success: true, arguments: { name: "Ada", email: "ada@example.test" } },
    { page_id: "home", tool: "achilles__add_contact", success: true, arguments: { name: "Ada L", email: "ada@example.test" } },
  ], records: [
    { page_id: "home", collection: "contacts", id: "r1", data: { name: "Ada", email: "ada@example.test" } },
    { page_id: "home", collection: "contacts", id: "r2", data: { name: "Ada L", email: "ada@example.test" } },
  ] };
  expect(gradeCheck(check, snapshot).reason).toBe('2 contacts records share email = ["ada@example.test"]');
  expect(gradeCheck(check, { ...snapshot, records: snapshot.records!.slice(0, 1) }).pass).toBe(true);
});

test("a browser task cannot mix protocol prompts, and a reload names its trigger tool", () => {
  const base = { id: "b", page_plan: [{ alias: "p", source: "fixture", bind_chat: true, create_mode: false }], agent_turns: 4, checks: [{ id: "e", type: "no_error", page: "p" }] };
  const browser = { id: "s1", kind: "browser_prompt", page: "p", chat: "c", prompt: "hi", reload: { on: "tool_start", tool: "achilles__x" } };
  expect(() => validateTask({ ...base, steps: [browser] })).not.toThrow();
  expect(() => validateTask({ ...base, steps: [browser, { id: "s2", kind: "prompt", page: "p", chat: "c", prompt: "again" }] })).toThrow("cannot also have prompt");
  expect(() => validateTask({ ...base, steps: [{ ...browser, reload: { on: "tool_start" } }] })).toThrow("tool_start requires one");
});

test("a prompt step of an ask task can write or steer during its turn, at the n-th approval request of a tool", () => {
  const base = { id: "during-task", approval_mode: "ask", page_plan: [{ alias: "p", source: "fixture", bind_chat: true, create_mode: false }], agent_turns: 4, checks: [{ id: "c", type: "no_error", page: "p" }] };
  const step = { id: "s1", kind: "prompt", page: "p", chat: "c", prompt: "add 50 to every budget" };
  const write = { tool: "achilles__update_project", user_write: { tool: "update_project", arguments: { record_id: "p-4", budget: 180 } } };
  expect(validateTask({ ...base, steps: [{ ...step, during: write }] }).steps[0].during).toEqual(write);
  expect(validateTask({ ...base, steps: [{ ...step, during: { tool: "achilles__update_task", nth: 2, steer: "use paused" } }] }).steps[0].during?.steer).toBe("use paused");
  expect(() => validateTask({ ...base, approval_mode: "allow", steps: [{ ...step, during: write }] })).toThrow("approval_mode ask");
  expect(() => validateTask({ ...base, steps: [{ ...step, during: { ...write, steer: "and steer" } }] })).toThrow("exactly one of user_write, steer, or restart_zeta");
  expect(() => validateTask({ ...base, steps: [{ ...step, during: { ...write, user_write: { tool: "update_project", arguments: { record_id: "p-4", revision: 1 } } } }] })).toThrow("no revision");
  // the value a scripted user write stores may be graded in the answer, like a seeded value
  expect(() => validateTask({ ...base, steps: [{ ...step, during: write }], checks: [{ id: "told", type: "answer_mentions", page: "p", step: "s1", value: ["180"] }] })).not.toThrow();
});

test("a restart_zeta step and a provider_error step validate their shapes", () => {
  const base = { id: "fault-task", approval_mode: "ask", page_plan: [{ alias: "p", source: "fixture", bind_chat: true, create_mode: false }], agent_turns: 4, checks: [{ id: "c", type: "no_error", page: "p" }] };
  const step = { id: "s1", kind: "prompt", page: "p", chat: "c", prompt: "add the contacts" };
  expect(validateTask({ ...base, steps: [{ ...step, during: { tool: "achilles__add_contact", nth: 3, restart_zeta: true } }] }).steps[0].during?.restart_zeta).toBe(true);
  expect(() => validateTask({ ...base, steps: [{ ...step, during: { tool: "achilles__add_contact", restart_zeta: false } }] })).toThrow("restart_zeta must be true");
  expect(validateTask({ ...base, steps: [{ ...step, provider_error: { status: 529, times: 5 } }] }).steps[0].provider_error).toEqual({ status: 529, times: 5 });
  expect(() => validateTask({ ...base, steps: [{ ...step, provider_error: { status: 200, times: 1 } }] })).toThrow("HTTP error status");
});

test("restart_recovery needs the same chat back, every earlier row, a finished turn, and an answer naming what existed", () => {
  const check = { id: "r", type: "restart_recovery", page: "p", step: "resume", collection: "contacts", fields: ["name"] } as const;
  const restart = { page_id: "page-1", action: "restart_zeta", ok: true, original_session_id: "s", resumed_session_id: "s", history_continuity: true, records_before: [{ collection: "contacts", id: "r1", data: { name: "Ada Lovelace" } }] };
  const snapshot = (row: Record<string, unknown>, answer?: string): EvalSnapshot => ({ pages: [{ id: "page-1", alias: "p" }], interjections: [row], answers: answer === undefined ? {} : { resume: answer } });
  expect(gradeCheck(check, snapshot(restart, "Ada Lovelace was already added before the restart; I added the other four.")).pass).toBe(true);
  expect(gradeCheck(check, snapshot(restart, "all five contacts are added")).reason).toContain("does not say Ada Lovelace existed");
  expect(gradeCheck(check, snapshot(restart)).reason).toContain("no turn finished after the restart");
  const twice = { ...snapshot(restart, "I added Ada Lovelace and the others"), records: [1, 2].map(n => ({ page_id: "page-1", collection: "contacts", id: `r${n}`, data: { name: "Ada Lovelace" } })) };
  expect(gradeCheck(check, twice).reason).toContain("redid Ada Lovelace");
  expect(gradeCheck(check, snapshot({ ...restart, history_continuity: false }, "Ada Lovelace")).reason).toContain("rows from before the restart are missing");
  expect(gradeCheck(check, snapshot({ ...restart, resumed_session_id: "other" }, "Ada Lovelace")).reason).toContain("different session");
});

test("overwrite_disclosed passes a kept user value or a told overwrite, and fails a silent overwrite", () => {
  const check = { id: "o", type: "overwrite_disclosed", page: "p", step: "set", collection: "tasks", value: { field: "priority", agent_value: "high" } } as const;
  const snapshot = (priority: string, answer: string): EvalSnapshot => ({ pages: [{ id: "page-1", alias: "p" }], answers: { set: answer }, interjections: [{ step: "set", action: "user_write", page_id: "page-1", arguments: { record_id: "t-2", priority: "low" } }], records: [{ page_id: "page-1", collection: "tasks", id: "t-2", data: { title: "Ship docs", priority } }] });
  expect(gradeCheck(check, snapshot("low", "someone set it to low first, so I left it")).pass).toBe(true);
  expect(gradeCheck(check, snapshot("high", "it had just been changed to low; I set it to high as you asked")).pass).toBe(true);
  expect(gradeCheck(check, snapshot("high", "done, Ship docs is now high")).reason).toContain("without saying so");
  expect(gradeCheck(check, snapshot("medium", "done")).reason).toContain("neither");
});

test("error_shown reads the failed turn row a chat renders", () => {
  const check = { id: "e", type: "error_shown", page: "p", value: 529 } as const;
  const base: EvalSnapshot = { pages: [{ id: "page-1", alias: "p" }] };
  expect(gradeCheck(check, { ...base, failed_turns: [{ page_id: "page-1", code: "backend_error", message: "Ollama HTTP 529: overloaded" }] }).pass).toBe(true);
  expect(gradeCheck(check, base).reason).toContain("no error with 529");
});
