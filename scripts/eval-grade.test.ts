import { expect, test } from "bun:test";
import { gradeTask, hostToolsGap, validateTask } from "./eval-grade";

const task = { id: "x-task", page_plan: [{ alias: "p", source: "fixture", bind_chat: true }], agent_turns: 2, judge: null, steps: [], checks: [{ id: "page", type: "page_exists", page: "p" }] };
test("task schema is closed and page writes need a bound page", () => {
  expect(validateTask(task).id).toBe("x-task");
  expect(() => validateTask({ ...task, extra: true })).toThrow("unknown key");
  expect(() => validateTask({ ...task, steps: [{ id: "write", kind: "insert", page: "missing" }] })).toThrow("unknown page");
});
test("grade checks use structured state and identify host tool gaps", () => {
  const snapshot = { pages: [{ id: "p1", alias: "p" }], calls: [{ name: "bash" }], errors: [], turns: 1 };
  expect(gradeTask(task, snapshot).pass).toBe(true);
  expect(hostToolsGap(snapshot)).toBe(true);
});
test("second-chat success requires a structured successful result", () => {
  const t = { ...task, checks: [{ id: "result", type: "successful_result", page: "p", chat: "a", tool: "achilles__list_notes" }] };
  expect(gradeTask(t, { pages: [{ id: "p1", alias: "p" }], results: [{ chat_id: "a", tool: "achilles__list_notes", success: true, data: { text: "seed" } }] }).pass).toBe(true);
  expect(gradeTask(t, { pages: [{ id: "p1", alias: "p" }], results: [{ chat_id: "a", tool: "achilles__list_notes", success: false }] }).pass).toBe(false);
});
