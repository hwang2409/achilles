import { mkdir, readFile, readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { connectEvalProtocol, assertTurnBudget, reserveTurns, type EvalProtocol } from "./eval-protocol";
import { startEvalStack, TOOL_POLICY, type EvalStack } from "./eval-stack";
import { gradeTask, validateTask, type EvalSnapshot, type EvalTask } from "./eval-grade";
import { makeReport, reportJson as renderReportJson, reportMarkdown as renderReportMarkdown } from "./eval-report";

export { startEvalStack, TOOL_POLICY } from "./eval-stack";
export { assertTurnBudget, reserveTurns, REQUIRED_FEATURES, connectEvalProtocol, enforceTurnBudget } from "./eval-protocol";
export type { EvalStackConfig, EvalStack } from "./eval-stack";

export const reportJson = (result: unknown) => result && typeof result === "object" && "task" in result
  ? JSON.stringify(result, null, 2) + "\n" : renderReportJson(result as never);
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
export async function scanArtifactTree(root: string, hidden: string[] = []): Promise<void> {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) await scanArtifactTree(path, hidden);
    else if (entry.isFile()) scanSecrets((await readFile(path)).toString("utf8"), hidden);
    else throw new Error(`artifact tree contains unsupported entry ${path}`);
  }
}
async function retainSanitized(stack: EvalStack, hidden: string[]) {
  const credentialDir = join(stack.root, "achilles-home/credentials");
  for (const entry of await readdir(credentialDir, { withFileTypes: true }).catch(() => [])) if (entry.isFile()) {
    const value = (await readFile(join(credentialDir, entry.name), "utf8")).trim(); if (value) hidden.push(value, `Bearer ${value}`);
  }
  const discoveryPath = join(stack.root, "zeta-home/run/serve.ws.json");
  try { const row = JSON.parse(await readFile(discoveryPath, "utf8")); for (const key of ["token", "controller_token", "observer_token"]) if (typeof row[key] === "string") hidden.push(row[key], `zeta.bearer.${row[key]}`); } catch {}
  await rm(credentialDir, { recursive: true, force: true }); await rm(join(stack.root, "zeta-home/run"), { recursive: true, force: true });
  await scanArtifactTree(stack.root, hidden);
}

export async function loadTask(id: string, dir = new URL("../evals/tasks/", import.meta.url).pathname): Promise<EvalTask> {
  const task = validateTask(JSON.parse(await readFile(join(dir, `${id}.json`), "utf8")));
  if (task.id !== id) throw new Error(`task id ${task.id} does not match ${id}`);
  return task;
}

const bundle = (name: string, operation: string, collection: string) => ({
  format_version: 1, kind: "data_operation", name, description: `${operation} ${collection}`,
  input_schema: operation === "list" ? { type: "object", additionalProperties: false } : { type: "object", additionalProperties: true },
  output_schema: {}, implementation: { operation, collection, data_schema: { type: "object", additionalProperties: true } },
});

const SETUP_SCRIPT = `
import json, sqlite3, sys
from achilles.pages import PageStore, now
root, page_id, raw = sys.argv[1:]
setup = json.loads(raw)
store = PageStore(root)
store.set_create_mode(page_id, True)
for item in setup.get("tools", []):
    store.create_tool(page_id, item)
with store.transaction() as db:
    for item in setup.get("records", []):
        data = item["data"]
        record_id = item.get("id") or data.get("id")
        stamp = now()
        db.execute("INSERT INTO page_record(page_id,collection,record_id,version,document,created_at,updated_at) VALUES(?,?,?,?,?,?,?)", (page_id,item["collection"],record_id,1,json.dumps(data,sort_keys=True),stamp,stamp))
`;

async function preparePage(stack: EvalStack, task: EvalTask, pageId = "home") {
  const plan = task.page_plan.find(page => page.source !== "created") ?? task.page_plan[0];
  if (task.setup) {
    const setup = { tools: task.setup.tools.map(tool => bundle(tool.name, tool.operation, tool.collection)), records: task.setup.records };
    const seeded = Bun.spawnSync(["uv", "run", "--project", stack.achillesDir, "python", "-c", SETUP_SCRIPT, join(stack.root, "achilles-home"), pageId, JSON.stringify(setup)], { cwd: stack.achillesDir, stdout: "pipe", stderr: "pipe" });
    if (seeded.exitCode) throw new Error(`task setup failed: ${seeded.stderr.toString().trim()}`);
  }
  const mode = await fetch(`${stack.achillesOrigin}/api/pages/${pageId}/create-mode`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled: plan.create_mode }) });
  if (!mode.ok) throw new Error(`could not set create mode for ${plan.alias} (${mode.status})`);
}

async function pageBinding(stack: EvalStack, pageId: string, hidden: string[]) {
  const pageResponse = await fetch(`${stack.achillesOrigin}/api/pages/${pageId}`);
  if (!pageResponse.ok) throw new Error(`page ${pageId} is unavailable`);
  const page = await pageResponse.json() as { id: string; workspace: string };
  const credential = await fetch(`${stack.achillesOrigin}/api/pages/${page.id}/credential`).then(response => response.json()) as { credential: string };
  hidden.push(credential.credential, `Bearer ${credential.credential}`);
  return { page, credential: credential.credential };
}

async function waitForTerminal(protocol: EvalProtocol, sessionId: string, events: Record<string, any>[], start: number, priorTerminals: number, failure: () => Error | undefined) {
  const deadline = Date.now() + 90_000;
  for (;;) {
    const error = failure(); if (error) throw error;
    if (events.slice(start).some(event => event.event === "agent_end")) {
      const history = await protocol.sessionHistory(sessionId);
      const terminals = history.filter((row: any) => row.event === "served_turn_end").length;
      if (terminals > priorTerminals) return terminals;
    }
    if (Date.now() >= deadline) throw new Error("provider turn did not produce served_turn_end within 90s");
    await Bun.sleep(100);
  }
}

function parseToolEvents(events: Record<string, any>[]) {
  const calls: Record<string, unknown>[] = [];
  const results: Record<string, unknown>[] = [];
  const errors: Record<string, unknown>[] = [];
  for (const event of events) {
    if (event.event !== "tool_end") continue;
    const call = event.tool_call ?? event.data?.tool_call ?? {};
    const result = event.tool_result ?? event.data?.tool_result ?? {};
    const name = call.name ?? event.data?.name;
    const success = !result.is_error;
    calls.push({ ...call, name, tool: name, success, chat_id: event.session_id });
    const text = Array.isArray(result.content) ? result.content.map((item: any) => item.text ?? "").join("\n") : String(result.content ?? "");
    let data: unknown = text;
    try { data = JSON.parse(text); } catch {}
    results.push({ tool: name, success, data, chat_id: event.session_id });
    if (!success) {
      const structured = data && typeof data === "object" ? data as Record<string, unknown> : {};
      errors.push({ ...structured, message: text, chat_id: event.session_id });
    }
  }
  for (const event of events) if (event.event === "error") errors.push({ ...(event.data ?? {}), chat_id: event.session_id });
  return { calls, results, errors };
}

function databaseSnapshot(stack: EvalStack, task: EvalTask): EvalSnapshot {
  const script = `import json,sqlite3,sys\nc=sqlite3.connect(sys.argv[1]); c.row_factory=sqlite3.Row\ndef q(s): return [dict(r) for r in c.execute(s)]\nout={"pages":q("select id,route,title from page"),"tools":q("select id,owner_page_id as page_id,name from tool"),"assignments":q("select page_id,tool_id,active_version from page_tool"),"records":q("select page_id,collection,record_id as id,document as data from page_record"),"layouts":q("select page_id,version from layout_version"),"chats":q("select session_id as chat_id,page_id from chat")}\nfor r in out["records"]: r["data"]=json.loads(r["data"])\nprint(json.dumps(out))`;
  const result = Bun.spawnSync(["uv", "run", "python", "-c", script, join(stack.root, "achilles-home", "achilles.sqlite3")], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode) throw new Error(`snapshot failed: ${result.stderr.toString().trim()}`);
  const snapshot = JSON.parse(result.stdout.toString()) as EvalSnapshot;
  for (const page of snapshot.pages ?? []) {
    const match = task.page_plan.find(plan => page.id === "home" ? plan.source !== "created" : page.route === `/${plan.alias}`);
    if (match) page.alias = match.alias;
  }
  return snapshot;
}

async function driveTask(stack: EvalStack, task: EvalTask, observedCatalog: string[] = [], hidden: string[] = []) {
  await preparePage(stack, task);
  const discovery = await fetch(`${stack.achillesOrigin}/api/zeta/discovery`).then(response => response.json()) as { url: string; controller_token: string };
  hidden.push(discovery.controller_token, `zeta.bearer.${discovery.controller_token}`);
  const events: Record<string, any>[] = [];
  const sessions = new Map<string, { id: string; page: string }>();
  const terminalCounts = new Map<string, number>();
  let protocol: EvalProtocol;
  let turns = 0;
  let fatal: Error | undefined;
  const approvals: Record<string, unknown>[] = [];
  const abortAll = async () => { await Promise.all([...sessions.values()].map(session => protocol.abort(session.id).catch(() => undefined))); };
  const onEvent = (event: Record<string, any>) => {
    events.push(event);
    if (event.event === "turn_start") {
      turns += 1;
      if (turns >= task.agent_turns && !fatal) { fatal = new Error("task model turn limit reached"); void abortAll(); }
      return;
    }
    if (event.event !== "approval_request") return;
    const requestId = event.data?.request_id ?? event.request_id;
    if (task.approval_mode !== "ask" || !requestId) { fatal = new Error("undeclared approval request"); void abortAll(); return; }
    approvals.push({ request_id: requestId, chat_id: event.session_id });
    void protocol.approve(String(event.session_id), String(requestId)).catch(error => { fatal = error; });
  };
  protocol = await connectEvalProtocol(discovery, onEvent);
  const started = Date.now();
  const getSession = async (chat: string, pageAlias: string) => {
    const existing = sessions.get(chat); if (existing) return existing;
    const plan = task.page_plan.find(page => page.alias === pageAlias) ?? task.page_plan[0];
    let pageId = plan.source === "created" ? pageAlias : "home";
    if (plan.source === "created") {
      const found = await fetch(`${stack.achillesOrigin}/api/pages/${pageAlias}`);
      if (!found.ok) throw new Error(`created page ${pageAlias} was not found`);
      pageId = ((await found.json()) as { id: string }).id;
      const mode = await fetch(`${stack.achillesOrigin}/api/pages/${pageId}/create-mode`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled: plan.create_mode }) });
      if (!mode.ok) throw new Error(`could not set create mode for ${pageAlias}`);
    }
    const binding = await pageBinding(stack, pageId, hidden);
    const created = await protocol.newSession({ cwd: binding.page.workspace, provider: stack.provider, model: stack.model, approval_mode: task.approval_mode ?? "allow", mcp_bindings: [{ server: "achilles", headers: { Authorization: `Bearer ${binding.credential}` } }] });
    const id = (created.session?.session_id ?? created.session_id) as string;
    if (!id) throw new Error("new_session returned no session id");
    const registered = await fetch(`${stack.achillesOrigin}/api/pages/${binding.page.id}/chats`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ session_id: id }) });
    if (!registered.ok) throw new Error(`chat registration failed (${registered.status})`);
    const value = { id, page: pageAlias }; sessions.set(chat, value); return value;
  };
  try {
    const steps = task.steps.length ? task.steps : [{ id: "task", kind: "prompt", page: task.page_plan[0].alias, chat: "chat", prompt: task.prompt ?? "complete the task" }];
    for (const step of steps as Array<{ id: string; kind: string; page: string; chat?: string; prompt?: string }>) {
      const chat = step.chat ?? "chat";
      if (step.kind === "reconnect") {
        const session = sessions.get(chat); if (!session) throw new Error(`cannot reconnect missing chat ${chat}`);
        protocol.close(); protocol = await connectEvalProtocol(discovery, onEvent); await protocol.resume(session.id); continue;
      }
      if (step.kind !== "prompt" && step.kind !== "annotate") continue;
      const session = await getSession(chat, step.page);
      const mark = events.length;
      await protocol.send(session.id, step.prompt ?? "complete the task");
      terminalCounts.set(session.id, await waitForTerminal(protocol, session.id, events, mark, terminalCounts.get(session.id) ?? 0, () => fatal));
    }
    const histories = await Promise.all([...sessions.values()].map(session => protocol.sessionHistory(session.id)));
    const db = databaseSnapshot(stack, task);
    const tools = parseToolEvents(events);
    const chatNames = new Map([...sessions].map(([name, session]) => [session.id, name]));
    for (const row of [...tools.calls, ...tools.results, ...tools.errors, ...approvals]) if (typeof row.chat_id === "string") row.chat_id = chatNames.get(row.chat_id) ?? row.chat_id;
    const snapshot: EvalSnapshot = { ...db, ...tools, approvals, turns, wall_ms: Date.now() - started, usage: { status: "unavailable" }, tool_policy: TOOL_POLICY, observed_catalog: observedCatalog, session_history: histories.flat() };
    return gradeTask(task, snapshot);
  } finally { protocol.close(); }
}

export function validateCatalog(names: string[], required?: string) {
  if (required && !names.includes(required)) throw new Error(`model-visible catalog lacks ${required}: ${names.join(", ")}`);
  const forbidden = names.filter(name => name !== "mcp_discover" && !name.startsWith("achilles__"));
  if (forbidden.length) throw new Error(`model-visible catalog violates tool policy: ${forbidden.join(", ")}`);
}

async function scriptedTask(task: EvalTask, hidden: string[], achillesDir?: string, onStack?: (stack: EvalStack | null) => void) {
  const requests: Record<string, unknown>[] = [];
  const provider = Bun.serve({ port: 0, async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/api/show") return Response.json({ model_info: { "qwen2.context_length": 32_768 } });
    if (url.pathname !== "/api/chat") return new Response("not found", { status: 404 });
    if (Bun.env.EVAL_FORCE_ERROR === "1") return new Response("forced provider error", { status: 500 });
    const body = await request.json() as Record<string, unknown>; requests.push(body);
    const turn = requests.length;
    const toolCalls = turn === 1 ? [{ function: { name: "achilles__create_tool", arguments: { bundle: bundle("add_note", "insert", "notes") } } }]
      : turn === 2 ? [{ function: { name: "achilles__add_note", arguments: { text: "synthetic note" } } }] : [];
    return new Response(`${JSON.stringify({ message: { content: toolCalls.length ? "" : "done", ...(toolCalls.length ? { tool_calls: toolCalls } : {}) }, done: true, done_reason: toolCalls.length ? "tool_calls" : "stop" })}\n`, { headers: { "content-type": "application/x-ndjson" } });
  } });
  let stack: EvalStack | undefined;
  try {
    stack = await startEvalStack({ achillesDir, model: "ollama/qwen3:4b", ollamaBaseUrl: `http://127.0.0.1:${provider.port}`, maxTurns: task.agent_turns }); onStack?.(stack);
    const firstTools = () => ((requests[0]?.tools ?? []) as { function?: { name?: string } }[]).map(tool => tool.function?.name).filter((name): name is string => Boolean(name));
    const graded = await driveTask(stack, task, [], hidden);
    const catalog = firstTools();
    validateCatalog(catalog, "achilles__create_tool");
    if (requests.length < 3) throw new Error("scripted provider did not complete the create/use task");
    graded.diagnostics.observed_catalog = catalog;
    return graded;
  } finally { await stack?.close(); onStack?.(null); provider.stop(true); }
}

async function writeFailureReport(output: string, task: EvalTask, repeats: number, error: unknown, hidden: string[]) {
  const message = secrets(error instanceof Error ? error.message : String(error), hidden);
  const result = { task_id: task.id, pass: false, score: 0, checks: [{ id: "harness", pass: false, expected: "successful run", actual: "harness error", evidence: { message } }], turns: 0, wall_ms: 0, tool_calls: 0, approvals: 0, usage: "unavailable", host_tools_gap: false, diagnostics: { first_call_validity: {}, structured_tool_errors: [], unstructured_tool_errors: 1 } };
  const report = makeReport({ run_id: `${Date.now()}-${process.pid}`, repeats, agent: { provider: "unknown", model: "unknown", tool_policy: TOOL_POLICY, observed_catalog: [] }, tasks: [result] });
  await mkdir(output, { recursive: true });
  await Bun.write(join(output, "report.json"), renderReportJson(report)); await Bun.write(join(output, "report.md"), renderReportMarkdown(report));
  await scanArtifactTree(output, hidden);
}

async function main() {
  const taskId = Bun.env.TASK ?? Bun.argv[Bun.argv.indexOf("--suite") + 1] ?? "harness-smoke";
  const repeats = Number(Bun.env.N ?? "1");
  if (!Number.isInteger(repeats) || repeats < 1) throw new Error("N must be at least 1");
  const scripted = Bun.env.EVAL_BACKEND === "scripted";
  const effectiveTaskId = scripted && taskId === "harness-smoke" ? "create-and-use-tool-same-chat" : taskId;
  const task = await loadTask(effectiveTaskId);
  assertTurnBudget(reserveTurns([{ agent_turns: task.agent_turns, judge_turns: task.judge?.turns ?? 0 }], repeats));
  const runId = `${Date.now()}-${process.pid}`;
  const output = resolve(Bun.env.REPORT_DIR ?? join(new URL("../evals/reports/", import.meta.url).pathname, runId));
  const hidden: string[] = [];
  let stack: EvalStack | null = null;
  let signalExit = false;
  const cleanupAndExit = (code: number) => {
    if (signalExit) return; signalExit = true;
    void (async () => { await stack?.close(); if (stack && (Bun.env.KEEP_EVAL === "1" || Bun.env.EVAL_STACK_ONLY === "1")) await retainSanitized(stack, hidden); })().finally(() => process.exit(code));
  };
  const onSigint = () => cleanupAndExit(130); const onSigterm = () => cleanupAndExit(143);
  process.once("SIGINT", onSigint); process.once("SIGTERM", onSigterm);
  try {
    if (Bun.env.EVAL_STACK_ONLY === "1") {
      stack = await startEvalStack({ achillesDir: Bun.env.ACHILLES_DIR, model: Bun.env.MODEL, maxTurns: task.agent_turns, keep: true });
      console.log(JSON.stringify({ achilles: stack.achillesOrigin, zeta: stack.zetaOrigin, model: `${stack.provider}/${stack.model}`, achilles_sha: stack.achillesSha, zeta_sha: stack.zetaSha, retained_state: stack.root }));
      await new Promise<void>(() => {});
      return;
    }
    if (!scripted) stack = await startEvalStack({ achillesDir: Bun.env.ACHILLES_DIR, model: Bun.env.MODEL, maxTurns: task.agent_turns, keep: Bun.env.KEEP_EVAL === "1" });
    const tasks = [];
    for (let repeat = 0; repeat < repeats; repeat++) tasks.push(scripted ? await scriptedTask(task, hidden, Bun.env.ACHILLES_DIR, value => { stack = value; }) : await driveTask(stack!, task, [], hidden));
    const report = makeReport({ run_id: runId, repeats, agent: { provider: stack?.provider ?? "scripted", model: stack?.model ?? "offline", tool_policy: TOOL_POLICY, observed_catalog: tasks[0]?.diagnostics?.observed_catalog ?? [] }, tasks });
    await mkdir(output, { recursive: true });
    await Bun.write(join(output, "report.json"), renderReportJson(report)); await Bun.write(join(output, "report.md"), renderReportMarkdown(report));
    await scanArtifactTree(output, hidden);
    if (stack?.root && Bun.env.KEEP_EVAL === "1") { await stack.close(); await retainSanitized(stack, hidden); }
    console.log(JSON.stringify({ task: task.id, pass: tasks.every(result => result.pass), turns: tasks.reduce((sum, result) => sum + result.turns, 0), provider: stack?.provider ?? "scripted", model: stack?.model ?? "offline", tool_policy: TOOL_POLICY, report: output, achilles_sha: stack?.achillesSha, zeta_sha: stack?.zetaSha }));
    if (!tasks.every(result => result.pass)) process.exitCode = 1;
  } catch (error) {
    await writeFailureReport(output, task, repeats, error, hidden);
    throw error;
  } finally {
    process.off("SIGINT", onSigint); process.off("SIGTERM", onSigterm);
    await stack?.close();
  }
}
if (import.meta.main) await main();
