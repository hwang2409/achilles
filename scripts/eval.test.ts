import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { assertTurnBudget, enforceTurnBudget, reserveTurns } from "./eval-protocol";
import { approvalDecision, classifyTaskSupport, createDecisionQueue, finalAnswer, parseHistory, relatedPages, scanArtifactTree, scanSecrets, selectTasks, stopsSuite, validateCatalog, validateReservedBundles, verifySetup } from "./eval";
import { gradeReference, validateTask, type TaskSetup } from "./eval-grade";

const targetRun = (target: string) => async (command: string, args: string[], cwd?: string) => {
  const python = command === "uv" && args[0] === "run" && !Bun.which("uv") ? args.slice(args.indexOf("python")) : [command, ...args];
  const process = Bun.spawn(python, { cwd, env: { ...Bun.env, PYTHONPATH: [join(target, "src"), target].join(delimiter) }, stdout: "pipe", stderr: "pipe" });
  return { exitCode: await process.exited, stdout: await new Response(process.stdout).text(), stderr: await new Response(process.stderr).text() };
};

async function waitForProcess(child: ReturnType<typeof Bun.spawn>, operation: string, timeoutMs: number) {
  const timedOut = await Promise.race([child.exited.then(() => false), Bun.sleep(timeoutMs).then(() => true)]);
  if (!timedOut) return child.exitCode!;
  for (const signal of ["SIGTERM", "SIGKILL"] as const) {
    try { process.kill(-child.pid, signal); } catch {}
    if (!await Promise.race([child.exited.then(() => true), Bun.sleep(5_000).then(() => false)])) continue;
    break;
  }
  throw new Error(`${operation} hung after ${timeoutMs / 1000} seconds; its process group was killed`);
}

test("scripted faults: a zeta restart mid-approval resumes the same chat, and a 529 run keeps its write and retries once", async () => {
  if (!Bun.which("uv")) return; // The web job reruns eval tests after installing uv.
  const target = resolve(new URL("..", import.meta.url).pathname); const root = await mkdtemp(join(tmpdir(), "achilles-faults-")); const tasks = join(root, "tasks"); let child: ReturnType<typeof Bun.spawn> | undefined;
  const restart = { id: "restart-scripted", page_plan: [{ alias: "tasks", source: "setup", bind_chat: true, create_mode: false }], agent_turns: 8, approval_mode: "ask", steps: [{ id: "add", kind: "prompt", page: "tasks", chat: "tasks-chat", prompt: "add_task each of these with the field title: Alpha, Beta, Gamma", during: { tool: "achilles__add_task", nth: 2, restart_zeta: true } }, { id: "resume", kind: "prompt", page: "tasks", chat: "tasks-chat", prompt: "continue" }], setup: { tools: [{ name: "add_task", operation: "insert", collection: "tasks" }], records: [] }, checks: [{ id: "records", type: "records_exact", page: "tasks", value: [{ title: "Alpha" }, { title: "Beta" }, { title: "Gamma" }] }, { id: "recovery", type: "restart_recovery", page: "tasks", step: "resume", collection: "tasks", fields: ["title"] }] };
  try {
    await mkdir(tasks); await Bun.write(join(tasks, "restart-scripted.json"), JSON.stringify(restart));
    await Bun.write(join(tasks, "provider-error-try-again.json"), await readFile(join(target, "evals/tasks/provider-error-try-again.json"), "utf8"));
    const revision = (await readFile(join(target, "zeta.rev"), "utf8")).trim(); const warmZeta = join(target, ".cache/zeta"); const runnerZeta = join(target, ".cache", `zeta-${revision}`);
    if (await Bun.file(join(warmZeta, ".git/HEAD")).exists() && !await Bun.file(join(runnerZeta, ".git/HEAD")).exists()) await symlink(warmZeta, runnerZeta, "dir").catch(error => { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; });
    child = Bun.spawn(["bun", "scripts/eval.ts", "--suite", "restart-scripted,provider-error-try-again"], { cwd: target, detached: true, env: { ...Bun.env, EVAL_BACKEND: "scripted", EVAL_SKIP_EXPLICIT_EXIT: "1", EVAL_SKIP_BROWSER_INSTALL: "1", EVAL_TASKS_DIR: tasks, REPORT_DIR: root, BASE: "none" }, stdout: "pipe", stderr: "pipe" });
    const stdout = new Response(child.stdout).text(); const stderr = new Response(child.stderr).text();
    const exitCode = await waitForProcess(child, "scripted fault eval", 150_000);
    expect(exitCode, `${await stdout}\n${await stderr}`).toBe(0);
    const report = JSON.parse(await readFile(join(root, "report.json"), "utf8")); const [restarted, faulted] = report.tasks;
    expect(restarted.status, JSON.stringify(restarted.checks)).toBe("pass");
    const row = JSON.parse(await readFile(join(root, restarted.transcript), "utf8")).interjections[0];
    expect(row).toEqual(expect.objectContaining({ action: "restart_zeta", ok: true, history_continuity: true, resumed_session_id: row.original_session_id }));
    expect(row.started_pid).not.toBe(row.killed_pid);
    expect(faulted.status, JSON.stringify(faulted.checks)).toBe("pass");
  } finally {
    if (child?.exitCode === null) { child.kill(); await Promise.race([child.exited, Bun.sleep(500)]); }
    await rm(root, { recursive: true, force: true });
  }
}, 160_000);

test("turn reservation is command-wide", () => {
  expect(reserveTurns([{ agent_turns: 20 }, { agent_turns: 20 }], 2)).toBe(80);
  expect(() => assertTurnBudget(241)).toThrow("command budget");
});

test("live turn budget allows the cap and aborts only excess work", async () => {
  let aborts = 0;
  const enforce = enforceTurnBudget(2, async () => { aborts += 1; });
  await enforce({ event: "turn_start" });
  await enforce({ event: "turn_start" });
  expect(aborts).toBe(0);
  await expect(enforce({ event: "turn_start" })).rejects.toThrow("limit exceeded");
  expect(aborts).toBe(1);
});

test("reserved bundle validation uses the target revision's validator after changing only the name", async () => {
  const valid = { format_version: 1, kind: "data_operation", name: "create_tool", description: "synthetic tool", input_schema: { type: "object", additionalProperties: true }, output_schema: { type: "object", additionalProperties: true, properties: { record_id: { type: "string" }, revision: { type: "integer" } }, required: ["record_id", "revision"] }, implementation: { operation: "insert", collection: "records", data_schema: { type: "object", additionalProperties: true } } };
  const invalid = [
    { ...valid, implementation: { ...valid.implementation, collection: "" } },
    { ...valid, input_schema: { type: "not-a-json-schema-type" } },
    { ...valid, extra: true },
    { ...valid, description: "x".repeat(10_000) },
  ];
  const bundles = [valid, ...invalid]; const calls = bundles.map((bundle, index) => ({ id: `call-${index}`, tool: "achilles__create_tool", arguments: { bundle } }));
  const results = calls.map(call => ({ call_id: call.id, success: false }));
  const target = Bun.env.ACHILLES_DIR ?? resolve(new URL("..", import.meta.url).pathname);
  const validations = await validateReservedBundles({ run: targetRun(target), achillesDir: target } as never, calls, results);
  expect(validations.map(row => row.valid)).toEqual([true, false, false, false, false]);
});

test("provider catalog is allow-only", () => {
  expect(() => validateCatalog(["mcp_discover", "achilles__create_tool"], "achilles__create_tool")).not.toThrow();
  expect(() => validateCatalog(["achilles__create_tool", "bash"])).toThrow("bash");
});

test("artifact scan fails closed on nested known secrets", async () => {
  const root = await mkdtemp(join(tmpdir(), "achilles-artifacts-"));
  try {
    await Bun.write(join(root, "safe.txt"), "safe");
    await scanArtifactTree(root, ["private"]);
    await Bun.write(join(root, "unsafe.txt"), "private");
    await expect(scanArtifactTree(root, ["private"])).rejects.toThrow("known secret");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("account and secret failures stop the suite", () => {
  expect(stopsSuite(new Error("OAuth credentials are invalid; login required"))).toBe(true);
  expect(stopsSuite(new Error('{"type":"usage_limit_reached"}'))).toBe(true);
  try { scanSecrets("Bearer abcdefghijklmnop", []); } catch (error) { expect(stopsSuite(error)).toBe(true); }
  expect(stopsSuite(new Error("task setup failed"))).toBe(false);
});

test("each step's answer is the last assistant text of its own turn", () => {
  const text = (value: string) => ({ role: "assistant", content: [{ type: "thinking", text: "hidden" }, { type: "text", text: value }] });
  const end = { role: "system", event: "served_turn_end" };
  const history = [
    { role: "user", content: [{ type: "text", text: "first" }] }, text("first answer"), end,
    { role: "user", content: [{ type: "text", text: "second" }] }, text("let me check"),
    { role: "assistant", content: [{ type: "tool_use", tool_call: { id: "t1", name: "achilles__list_books" } }] },
    { role: "tool_result", content: [{ type: "text", text: "[]" }], tool_result: { tool_call_id: "t1", content: "[]" } },
    // an assistant-role row carrying an event (defensive: no observed row shape does this today)
    // must still be excluded, or its text would wrongly win over "3 are done".
    text("3 are done"), { role: "assistant", event: "approval_end", content: [{ type: "text", text: "not an answer" }] }, end,
  ];
  expect(finalAnswer(history, 0)).toBe("first answer");
  expect(finalAnswer(history, 1)).toBe("3 are done");
  expect(finalAnswer([{ role: "user", content: [] }, { role: "assistant", content: [{ type: "tool_use" }] }, end], 0)).toBeUndefined();
});

test("parseHistory tags each result with the step whose turn made it", () => {
  const call = (id: string) => [{ role: "assistant", content: [{ type: "tool_use", tool_call: { id, name: "achilles__create_tool" } }] }, { role: "tool_result", tool_result: { tool_call_id: id, content: "{}" } }];
  const rows = [{ role: "user", content: [] }, ...call("t1"), { event: "served_turn_end" }, { role: "user", content: [] }, ...call("t2")];
  const { results } = parseHistory([{ chat: "c", page_id: "p", rows, starts: [{ step: "build", from: 0 }, { step: "add-action", from: 4 }] }]);
  expect(results.map(row => [row.call_id, row.step])).toEqual([["t1", "build"], ["t2", "add-action"]]);
});

test("a decision list answers the n-th request of its tool and approves the rest", () => {
  let n = 0; const next = () => n++; const rule = { tool: "achilles__update_ticket", decisions: ["approve", "deny"] as Array<"approve" | "deny"> };
  expect(["achilles__list_tickets", "achilles__update_ticket", "achilles__update_ticket", "achilles__update_ticket"].map(tool => approvalDecision(rule, tool, next))).toEqual(["approve", "approve", "deny", "approve"]);
  expect(approvalDecision("deny", "achilles__anything", next)).toBe("deny");
  expect(approvalDecision(undefined, "achilles__anything", next)).toBe("approve");
});

test("a during action finishes before its approval is answered, and later answers wait for it", async () => {
  const order: string[] = []; let release!: () => void; const errors: unknown[] = [];
  const enqueue = createDecisionQueue(error => errors.push(error));
  const first = enqueue(async () => { order.push("answer 1"); }, () => new Promise<void>(resolve => { release = () => { order.push("user write"); resolve(); }; }));
  const second = enqueue(async () => { order.push("answer 2"); });
  await Bun.sleep(10); expect(order).toEqual([]);
  release(); await Promise.all([first, second]);
  expect(order).toEqual(["user write", "answer 1", "answer 2"]);
  // a failed action reports once and does not answer its request; later requests still get answers
  await enqueue(async () => { order.push("answer 3"); }, async () => { throw new Error("write failed"); });
  await enqueue(async () => { order.push("answer 4"); });
  expect(order.slice(3)).toEqual(["answer 4"]); expect(errors.map(error => (error as Error).message)).toEqual(["write failed"]);
});
