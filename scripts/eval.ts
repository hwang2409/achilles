import { cp, mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { connectEvalProtocol, assertTurnBudget, reserveTurns, type EvalProtocol } from "./eval-protocol";
import { fetchDeadline, startEvalStack, TOOL_POLICY, type CleanupProof, type EvalStack } from "./eval-stack";
import { gradeTask, validateTask, type EvalSnapshot, type EvalTask, type PagePlan } from "./eval-grade";
import { makeReport, reportJson, reportMarkdown } from "./eval-report";

export { startEvalStack, TOOL_POLICY } from "./eval-stack";
export { assertTurnBudget, reserveTurns, REQUIRED_FEATURES, connectEvalProtocol, enforceTurnBudget } from "./eval-protocol";
export type { EvalStackConfig, EvalStack } from "./eval-stack";

const TASK_TIMEOUT_MS = 180_000;
const MCP_UNAVAILABLE = "MCP server achilles is unavailable";
const sensitiveNames = /(?:TOKEN|KEY|SECRET|PASSWORD|AUTH|COOKIE|CREDENTIAL)/i;
const redact = (value: string, hidden: string[]) => hidden.reduce((text, secret) => secret ? text.replaceAll(secret, "[REDACTED]") : text, value);
export function hiddenValues(accountHome?: string) {
  const values = Object.entries(Bun.env).filter(([name, value]) => value && sensitiveNames.test(name)).map(([, value]) => value!);
  for (const path of [accountHome, Bun.env.ZETA_HOME, Bun.env.EVAL_ACCOUNT_HOME]) if (path) values.push(resolve(path));
  return [...new Set(values.filter(value => value.length >= 4))];
}
export function scanSecrets(value: string, hidden: string[] = []): void {
  if (hidden.some(secret => value.includes(secret))) throw new Error("artifact contains a known secret");
  if (/\b(?:sk-[A-Za-z0-9_-]{16,}|Bearer\s+[A-Za-z0-9._~+/=-]{12,}|gh[pousr]_[A-Za-z0-9_]{20,})\b/i.test(value)) throw new Error("artifact contains a secret-shaped value");
}
export async function scanArtifactTree(root: string, hidden: string[] = []): Promise<void> {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) await scanArtifactTree(path, hidden);
    else if (entry.isFile()) scanSecrets((await readFile(path)).toString("utf8"), hidden);
    else throw new Error(`artifact tree contains unsupported entry ${path}`);
  }
}
async function collectSensitiveFiles(root: string, hidden: string[]) {
  const directory = join(root, "achilles-home/credentials");
  for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) if (entry.isFile()) {
    const value = (await readFile(join(directory, entry.name), "utf8")).trim(); if (value) hidden.push(value, `Bearer ${value}`);
  }
  try { const row = JSON.parse(await readFile(join(root, "zeta-home/run/serve.ws.json"), "utf8")); for (const key of ["token", "controller_token", "observer_token"]) if (typeof row[key] === "string") hidden.push(row[key], `zeta.bearer.${row[key]}`); } catch {}
}
async function sanitizeAndScanRoot(root: string, hidden: string[]) {
  await collectSensitiveFiles(root, hidden); await rm(join(root, "achilles-home/credentials"), { recursive: true, force: true }); await rm(join(root, "zeta-home/run"), { recursive: true, force: true }); await scanArtifactTree(root, hidden);
}
export async function loadTask(id: string, dir = new URL("../evals/tasks/", import.meta.url).pathname) {
  const task = validateTask(JSON.parse(await readFile(join(dir, `${id}.json`), "utf8")));
  if (task.id !== id) throw new Error(`task id ${task.id} does not match ${id}`); return task;
}

const bundle = (name: string, operation: string, collection: string) => ({ format_version: 1, kind: "data_operation", name, description: `${operation} ${collection}`, input_schema: operation === "list" ? { type: "object", additionalProperties: false } : { type: "object", additionalProperties: true }, output_schema: {}, implementation: { operation, collection, data_schema: { type: "object", additionalProperties: true } } });
const SETUP_SCRIPT = `
import json, sys
from achilles.pages import PageStore, now
root, page_id, raw = sys.argv[1:]
setup = json.loads(raw); store = PageStore(root); store.set_create_mode(page_id, True)
for item in setup.get("tools", []): store.create_tool(page_id, item)
with store.transaction() as db:
    for item in setup.get("records", []):
        stamp = now(); data = item["data"]
        db.execute("INSERT INTO page_record(page_id,collection,record_id,version,document,created_at,updated_at) VALUES(?,?,?,?,?,?,?)", (page_id,item["collection"],item["id"],1,json.dumps(data,sort_keys=True),stamp,stamp))
`;
async function preparePage(stack: EvalStack, task: EvalTask, signal: AbortSignal) {
  const plan = task.page_plan.find(page => page.source !== "created")!;
  if (task.setup) {
    const setup = { tools: task.setup.tools.map(tool => bundle(tool.name, tool.operation, tool.collection)), records: task.setup.records };
    const process = Bun.spawn(["uv", "run", "--project", stack.achillesDir, "python", "-c", SETUP_SCRIPT, join(stack.root, "achilles-home"), "home", JSON.stringify(setup)], { cwd: stack.achillesDir, stdout: "pipe", stderr: "pipe" });
    const exit = await Promise.race([process.exited, Bun.sleep(15_000).then(() => -1)]); if (exit === -1) process.kill();
    if (exit !== 0) throw new Error(`task setup failed: ${await new Response(process.stderr).text()}`);
  }
  const response = await fetchDeadline(`${stack.achillesOrigin}/api/pages/home/create-mode`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled: plan.create_mode }) }, signal);
  if (!response.ok) throw new Error(`could not set create mode for ${plan.alias} (${response.status})`);
}
async function pageBinding(stack: EvalStack, pageId: string, hidden: string[], signal: AbortSignal) {
  const response = await fetchDeadline(`${stack.achillesOrigin}/api/pages/${pageId}`, {}, signal); if (!response.ok) throw new Error(`page ${pageId} is unavailable`);
  const page = await response.json() as { id: string; workspace: string };
  const credentialResponse = await fetchDeadline(`${stack.achillesOrigin}/api/pages/${page.id}/credential`, {}, signal); if (!credentialResponse.ok) throw new Error(`page credential failed (${credentialResponse.status})`);
  const credential = (await credentialResponse.json() as { credential: string }).credential; hidden.push(credential, `Bearer ${credential}`); return { page, credential };
}

function toolEnd(event: Record<string, any>) {
  const call = event.tool_call ?? event.data?.tool_call ?? {}; const result = event.tool_result ?? event.data?.tool_result ?? {};
  const text = Array.isArray(result.content) ? result.content.map((item: any) => item.text ?? "").join("\n") : String(result.content ?? "");
  let data: unknown = text; try { data = JSON.parse(text); } catch {}
  return { call, result, data, name: call.name ?? event.data?.name, success: !result.is_error };
}
function parseHistory(histories: Array<{ chat: string; page_id: string; rows: any[] }>) {
  const calls: Record<string, unknown>[] = []; const results: Record<string, unknown>[] = []; const errors: Record<string, unknown>[] = [];
  for (const history of histories) {
    const pending = new Map<string, Record<string, unknown>>();
    for (const row of history.rows) {
      for (const block of Array.isArray(row.content) ? row.content : []) if (block.type === "tool_use" && block.tool_call?.id) pending.set(block.tool_call.id, block.tool_call);
      if (row.role === "tool_result" && row.tool_result?.tool_call_id) {
        const call = pending.get(row.tool_result.tool_call_id) ?? {}; const text = String(row.tool_result.content ?? ""); let data: unknown = text; try { data = JSON.parse(text); } catch {}
        const common = { call_id: call.id, chat_id: history.chat, page_id: history.page_id, tool: call.name, success: row.tool_result.is_error !== true };
        calls.push({ ...call, ...common }); results.push({ ...common, data });
        if (row.tool_result.is_error === true) errors.push({ ...(data && typeof data === "object" ? data : {}), ...common, message: text });
      } else if (row.event === "error") errors.push({ ...(row.data ?? {}), chat_id: history.chat, page_id: history.page_id });
    }
  }
  return { calls, results, errors };
}
function pageIdFromResults(results: Array<Record<string, any>>, plan: PagePlan) {
  for (const value of results) { const data = value.data as Record<string, unknown>; if (value.tool === "achilles__create_page" && value.success && (!plan.route || data?.route === plan.route) && typeof data.page_id === "string") return data.page_id; }
  throw new Error(`create_page did not return page_id for ${plan.alias}`);
}
function createdPageId(events: Record<string, any>[], plan: PagePlan) {
  return pageIdFromResults(events.filter(event => event.event === "tool_end").map(event => { const value = toolEnd(event); return { ...value, tool: value.name }; }), plan);
}
async function waitForTerminal(protocol: EvalProtocol, sessionId: string, prior: number, failure: () => Error | undefined, signal: AbortSignal) {
  for (;;) {
    signal.throwIfAborted(); const error = failure(); if (error) throw error;
    const history = await protocol.sessionHistory(sessionId); const count = history.filter((row: any) => row.event === "served_turn_end").length;
    if (count > prior) return { count, history }; await Bun.sleep(100);
  }
}

const SNAPSHOT_SCRIPT = `import json,sqlite3,sys
c=sqlite3.connect(sys.argv[1]); c.row_factory=sqlite3.Row
def q(s): return [dict(r) for r in c.execute(s)]
out={"pages":q("select id,route,title from page"),"tools":q("select id,owner_page_id as page_id,name from tool"),"assignments":q("select page_id,tool_id,active_version from page_tool"),"records":q("select page_id,collection,record_id as id,document as data from page_record"),"layouts":q("select page_id,version,document from layout_version")}
for k in ("records","layouts"):
 for r in out[k]: r["data" if k=="records" else "document"]=json.loads(r["data" if k=="records" else "document"])
print(json.dumps(out))`;
async function databaseSnapshot(stack: EvalStack) {
  const process = Bun.spawn(["uv", "run", "python", "-c", SNAPSHOT_SCRIPT, join(stack.root, "achilles-home", "achilles.sqlite3")], { stdout: "pipe", stderr: "pipe" });
  const exit = await Promise.race([process.exited, Bun.sleep(15_000).then(() => -1)]); if (exit === -1) process.kill();
  if (exit !== 0) throw new Error(`snapshot failed: ${await new Response(process.stderr).text()}`); return JSON.parse(await new Response(process.stdout).text()) as EvalSnapshot;
}
const rowKey = (type: string, row: Record<string, unknown>) => type === "pages" || type === "tools" ? String(row.id) : type === "records" ? `${row.page_id}:${row.collection}:${row.id}` : `${row.page_id}:${row.tool_id ?? row.version}`;
function relatedPages(before: EvalSnapshot, after: EvalSnapshot, calls: Record<string, unknown>[]) {
  const ids: string[] = calls.filter(call => !String(call.tool).endsWith("create_page")).map(call => String(call.page_id));
  for (const type of ["pages", "tools", "assignments", "records", "layouts"] as const) {
    const old = new Set((before[type] ?? []).map(row => rowKey(type, row)));
    for (const row of after[type] ?? []) if (!old.has(rowKey(type, row)) && row.page_id) ids.push(String(row.page_id));
    if (type === "pages") for (const row of after.pages ?? []) if (!old.has(rowKey(type, row)) && row.id) ids.push(String(row.id));
  }
  return ids;
}
async function browserRows(stack: EvalStack, task: EvalTask, pages: Map<string, string>, snapshot: EvalSnapshot, signal: AbortSignal) {
  if (!task.checks.some(check => check.type === "browser_text")) return [];
  signal.throwIfAborted(); const modulePath = pathToFileURL(join(new URL("..", import.meta.url).pathname, "apps/web/node_modules/playwright/index.mjs")).href;
  const { chromium } = await import(modulePath); const browser = await chromium.launch({ headless: true });
  try {
    const output = [];
    for (const plan of task.page_plan.filter(page => task.checks.some(check => check.type === "browser_text" && check.page === page.alias))) {
      const pageId = pages.get(plan.alias); const route = snapshot.pages?.find(row => row.id === pageId)?.route ?? plan.route; if (typeof route !== "string") throw new Error(`created page ${plan.alias} has no route`);
      const page = await browser.newPage(); await page.goto(`${stack.achillesOrigin}${route}`, { waitUntil: "networkidle", timeout: 15_000 }); output.push({ page_id: pageId, text: await page.locator("body").innerText({ timeout: 10_000 }) }); await page.close();
    }
    return output;
  } finally { await browser.close(); }
}

async function driveTask(stack: EvalStack, task: EvalTask, hidden: string[], outerSignal: AbortSignal) {
  const timeout = new AbortController(); const timer = setTimeout(() => timeout.abort(new Error("task deadline exceeded")), TASK_TIMEOUT_MS); const signal = AbortSignal.any([outerSignal, timeout.signal]);
  await preparePage(stack, task, signal); const initial = await databaseSnapshot(stack);
  const discoveryResponse = await fetchDeadline(`${stack.achillesOrigin}/api/zeta/discovery`, {}, signal); if (!discoveryResponse.ok) throw new Error(`zeta discovery failed (${discoveryResponse.status})`);
  const discovery = await discoveryResponse.json() as { url: string; controller_token: string }; hidden.push(discovery.controller_token, `zeta.bearer.${discovery.controller_token}`);
  const events: Record<string, any>[] = []; const sessions = new Map<string, { id: string; alias: string; page_id: string }>(); const terminals = new Map<string, number>(); const histories = new Map<string, any[]>(); const pages = new Map<string, string>();
  for (const plan of task.page_plan.filter(page => page.source !== "created")) pages.set(plan.alias, "home");
  let turns = 0; let fatal: Error | undefined; let protocol: EvalProtocol;
  const approvals: Record<string, unknown>[] = []; const abortAll = async () => Promise.all([...sessions.values()].map(session => protocol.abort(session.id).catch(() => undefined)));
  const onEvent = (event: Record<string, any>) => {
    events.push(event);
    if (event.event === "turn_start" && ++turns > task.agent_turns && !fatal) { fatal = new Error("task model turn limit exceeded"); void abortAll(); }
  };
  protocol = await connectEvalProtocol(discovery, onEvent); const started = Date.now();
  const getSession = async (chat: string, alias: string) => {
    if (sessions.has(chat)) return sessions.get(chat)!; const plan = task.page_plan.find(page => page.alias === alias)!;
    const pageId = plan.source === "created" ? createdPageId(events, plan) : pages.get(alias)!; pages.set(alias, pageId);
    if (plan.source === "created") { const mode = await fetchDeadline(`${stack.achillesOrigin}/api/pages/${pageId}/create-mode`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled: plan.create_mode }) }, signal); if (!mode.ok) throw new Error(`could not set create mode for ${alias}`); }
    const binding = await pageBinding(stack, pageId, hidden, signal); const created = await protocol.newSession({ cwd: binding.page.workspace, provider: stack.provider, model: stack.model, approval_mode: "allow", mcp_bindings: [{ server: "achilles", headers: { Authorization: `Bearer ${binding.credential}` } }] });
    const id = String(created.session?.session_id ?? created.session_id ?? ""); if (!id) throw new Error("new_session returned no session id");
    const registration = await fetchDeadline(`${stack.achillesOrigin}/api/pages/${pageId}/chats`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ session_id: id }) }, signal); if (!registration.ok) throw new Error(`chat registration failed (${registration.status})`);
    const session = { id, alias, page_id: pageId }; sessions.set(chat, session); return session;
  };
  try {
    for (const step of task.steps) {
      signal.throwIfAborted(); if (fatal) throw fatal; if (turns >= task.agent_turns) throw new Error("task model turn limit has no remaining turn");
      const session = await getSession(step.chat, step.page); await protocol.send(session.id, step.prompt ?? task.prompt!); const terminal = await waitForTerminal(protocol, session.id, terminals.get(session.id) ?? 0, () => fatal, signal); terminals.set(session.id, terminal.count); histories.set(step.chat, terminal.history);
    }
    for (const [chat, session] of sessions) histories.set(chat, await protocol.sessionHistory(session.id));
    const durable = [...histories].map(([chat, rows]) => ({ chat, page_id: sessions.get(chat)!.page_id, rows })); const tools = parseHistory(durable); const after = await databaseSnapshot(stack);
    for (const plan of task.page_plan.filter(page => page.source === "created" && !pages.has(page.alias))) pages.set(plan.alias, pageIdFromResults(tools.results, plan));
    for (const page of after.pages ?? []) { const plan = task.page_plan.find(candidate => pages.get(candidate.alias) === page.id); if (plan) page.alias = plan.alias; }
    const chats = durable.map(history => ({ chat_id: history.chat, page_id: history.page_id, history: JSON.stringify(history.rows), first_prompt: task.steps.find(step => step.chat === history.chat)?.prompt ?? task.prompt }));
    const snapshot: EvalSnapshot = { ...after, ...tools, approvals, chats, browser: await browserRows(stack, task, pages, after, signal), related_page_ids: relatedPages(initial, after, tools.calls), turns, wall_ms: Date.now() - started, usage: { status: "unavailable" }, session_history: durable.flatMap(history => history.rows) };
    return { result: gradeTask(task, snapshot), snapshot };
  } finally { clearTimeout(timer); if (fatal || signal.aborted) await abortAll(); protocol.close(); }
}

export function validateCatalog(names: string[], required?: string) {
  if (required && !names.includes(required)) throw new Error(`model-visible catalog lacks ${required}: ${names.join(", ")}`);
  const forbidden = names.filter(name => name !== "mcp_discover" && !name.startsWith("achilles__")); if (forbidden.length) throw new Error(`model-visible catalog violates tool policy: ${forbidden.join(", ")}`);
}
function scriptedProvider() {
  const requests: Record<string, unknown>[] = [];
  const server = Bun.serve({ port: 0, async fetch(request) {
    const url = new URL(request.url); if (url.pathname === "/api/show") return Response.json({ model_info: { "qwen2.context_length": 32_768 } }); if (url.pathname !== "/api/chat") return new Response("not found", { status: 404 });
    const body = await request.json() as Record<string, unknown>; requests.push(body); if (Bun.env.EVAL_FORCE_ERROR === "1") return new Response("forced provider error", { status: 500 });
    const turn = requests.length; const toolCalls = turn === 1 ? [{ function: { name: "achilles__create_tool", arguments: { bundle: bundle("add_note", "insert", "notes") } } }] : turn === 2 ? [{ function: { name: "achilles__add_note", arguments: { text: "synthetic note" } } }] : [];
    return new Response(`${JSON.stringify({ message: { content: toolCalls.length ? "" : "done", ...(toolCalls.length ? { tool_calls: toolCalls } : {}) }, done: true, done_reason: toolCalls.length ? "tool_calls" : "stop" })}\n`, { headers: { "content-type": "application/x-ndjson" } });
  } });
  return { requests, url: `http://127.0.0.1:${server.port}`, close: () => server.stop(true) };
}
function catalogProof(requests: Record<string, unknown>[]) {
  const catalogs = requests.map(request => ((request.tools ?? []) as { function?: { name?: string } }[]).map(tool => tool.function?.name).filter((name): name is string => Boolean(name)));
  catalogs.forEach(catalog => validateCatalog(catalog)); validateCatalog(catalogs[0] ?? [], "achilles__create_tool"); return [...new Set(catalogs.flat())];
}
function failureResult(task: EvalTask, error: unknown, hidden: string[]) {
  return { task_id: task.id, pass: false, score: 0, checks: [{ id: "harness", pass: false, expected: "successful run", actual: "harness error", evidence: { message: redact(error instanceof Error ? error.message : String(error), hidden) } }], turns: 0, wall_ms: 0, tool_calls: 0, approvals: 0, usage: "unavailable", host_tools_gap: false, diagnostics: { first_call_validity: {}, structured_tool_errors: [], unstructured_tool_errors: 1 } } as ReturnType<typeof gradeTask>;
}

type RepeatResult = { result: ReturnType<typeof gradeTask>; snapshot?: EvalSnapshot; cleanup?: CleanupProof; catalog: string[]; achilles_sha?: string; zeta_sha?: string; failed: boolean };
async function runRepeat(task: EvalTask, index: number, options: { scripted: boolean; achillesDir?: string; keep: boolean; runId: string; signal: AbortSignal; hidden: string[] }): Promise<RepeatResult> {
  const provider = options.scripted ? scriptedProvider() : undefined; let stack: EvalStack | undefined; let result: ReturnType<typeof gradeTask> | undefined; let snapshot: EvalSnapshot | undefined; let failed = false; let catalog: string[] = [];
  const retainedRoot = options.keep ? resolve(new URL(`../.cache/evals/${options.runId}/repeat-${index + 1}`, import.meta.url).pathname) : undefined;
  try {
    stack = await startEvalStack({ achillesDir: options.achillesDir, zetaRev: Bun.env.ZETA_REV, model: options.scripted ? "ollama/qwen3:4b" : Bun.env.MODEL, ollamaBaseUrl: provider?.url, maxTurns: task.agent_turns, signal: options.signal, beforeDelete: root => sanitizeAndScanRoot(root, options.hidden) });
    options.hidden.push(...hiddenValues(stack.accountHome)); ({ result, snapshot } = await driveTask(stack, task, options.hidden, options.signal)); if (provider) catalog = catalogProof(provider.requests); result.diagnostics.observed_catalog = catalog;
  } catch (error) { failed = true; result = failureResult(task, error, options.hidden); if (provider?.requests.length) { try { catalog = catalogProof(provider.requests); } catch (catalogError) { result = failureResult(task, catalogError, options.hidden); } } }
  finally { provider?.close(); }
  if (!stack) return { result: result!, catalog, failed: true };
  let cleanup: CleanupProof | undefined;
  try {
    await Bun.write(join(stack.root, "result.json"), JSON.stringify(result, null, 2)); await Bun.write(join(stack.root, "snapshot.json"), JSON.stringify(snapshot ?? null, null, 2)); await collectSensitiveFiles(stack.root, options.hidden); cleanup = await stack.close(); await Bun.write(join(stack.root, "cleanup.json"), JSON.stringify(cleanup, null, 2)); await sanitizeAndScanRoot(stack.root, options.hidden);
    if (retainedRoot) { await mkdir(join(retainedRoot, ".."), { recursive: true }); await cp(stack.root, retainedRoot, { recursive: true, force: true }); await scanArtifactTree(retainedRoot, options.hidden); }
  } catch { failed = true; result = failureResult(task, new Error("artifact finalization failed"), options.hidden); snapshot = undefined; if (retainedRoot) await rm(retainedRoot, { recursive: true, force: true }); }
  finally { await rm(stack.root, { recursive: true, force: true }); }
  return { result: result!, snapshot, cleanup, catalog, achilles_sha: stack.achillesSha, zeta_sha: stack.zetaSha, failed };
}

async function writeReportArtifacts(staging: string, report: ReturnType<typeof makeReport>, repeats: RepeatResult[]) {
  await Bun.write(join(staging, "report.json"), reportJson(report)); await Bun.write(join(staging, "report.md"), reportMarkdown(report)); await Bun.write(join(staging, "cleanup.json"), JSON.stringify(repeats.map(repeat => repeat.cleanup ?? null), null, 2));
  await mkdir(join(staging, "snapshots")); for (const [index, repeat] of repeats.entries()) await Bun.write(join(staging, "snapshots", `${index + 1}.json`), JSON.stringify(repeat.snapshot ?? null, null, 2));
}
async function publishReport(task: EvalTask, repeats: RepeatResult[], output: string, runId: string, hidden: string[]) {
  const first = repeats[0]; let publicationFailed = false; let report = makeReport({ run_id: runId, repeats: repeats.length, agent: { provider: Bun.env.EVAL_BACKEND === "scripted" ? "scripted" : "configured", model: Bun.env.EVAL_BACKEND === "scripted" ? "offline" : Bun.env.MODEL ?? "configured", tool_policy: TOOL_POLICY, observed_catalog: first.catalog, achilles_sha: first.achilles_sha, zeta_sha: first.zeta_sha }, tasks: repeats.map(repeat => repeat.result) });
  const staging = await mkdtemp(join(Bun.env.TMPDIR ?? "/tmp", "achilles-eval-report-"));
  try {
    await writeReportArtifacts(staging, report, repeats);
    try { await scanArtifactTree(staging, hidden); }
    catch {
      publicationFailed = true; await rm(staging, { recursive: true, force: true }); await mkdir(staging);
      report = makeReport({ ...report, tasks: repeats.map(() => failureResult(task, new Error("artifact secret scan failed"), [])) }); await writeReportArtifacts(staging, report, repeats.map(repeat => ({ ...repeat, snapshot: undefined }))); await scanArtifactTree(staging, hidden);
    }
    await mkdir(output, { recursive: true }); await cp(staging, output, { recursive: true, force: true });
  } finally { await rm(staging, { recursive: true, force: true }); }
  const pass = !publicationFailed && repeats.every(repeat => repeat.result.pass && !repeat.failed); console.log(JSON.stringify({ task: task.id, pass, repeats: repeats.length, report: output, achilles_sha: first.achilles_sha, zeta_sha: first.zeta_sha })); return pass;
}

async function runStackOnly(task: EvalTask, controller: AbortController, hidden: string[]) {
  const retained = resolve(new URL(`../.cache/evals/${Date.now()}-${process.pid}/stack`, import.meta.url).pathname); const stack = await startEvalStack({ achillesDir: Bun.env.ACHILLES_DIR, zetaRev: Bun.env.ZETA_REV, model: Bun.env.MODEL, maxTurns: task.agent_turns, signal: controller.signal, beforeDelete: root => sanitizeAndScanRoot(root, hidden) }); hidden.push(...hiddenValues(stack.accountHome));
  console.log(JSON.stringify({ achilles: stack.achillesOrigin, zeta: stack.zetaOrigin, model: `${stack.provider}/${stack.model}`, achilles_sha: stack.achillesSha, zeta_sha: stack.zetaSha, retained_state: retained }));
  try { await new Promise<void>(resolveWait => controller.signal.addEventListener("abort", () => resolveWait(), { once: true })); }
  finally { await collectSensitiveFiles(stack.root, hidden); const cleanup = await stack.close(); await Bun.write(join(stack.root, "cleanup.json"), JSON.stringify(cleanup, null, 2)); await sanitizeAndScanRoot(stack.root, hidden); await mkdir(join(retained, ".."), { recursive: true }); await cp(stack.root, retained, { recursive: true, force: true }); await scanArtifactTree(retained, hidden); await rm(stack.root, { recursive: true, force: true }); }
}

async function main() {
  const taskId = Bun.env.TASK ?? Bun.argv[Bun.argv.indexOf("--suite") + 1] ?? "harness-smoke"; const repeats = Number(Bun.env.N ?? "1");
  if (!Number.isInteger(repeats) || repeats < 1) throw new Error("N must be at least 1"); const task = await loadTask(taskId); assertTurnBudget(reserveTurns([{ agent_turns: task.agent_turns }], repeats));
  const controller = new AbortController(); let signalCode = 0; const interrupt = (code: number) => { signalCode ||= code; controller.abort(new Error("eval interrupted")); };
  const onSigint = () => interrupt(130); const onSigterm = () => interrupt(143); process.once("SIGINT", onSigint); process.once("SIGTERM", onSigterm); const hidden = hiddenValues();
  try {
    if (Bun.env.EVAL_STACK_ONLY === "1") await runStackOnly(task, controller, hidden);
    else {
      const runId = `${Date.now()}-${process.pid}`; const output = resolve(Bun.env.REPORT_DIR ?? join(new URL("../evals/reports/", import.meta.url).pathname, runId)); const results: RepeatResult[] = [];
      for (let index = 0; index < repeats; index++) { if (controller.signal.aborted) break; results.push(await runRepeat(task, index, { scripted: Bun.env.EVAL_BACKEND === "scripted", achillesDir: Bun.env.ACHILLES_DIR, keep: Bun.env.KEEP_EVAL === "1", runId, signal: controller.signal, hidden })); }
      if (!await publishReport(task, results, output, runId, hidden)) process.exitCode = 1;
    }
  } finally { process.off("SIGINT", onSigint); process.off("SIGTERM", onSigterm); if (signalCode) process.exitCode = signalCode; }
}
if (import.meta.main) await main();
