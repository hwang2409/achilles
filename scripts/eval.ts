import { mkdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { connectEvalProtocol, REQUIRED_FEATURES, assertTurnBudget, reserveTurns } from "./eval-protocol";
import { startEvalStack, TOOL_POLICY } from "./eval-stack";
import { diagnostics, gradeTask, validateTask, type EvalSnapshot, type EvalTask } from "./eval-grade";
import { makeReport, reportJson as renderReportJson, reportMarkdown as renderReportMarkdown } from "./eval-report";

export { startEvalStack, TOOL_POLICY } from "./eval-stack";
export { assertTurnBudget, reserveTurns, REQUIRED_FEATURES, connectEvalProtocol, enforceTurnBudget } from "./eval-protocol";
export type { EvalStackConfig, EvalStack } from "./eval-stack";
export const reportJson = (result: unknown) => {
  if (result && typeof result === "object" && "task" in result) return JSON.stringify(result, null, 2) + "\n";
  return renderReportJson(result as never);
};
export const reportMarkdown = (result: unknown) => {
  if (result && typeof result === "object" && "task" in result) {
    const value = result as { task: string; pass: boolean; provider: string; model: string; tool_policy: string; turns: number; error?: string };
    return `# achilles eval: ${value.task}\n\n- result: ${value.pass ? "pass" : "fail"}\n- model: ${value.provider}/${value.model}\n- tool set: \`${value.tool_policy}\`\n- observed turns: ${value.turns}\n${value.error ? `- error: ${value.error}\n` : ""}`;
  }
  return renderReportMarkdown(result as never);
};

const secrets = (value: string, hidden: string[]) => hidden.reduce((text, secret) => secret ? text.replaceAll(secret, "[REDACTED]") : text, value);
export function scanSecrets(value: string, hidden: string[] = []): void {
  if (hidden.some(secret => secret && value.includes(secret))) throw new Error("artifact contains a known secret");
  const scrubbed = secrets(value, hidden);
  if (/\b(?:sk-[A-Za-z0-9_-]{16,}|Bearer\s+[A-Za-z0-9._~+/=-]{12,}|gh[pousr]_[A-Za-z0-9_]{20,})\b/i.test(scrubbed)) throw new Error("artifact contains a secret-shaped value");
}

export async function loadTask(id: string, dir = new URL("../evals/tasks/", import.meta.url).pathname): Promise<EvalTask> {
  const value = JSON.parse(await readFile(join(dir, `${id}.json`), "utf8")) as unknown;
  const task = validateTask(value);
  if (task.id !== id) throw new Error(`task id ${task.id} does not match ${id}`);
  return task;
}

function scriptedSnapshot(task: EvalTask, events: Record<string, unknown>[], history: unknown[]): EvalSnapshot {
  const records = ["record-1", "record-2", "record-3"].map(id => ({ id, page_id: "page-data", data: { id } }));
  const results = records.map(record => ({ tool: "achilles__list_records", success: true, data: record.data, chat_id: "scripted-session" }));
  return { pages: [{ id: "page-data", alias: task.page_plan[0]?.alias ?? "data" }], tools: [{ id: "tool-list", page_id: "page-data", name: "list_records" }], records, calls: results.map(result => ({ name: result.tool, success: true })), results, turns: events.filter(event => event.event === "turn_start").length, wall_ms: 1, usage: "unavailable", errors: [], chats: [{ chat_id: "scripted-session" }], browser: [], assignments: [], collections: [], layouts: [], annotations: [], approvals: [], tool_policy: TOOL_POLICY, observed_catalog: ["achilles__list_records"], _history: history } as EvalSnapshot;
}

async function scriptedTask(task: EvalTask) {
  let sends = 0;
  const server = Bun.serve<{ ok: boolean }>({ port: 0, fetch(request, server) { if (server.upgrade(request, { data: { ok: true } })) return; return new Response("not found", { status: 404 }); }, websocket: { message(socket, raw) { const request = JSON.parse(String(raw)); if (request.method === "hello") socket.send(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { capabilities: { requests: REQUIRED_FEATURES } } })); else if (request.method === "new_session") socket.send(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { session: { session_id: "scripted-session" } } })); else if (request.method === "send") { sends++; socket.send(JSON.stringify({ jsonrpc: "2.0", method: "event", params: { event: "turn_start", session_id: "scripted-session", data: { turn: sends } } })); socket.send(JSON.stringify({ jsonrpc: "2.0", method: "event", params: { event: "tool_result", session_id: "scripted-session", data: { name: "achilles__list_records", is_error: false, content: [{ text: `record-${sends}` }] } } })); socket.send(JSON.stringify({ jsonrpc: "2.0", method: "event", params: { event: "served_turn_end", session_id: "scripted-session" } })); socket.send(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: {} })); } else if (request.method === "session_history") socket.send(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { messages: [{ role: "tool", name: "achilles__list_records", is_error: false }], next_offset: null } })); }, open() {}, close() {} } });
  try {
    const events: Record<string, unknown>[] = [];
    const client = await connectEvalProtocol({ url: `ws://127.0.0.1:${server.port}`, controller_token: "scripted-token" }, event => events.push(event));
    const session = await client.newSession({ cwd: "/private/page", mcp_bindings: [{ server: "achilles", headers: { Authorization: "Bearer synthetic-page-token" } }] });
    const sessionId = (session.session as { session_id: string }).session_id;
    await client.send(sessionId, "list all records");
    await client.send(sessionId, "confirm the remaining records");
    const history = await client.sessionHistory(sessionId);
    client.close();
    if (sends < 2 || !history.length) throw new Error("scripted task did not complete multiple steps");
      return gradeTask(task, scriptedSnapshot(task, events, history));
  } finally { server.stop(true); }
}

function databaseSnapshot(root: string): unknown {
  const result = Bun.spawnSync(["uv", "run", "python", "-c", "import json,sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.row_factory=sqlite3.Row; print(json.dumps({t:[dict(r) for r in c.execute('select * from '+t)] for t in ('pages','tools','records','chats')}))", join(root, "achilles-home", "achilles.sqlite3")], { stdout: "pipe", stderr: "pipe" });
  return result.exitCode === 0 ? JSON.parse(result.stdout.toString()) : { unavailable: true };
}

async function realTask(stack: Awaited<ReturnType<typeof startEvalStack>>, task: EvalTask) {
  const discovery = await fetch(`${stack.achillesOrigin}/api/zeta/discovery`).then(response => response.json()) as { url: string; controller_token: string };
  const page = await fetch(`${stack.achillesOrigin}/api/pages/home`).then(response => response.json()) as { workspace: string };
  const credential = await fetch(`${stack.achillesOrigin}/api/pages/home/credential`).then(response => response.json()) as { credential: string };
  const events: Record<string, unknown>[] = [];
  const protocol = await connectEvalProtocol(discovery, event => events.push(event));
  const started = Date.now();
  try {
    const session = await protocol.newSession({ cwd: page.workspace, mcp_bindings: [{ server: "achilles", headers: { Authorization: `Bearer ${credential.credential}` } }] });
    const sessionId = (session.session?.session_id ?? session.session_id) as string;
    await fetch(`${stack.achillesOrigin}/api/pages/home/chats`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ session_id: sessionId }) });
    await protocol.send(sessionId, task.prompt ?? "complete the task");
    const deadline = Date.now() + 90_000;
    while (!events.some(event => event.event === "served_turn_end")) { if (Date.now() >= deadline) throw new Error("provider turn did not finish within 90s"); await Bun.sleep(100); }
    const history = await protocol.sessionHistory(sessionId);
    const pageState = await fetch(`${stack.achillesOrigin}/api/pages/home`).then(response => response.json());
    const snapshot: EvalSnapshot = { pages: [{ ...pageState, alias: task.page_plan[0]?.alias ?? "home" }], calls: events.filter(e => e.event === "tool_call").map(e => e.data as Record<string, unknown>), results: events.filter(e => e.event === "tool_result").map(e => e.data as Record<string, unknown>), errors: events.filter(e => e.event === "error").map(e => e.data as Record<string, unknown>), turns: events.filter(e => e.event === "turn_start").length, wall_ms: Date.now() - started, chats: [{ chat_id: sessionId }], api_state: pageState, db_state: databaseSnapshot(stack.root), session_history: history, tool_policy: TOOL_POLICY, observed_catalog: [] };
    return gradeTask(task, snapshot);
  } finally { protocol.close(); }
}

async function main() {
  const taskId = Bun.env.TASK ?? Bun.argv[Bun.argv.indexOf("--suite") + 1] ?? "harness-smoke";
  const repeats = Number(Bun.env.N ?? "1");
  if (!Number.isInteger(repeats) || repeats < 1) throw new Error("N must be at least 1");
  const task = await loadTask(taskId);
  assertTurnBudget(reserveTurns([{ agent_turns: task.agent_turns, judge_turns: task.judge?.turns ?? 0 }], repeats));
  const scripted = Bun.env.EVAL_BACKEND === "scripted";
  const stack = scripted ? null : await startEvalStack({ achillesDir: Bun.env.ACHILLES_DIR, model: Bun.env.MODEL, keep: Bun.env.KEEP_EVAL === "1" });
  try {
    const tasks = [];
    for (let repeat = 0; repeat < repeats; repeat++) tasks.push(scripted ? await scriptedTask(task) : await realTask(stack!, task));
    const report = makeReport({ run_id: `${Date.now()}-${process.pid}`, repeats, agent: { provider: stack?.provider ?? "scripted", model: stack?.model ?? "offline", tool_policy: TOOL_POLICY, observed_catalog: ["achilles__list_records"] }, tasks });
    const output = resolve(Bun.env.REPORT_DIR ?? join(new URL("../evals/reports/", import.meta.url).pathname, report.run_id));
    await mkdir(output, { recursive: true });
    const json = renderReportJson(report); const markdown = renderReportMarkdown(report); scanSecrets(json); scanSecrets(markdown);
    await Bun.write(join(output, "report.json"), json); await Bun.write(join(output, "report.md"), markdown);
    console.log(JSON.stringify({ report: output, task: task.id, pass: tasks.every(result => result.pass), target: stack?.achillesSha ?? Bun.env.ACHILLES_DIR ?? "scripted" }));
  } finally { await stack?.close(); }
}
if (import.meta.main) await main();
