import { cp, mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { connectEvalProtocol, assertTurnBudget, reserveTurns, type EvalProtocol } from "./eval-protocol";
import { fetchDeadline, startEvalStack, TOOL_POLICY, type CleanupProof, type EvalStack } from "./eval-stack";
import { gradeReference, gradeTask, validateTask, type EvalSnapshot, type EvalTask, type PagePlan } from "./eval-grade";
import { makeReport, reportJson, reportMarkdown } from "./eval-report";
import { readTranscriptUsage } from "./eval-usage";

export { startEvalStack, TOOL_POLICY } from "./eval-stack";
export { assertTurnBudget, reserveTurns, REQUIRED_FEATURES, connectEvalProtocol, enforceTurnBudget } from "./eval-protocol";
export type { EvalStackConfig, EvalStack } from "./eval-stack";

const TASK_TIMEOUT_MS = 180_000;
const sensitiveNames = /(?:TOKEN|KEY|SECRET|PASSWORD|AUTH|COOKIE|CREDENTIAL)/i;
const fatalAccountFailure = /(?:oauth credentials.*login required|login[_ -]?required|log in required|not logged in|account (?:no longer exists|unavailable|disabled|expired)|authentication (?:failed|required)|unauthorized|quota|usage[_ -]?limit|insufficient (?:credits|quota)|billing limit)/i;
class SecretScanFailure extends Error {}
class TaskRunFailure extends Error {
  constructor(readonly original: unknown, readonly snapshot: EvalSnapshot) { super(original instanceof Error ? original.message : String(original)); }
}
class TurnCapFailure extends Error {}
export function stopsSuite(error: unknown) { return error instanceof SecretScanFailure || fatalAccountFailure.test(error instanceof Error ? error.message : String(error)); }
const redact = (value: string, hidden: string[]) => hidden.reduce((text, secret) => secret ? text.replaceAll(secret, "[REDACTED]") : text, value);
export function hiddenValues(accountHome?: string) {
  const values = Object.entries(Bun.env).filter(([name, value]) => value && sensitiveNames.test(name)).map(([, value]) => value!);
  for (const path of [accountHome, Bun.env.ZETA_HOME, Bun.env.EVAL_ACCOUNT_HOME]) if (path) values.push(resolve(path));
  return [...new Set(values.filter(value => value.length >= 4))];
}
export function scanSecrets(value: string, hidden: string[] = []): void {
  if (hidden.some(secret => value.includes(secret))) throw new SecretScanFailure("artifact contains a known secret");
  if (/\b(?:sk-[A-Za-z0-9_-]{16,}|Bearer\s+[A-Za-z0-9._~+/=-]{12,}|gh[pousr]_[A-Za-z0-9_]{20,})\b/i.test(value)) throw new SecretScanFailure("artifact contains a secret-shaped value");
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
export async function selectTasks(selection?: string, dir = new URL("../evals/tasks/", import.meta.url).pathname) {
  const ids = selection?.trim() ? selection.split(",").map(id => id.trim()).filter(Boolean) : (await readdir(dir)).filter(name => name.endsWith(".json")).map(name => name.slice(0, -5)).sort();
  if (!ids.length || new Set(ids).size !== ids.length) throw new Error("TASK must select at least one unique task");
  return Promise.all(ids.map(id => loadTask(id, dir)));
}

const playwrightModule = () => pathToFileURL(join(new URL("..", import.meta.url).pathname, "apps/web/node_modules/playwright/index.mjs")).href;
async function preflightBrowser(tasks: EvalTask[]) {
  if (!tasks.some(task => task.checks.some(check => check.type === "browser_text"))) return;
  try { const { chromium } = await import(playwrightModule()); const browser = await chromium.launch({ headless: true }); await browser.close(); }
  catch { throw new Error("browser checks require Playwright and Chromium; run: cd apps/web && bun install --frozen-lockfile && bun node_modules/playwright/cli.js install chromium"); }
}

const bundle = (name: string, operation: string, collection: string) => {
  const record = { type: "object", additionalProperties: true, properties: { record_id: { type: "string" }, revision: { type: "integer" } }, required: ["record_id", "revision"] };
  const output_schema = operation === "list" ? { type: "array", items: record } : operation === "get" ? { anyOf: [record, { type: "null" }] } : record;
  return { format_version: 1, kind: "data_operation", name, description: `${operation} ${collection}`, input_schema: operation === "list" ? { type: "object", additionalProperties: false } : operation === "update" ? { type: "object", properties: { revision: { type: "integer" } }, required: ["revision"], additionalProperties: true } : { type: "object", additionalProperties: true }, output_schema, implementation: { operation, collection, data_schema: { type: "object", additionalProperties: true } } };
};
const CAPABILITIES_SCRIPT = `
import inspect, json
from achilles import tools
from achilles.pages import PageStore
names = list(getattr(tools, "BUILTIN_TOOL_NAMES", ("create_page", "create_tool")))
if "tools" in inspect.signature(PageStore.create_page).parameters:
    names.append("create_page_with_tools")
print(json.dumps(names))`;
export async function productCapabilities(stack: EvalStack) {
  const process = await stack.run("uv", ["run", "--project", stack.achillesDir, "python", "-c", CAPABILITIES_SCRIPT], stack.achillesDir);
  if (process.exitCode !== 0) throw new Error(`capability preflight failed: ${process.stderr}`);
  return new Set(JSON.parse(process.stdout) as string[]);
}
const SETUP_SCRIPT = `
import hashlib, json, sys
from pathlib import Path
from achilles.pages import PageStore, now
root, page_id, raw = sys.argv[1:]
setup = json.loads(raw); store = PageStore(Path(root)); store.set_create_mode(page_id, True)
for item in setup.get("tools", []): store.create_tool(page_id, item)
with store.transaction() as db:
    if "initial_layout" in setup:
        document = json.dumps(setup["initial_layout"], sort_keys=True, separators=(",", ":"))
        digest = hashlib.sha256(document.encode()).hexdigest()
        stamp = now()
        db.execute("UPDATE layout_version SET digest=?, document=?, created_at=? WHERE page_id=? AND version=1", (digest, document, stamp, page_id))
    for item in setup.get("records", []):
        stamp = now(); data = item["data"]
        db.execute("INSERT INTO page_record(page_id,collection,record_id,version,document,created_at,updated_at) VALUES(?,?,?,?,?,?,?)", (page_id,item["collection"],item["id"],1,json.dumps(data,sort_keys=True),stamp,stamp))
`;
async function preparePage(stack: EvalStack, task: EvalTask, signal: AbortSignal) {
  const plan = task.page_plan.find(page => page.source !== "created")!;
  if (task.setup) {
    const setup = { tools: task.setup.tools.map(tool => bundle(tool.name, tool.operation, tool.collection)), records: task.setup.records, ...(task.setup.initial_layout ? { initial_layout: task.setup.initial_layout } : {}) };
    const process = await stack.run("uv", ["run", "--project", stack.achillesDir, "python", "-c", SETUP_SCRIPT, join(stack.root, "achilles-home"), "home", JSON.stringify(setup)], stack.achillesDir);
    if (process.exitCode !== 0) throw new Error(`task setup failed: ${process.stderr}`);
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
out={"pages":q("select id,route,title from page"),"tools":q("select id,owner_page_id as page_id,name from tool"),"assignments":q("select page_id,tool_id,active_version from page_tool"),"records":q("select page_id,collection,record_id as id,document as data from page_record"),"layouts":q("select page_id,version,document from layout_version"),"tool_versions":q("select pt.page_id,t.id as tool_id,t.name,v.bundle from page_tool pt join tool t on t.id=pt.tool_id join tool_version v on v.tool_id=t.id and v.version=pt.active_version")}
for k in ("records","layouts"):
 for r in out[k]: r["data" if k=="records" else "document"]=json.loads(r["data" if k=="records" else "document"])
for r in out["tool_versions"]:
 b=json.loads(r.pop("bundle")); r["operation"]=b["implementation"]["operation"]; r["collection"]=b["implementation"]["collection"]; r["input_schema"]=b["input_schema"]; r["data_schema"]=b["implementation"]["data_schema"]
print(json.dumps(out))`;
const BUNDLE_VALIDATION_SCRIPT = `import inspect,json,sys,uuid
from achilles.tools import validate_bundle
attempts=json.loads(sys.argv[1]); out=[]
for attempt in attempts:
 bundle={**attempt["bundle"],"name":f"eval_{uuid.uuid4().hex[:8]}"}
 try:
  kwargs={"reject_conflicting_output":True} if "reject_conflicting_output" in inspect.signature(validate_bundle).parameters else {}
  validate_bundle(bundle,**kwargs); valid=True
 except Exception: valid=False
 out.append({"call_id":attempt["call_id"],"valid":valid})
print(json.dumps(out))`;
export async function validateReservedBundles(stack: EvalStack, calls: Record<string, unknown>[], results: Record<string, unknown>[]) {
  const failed = new Set(results.filter(row => row.success === false || row.is_error === true).map(row => row.call_id));
  const attempts = calls.filter(row => row.tool === "achilles__create_tool" && failed.has(row.id)).flatMap(row => {
    const args = row.arguments; const candidate = args && typeof args === "object" ? (args as Record<string, unknown>).bundle : undefined;
    return candidate && typeof candidate === "object" && !Array.isArray(candidate) ? [{ call_id: row.id, bundle: candidate }] : [];
  });
  if (!attempts.length) return [];
  const process = await stack.run("uv", ["run", "--project", stack.achillesDir, "python", "-c", BUNDLE_VALIDATION_SCRIPT, JSON.stringify(attempts)], stack.achillesDir);
  if (process.exitCode !== 0) throw new Error(`bundle validation snapshot failed: ${process.stderr}`);
  return JSON.parse(process.stdout) as Array<Record<string, unknown>>;
}
async function databaseSnapshot(stack: EvalStack) {
  const process = await stack.run("uv", ["run", "python", "-c", SNAPSHOT_SCRIPT, join(stack.root, "achilles-home", "achilles.sqlite3")]);
  if (process.exitCode !== 0) throw new Error(`snapshot failed: ${process.stderr}`); return JSON.parse(process.stdout) as EvalSnapshot;
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
  signal.throwIfAborted(); const { chromium } = await import(playwrightModule()); const browser = await chromium.launch({ headless: true });
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
  const events: Record<string, any>[] = []; const sessions = new Map<string, { id: string; alias: string; page_id: string; binding: { cwd: string; mcp_bindings: Array<{ server: string; headers: { Authorization: string } }> } }>(); const terminals = new Map<string, number>(); const histories = new Map<string, any[]>(); const pages = new Map<string, string>();
  const reconnects: Array<Record<string, any>> = [];
  for (const plan of task.page_plan.filter(page => page.source !== "created")) pages.set(plan.alias, "home");
  let turns = 0; let fatal: Error | undefined; let protocol: EvalProtocol;
  const approvals: Record<string, unknown>[] = []; const abortAll = async () => Promise.all([...sessions.values()].map(session => protocol.abort(session.id).catch(() => undefined)));
  const onEvent = (event: Record<string, any>) => {
    events.push(event);
    const eventFailure = new Error(JSON.stringify(event)); if (!fatal && stopsSuite(eventFailure)) { fatal = eventFailure; void abortAll(); return; }
    if (event.event === "turn_start" && ++turns > task.agent_turns && !fatal) { fatal = new TurnCapFailure("task model turn limit exceeded"); void abortAll(); }
    if (event.event !== "approval_request") return;
    const session = [...sessions.entries()].find(([, value]) => value.id === event.session_id); const requestId = event.data?.request_id ?? event.request_id;
    if (task.approval_mode !== "ask" || !requestId || !session) { fatal = new Error("undeclared approval request"); void abortAll(); return; }
    const request = event.data ?? event; approvals.push({ request_id: requestId, chat_id: session[0], page_id: session[1].page_id, tool: request.tool_call?.name }); void protocol.approve(session[1].id, String(requestId)).catch(error => { fatal = error; });
  };
  protocol = await connectEvalProtocol(discovery, onEvent, { retryCapacity: true, signal }); const started = Date.now();
  const getSession = async (chat: string, alias: string) => {
    if (sessions.has(chat)) return sessions.get(chat)!; const plan = task.page_plan.find(page => page.alias === alias)!;
    let pageId = plan.source === "created" ? undefined : pages.get(alias)!;
    if (plan.source === "created") pageId = createdPageId(events, plan) ?? String((await databaseSnapshot(stack)).pages?.find(page => page.route === plan.route)?.id ?? "");
    if (!pageId) return undefined; pages.set(alias, pageId);
    if (plan.source === "created") { const mode = await fetchDeadline(`${stack.achillesOrigin}/api/pages/${pageId}/create-mode`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled: plan.create_mode }) }, signal); if (!mode.ok) throw new Error(`could not set create mode for ${alias}`); }
    const page = await pageBinding(stack, pageId, hidden, signal); const binding = { cwd: page.page.workspace, mcp_bindings: [{ server: "achilles", headers: { Authorization: `Bearer ${page.credential}` } }] }; const created = await protocol.newSession({ ...binding, provider: stack.provider, model: stack.model, approval_mode: task.approval_mode ?? "allow" });
    const id = String(created.session?.session_id ?? created.session_id ?? ""); if (!id) throw new Error("new_session returned no session id");
    const registration = await fetchDeadline(`${stack.achillesOrigin}/api/pages/${pageId}/chats`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ session_id: id }) }, signal); if (!registration.ok) throw new Error(`chat registration failed (${registration.status})`);
    const session = { id, alias, page_id: pageId, binding }; sessions.set(chat, session); return session;
  };
  try {
    for (const step of task.steps) {
      signal.throwIfAborted(); if (fatal) throw fatal; if (turns >= task.agent_turns && step.kind !== "reconnect") throw new TurnCapFailure("task model turn limit has no remaining turn");
      if (step.kind === "reconnect") { const session = sessions.get(step.chat); if (!session) throw new Error(`cannot reconnect missing chat ${step.chat}`); const before = await protocol.sessionHistory(session.id); await protocol.close(); protocol = await connectEvalProtocol(discovery, onEvent, { retryCapacity: true, signal }); const resumed = await protocol.resume(session.id, session.binding); reconnects.push({ page_id: session.page_id, chat: step.chat, original_session_id: session.id, resumed_session_id: String(resumed.session?.session_id ?? resumed.session_id ?? ""), pre_history_ids: before.map((row: any) => row.id).filter(Boolean) }); continue; }
      const session = await getSession(step.chat, step.page); if (!session) break; try { await protocol.send(session.id, step.prompt ?? task.prompt!); } catch (error) { const detail = error as Error & { sessionId?: string; pageId?: string }; detail.sessionId = session.id; detail.pageId = session.page_id; throw detail; } const terminal = await waitForTerminal(protocol, session.id, terminals.get(session.id) ?? 0, () => fatal, signal); terminals.set(session.id, terminal.count); histories.set(step.chat, terminal.history);
    }
    for (const [chat, session] of sessions) if (!histories.has(chat)) histories.set(chat, await protocol.sessionHistory(session.id));
    const durable = [...histories].map(([chat, rows]) => ({ chat, page_id: sessions.get(chat)!.page_id, rows })); const tools = parseHistory(durable); const after = await databaseSnapshot(stack);
    for (const plan of task.page_plan.filter(page => page.source === "created" && !pages.has(page.alias))) { const pageId = pageIdFromResults(tools.results, plan); if (pageId) pages.set(plan.alias, pageId); }
    for (const page of after.pages ?? []) { const plan = task.page_plan.find(candidate => pages.get(candidate.alias) === page.id); if (plan) page.alias = plan.alias; }
    const chats = durable.map(history => ({ chat_id: history.chat, page_id: history.page_id, session_id: sessions.get(history.chat)!.id, history: JSON.stringify(history.rows), first_prompt: task.steps.find(step => step.chat === history.chat)?.prompt ?? task.prompt }));
    for (const reconnect of reconnects) { const ids = new Set((histories.get(reconnect.chat) ?? []).map(row => row.id)); reconnect.history_continuity = reconnect.pre_history_ids.length > 0 && reconnect.pre_history_ids.every((id: string) => ids.has(id)); delete reconnect.pre_history_ids; }
    const usage = await readTranscriptUsage(join(stack.root, "zeta-home"), [...sessions.values()].map(session => session.id));
    const snapshot: EvalSnapshot = { ...after, ...tools, approvals, reconnects, chats, bundle_validations: await validateReservedBundles(stack, tools.calls, tools.results), browser: await browserRows(stack, task, pages, after, signal), related_page_ids: relatedPages(initial, after, tools.calls), turns, wall_ms: Date.now() - started, usage: usage === "unavailable" ? undefined : usage, session_history: durable.flatMap(history => history.rows) };
    return { result: gradeTask(task, snapshot), snapshot };
  } catch (error) {
    for (const [chat, session] of sessions) if (!histories.has(chat)) { const history = await protocol.sessionHistory(session.id).catch(() => []); if (history.length) histories.set(chat, history); }
    const durable = [...histories].map(([chat, rows]) => ({ chat, page_id: sessions.get(chat)!.page_id, rows })); const tools = parseHistory(durable); const after = await databaseSnapshot(stack).catch(() => ({} as EvalSnapshot));
    const bundle_validations = await validateReservedBundles(stack, tools.calls, tools.results).catch(() => []);
    throw new TaskRunFailure(error, { ...after, ...tools, approvals, reconnects, bundle_validations, turns, wall_ms: Date.now() - started, session_history: durable.flatMap(history => history.rows) });
  } finally { clearTimeout(timer); if (fatal || signal.aborted) await abortAll(); await protocol.close(); }
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
    const turn = requests.length; const prompt = JSON.stringify((body.messages as unknown[]) ?? []);
    let toolCalls: unknown[] = [];
    if (prompt.includes("/run-review") && turn === 1 && Bun.env.EVAL_SKIP_CREATE_PAGE !== "1") toolCalls = [{ function: { name: "achilles__create_page", arguments: { route: "/run-review", title: "Run Review", layout: { blocks: [] } } } }];
    else if (prompt.includes("add_note once")) {
      if (turn === 1) toolCalls = [{ function: { name: "achilles__add_note", arguments: { text: "reconnect note" } } }];
      else if (prompt.includes("after reconnect") && turn === 3) toolCalls = [{ function: { name: "achilles__list_notes", arguments: {} } }];
    }
    else if (prompt.includes("/eval-smoke") && turn === 1) toolCalls = [{ function: { name: "achilles__create_page", arguments: { route: "/eval-smoke", title: "Eval Smoke", layout: { blocks: [{ type: "text", text: "smoke" }] } } } }];
    else if (turn === 1) toolCalls = [{ function: { name: "achilles__create_tool", arguments: { bundle: bundle("add_note", "insert", "notes") } } }];
    else if (turn === 2) toolCalls = [{ function: { name: "achilles__add_note", arguments: { text: "synthetic note" } } }];
    return new Response(`${JSON.stringify({ message: { content: toolCalls.length ? "" : "done", ...(toolCalls.length ? { tool_calls: toolCalls } : {}) }, done: true, done_reason: toolCalls.length ? "tool_calls" : "stop", prompt_eval_count: 7, eval_count: 3 })}\n`, { headers: { "content-type": "application/x-ndjson" } });
  } });
  return { requests, url: `http://127.0.0.1:${server.port}`, close: () => server.stop(true) };
}
function catalogProof(requests: Record<string, unknown>[], task: EvalTask) {
  const catalogs = requests.map(request => ((request.tools ?? []) as { function?: { name?: string } }[]).map(tool => tool.function?.name).filter((name): name is string => Boolean(name)));
  const required = task.page_plan.some(page => page.create_mode) ? "achilles__create_tool" : task.setup?.tools[0] ? `achilles__${task.setup.tools[0].name}` : undefined;
  catalogs.forEach(catalog => validateCatalog(catalog)); if (required) validateCatalog(catalogs[0] ?? [], required); return [...new Set(catalogs.flat())];
}
export function failureResult(task: EvalTask, error: unknown, hidden: string[]) {
  const detail = error as Error & { code?: number; method?: string; sessionId?: string; pageId?: string };
  return { task_id: task.id, status: "harness_error", pass: false, score: 0, checks: [{ id: "harness", pass: false, expected: "successful run", actual: "harness error", evidence: { message: redact(detail instanceof Error ? detail.message : String(error), hidden), method: detail.method, code: detail.code, session_id: detail.sessionId, page_id: detail.pageId } }], turns: 0, wall_ms: 0, tool_calls: 0, approvals: 0, usage: "unavailable", host_tools_gap: false, diagnostics: { first_call_validity: {}, structured_tool_errors: [], unstructured_tool_errors: 1 } } as ReturnType<typeof gradeTask>;
}
export function unsupportedResult(task: EvalTask, missing: string[]) {
  return { task_id: task.id, status: "unsupported", pass: false, score: 0, checks: [{ id: "capability", pass: false, expected: task.requires, actual: [...(task.requires ?? []).filter(item => !missing.includes(item))], evidence: { missing } }], turns: 0, wall_ms: 0, tool_calls: 0, approvals: 0, usage: "unavailable", host_tools_gap: false, diagnostics: { first_call_validity: {}, structured_tool_errors: [], unstructured_tool_errors: 0 } } as ReturnType<typeof gradeTask>;
}
export async function classifyTaskSupport(stack: EvalStack, task: EvalTask, hidden: string[]) {
  try {
    const capabilities = await productCapabilities(stack); const missing = (task.requires ?? []).filter(capability => !capabilities.has(capability));
    const result = missing.length ? unsupportedResult(task, missing) : undefined;
    if (result) Object.defineProperty(result, "capabilities", { value: capabilities });
    return result;
  } catch (error) { return failureResult(task, error, hidden); }
}

type RepeatResult = { result: ReturnType<typeof gradeTask>; snapshot?: EvalSnapshot; cleanup?: CleanupProof; catalog: string[]; achilles_sha?: string; zeta_sha?: string; failed: boolean; stop_suite?: boolean };
async function runRepeat(task: EvalTask, index: number, options: { scripted: boolean; achillesDir?: string; keep: boolean; runId: string; signal: AbortSignal; hidden: string[] }): Promise<RepeatResult> {
  const provider = options.scripted ? scriptedProvider() : undefined; let stack: EvalStack | undefined; let result: ReturnType<typeof gradeTask> | undefined; let snapshot: EvalSnapshot | undefined; let failed = false; let stopSuite = false; let catalog: string[] = [];
  const retainedRoot = options.keep ? resolve(new URL(`../.cache/evals/${options.runId}/repeat-${index + 1}`, import.meta.url).pathname) : undefined;
  try {
    stack = await startEvalStack({ achillesDir: options.achillesDir, zetaRev: Bun.env.ZETA_REV, model: options.scripted ? "ollama/qwen3:4b" : Bun.env.MODEL, ollamaBaseUrl: provider?.url, maxTurns: task.agent_turns, signal: options.signal, beforeDelete: root => sanitizeAndScanRoot(root, options.hidden) });
    options.hidden.push(...hiddenValues(stack.accountHome));
    if (Bun.env.EVAL_SETUP_ONLY === "1") { const started = Date.now(); await preparePage(stack, task, options.signal); snapshot = await databaseSnapshot(stack); result = { task_id: task.id, pass: true, score: 100, checks: [], turns: 0, wall_ms: Date.now() - started, tool_calls: 0, approvals: 0, usage: "unavailable", host_tools_gap: false, diagnostics: { first_call_validity: {}, structured_tool_errors: [], unstructured_tool_errors: 0 }, status: "pass" } as ReturnType<typeof gradeTask>; }
    else {
      const classification = await classifyTaskSupport(stack, task, options.hidden);
      if (classification) { result = classification; failed = classification.status === "harness_error"; snapshot = failed ? await databaseSnapshot(stack).catch(() => ({})) : await databaseSnapshot(stack); }
      else { ({ result, snapshot } = await driveTask(stack, task, options.hidden, options.signal)); result = gradeReference(task, snapshot!); const capabilities = (await productCapabilities(stack)); const missingGoal = (task.goal_capabilities ?? []).find(capability => !capabilities.has(capability)); if (missingGoal && result.status === "agent_fail" && !task.requires?.length) result = { ...result, gap: `capability_missing:${missingGoal}` } as ReturnType<typeof gradeTask>; }
    }
    if (provider?.requests.length) catalog = catalogProof(provider.requests, task); result.diagnostics.observed_catalog = catalog;
  } catch (error) { const original = error instanceof TaskRunFailure ? error.original : error; if (error instanceof TaskRunFailure) snapshot = error.snapshot; else if (stack) snapshot = await databaseSnapshot(stack).catch(() => ({})); stopSuite = stopsSuite(original);
    if (original instanceof TurnCapFailure) result = { ...gradeReference(task, snapshot ?? {}), pass: false, status: "agent_fail", cap_hit: true } as ReturnType<typeof gradeTask>;
    else { failed = true; result = failureResult(task, stopSuite ? new Error("suite stopped after an account, login, quota, or secret-scan failure") : original, options.hidden); }
    if (provider?.requests.length) { try { catalog = catalogProof(provider.requests, task); } catch (catalogError) { failed = true; result = failureResult(task, catalogError, options.hidden); } } }
  finally { provider?.close(); }
  if (!stack) return { result: result!, catalog, failed: true, stop_suite: stopSuite };
  let cleanup: CleanupProof | undefined;
  try {
    try { await Bun.write(join(stack.root, "result.json"), JSON.stringify(result, null, 2)); await Bun.write(join(stack.root, "snapshot.json"), JSON.stringify(snapshot ?? null, null, 2)); await collectSensitiveFiles(stack.root, options.hidden); }
    finally { cleanup = await stack.close(); }
    await Bun.write(join(stack.root, "cleanup.json"), JSON.stringify(cleanup, null, 2)); await sanitizeAndScanRoot(stack.root, options.hidden);
    if (retainedRoot) { await mkdir(join(retainedRoot, ".."), { recursive: true }); await cp(stack.root, retainedRoot, { recursive: true, force: true }); await scanArtifactTree(retainedRoot, options.hidden); }
  } catch (error) { failed = true; stopSuite ||= stopsSuite(error); result = failureResult(task, new Error(stopSuite ? "suite stopped after a secret-scan failure" : "artifact finalization failed"), options.hidden); if (retainedRoot) await rm(retainedRoot, { recursive: true, force: true }); }
  finally { await stack.close().catch(() => undefined); await rm(stack.root, { recursive: true, force: true }); }
  return { result: result!, snapshot, cleanup, catalog, achilles_sha: stack.achillesSha, zeta_sha: stack.zetaSha, failed, stop_suite: stopSuite };
}

async function writeReportArtifacts(staging: string, report: ReturnType<typeof makeReport>, repeats: RepeatResult[]) {
  await Bun.write(join(staging, "report.json"), reportJson(report)); await Bun.write(join(staging, "report.md"), reportMarkdown(report)); await Bun.write(join(staging, "cleanup.json"), JSON.stringify(repeats.map(repeat => repeat.cleanup ?? null), null, 2));
  await mkdir(join(staging, "snapshots")); const seen = new Map<string, number>(); for (const repeat of repeats) { const number = (seen.get(repeat.result.task_id) ?? 0) + 1; seen.set(repeat.result.task_id, number); await Bun.write(join(staging, "snapshots", `${repeat.result.task_id}-${number}.json`), JSON.stringify(repeat.snapshot ?? null, null, 2)); }
}
async function publishReport(tasks: EvalTask[], repeats: RepeatResult[], output: string, runId: string, hidden: string[]) {
  const first = repeats[0]; const seen = new Map<string, number>(); const reportTasks = repeats.map(repeat => { const number = (seen.get(repeat.result.task_id) ?? 0) + 1; seen.set(repeat.result.task_id, number); return { ...repeat.result, transcript: `snapshots/${repeat.result.task_id}-${number}.json` }; }); const completedRepeats = Math.max(0, ...seen.values()); let publicationFailed = false; let report = makeReport({ run_id: runId, repeats: completedRepeats, agent: { provider: Bun.env.EVAL_BACKEND === "scripted" ? "scripted" : "configured", model: Bun.env.EVAL_BACKEND === "scripted" ? "offline" : Bun.env.MODEL ?? "configured", tool_policy: TOOL_POLICY, observed_catalog: first.catalog, achilles_sha: first.achilles_sha, zeta_sha: first.zeta_sha }, totals: { turns: repeats.reduce((total, repeat) => total + repeat.result.turns, 0), wall_ms: repeats.reduce((total, repeat) => total + repeat.result.wall_ms, 0) }, tasks: reportTasks });
  const staging = await mkdtemp(join(Bun.env.TMPDIR ?? "/tmp", "achilles-eval-report-"));
  try {
    await writeReportArtifacts(staging, report, repeats);
    try { await scanArtifactTree(staging, hidden); }
    catch {
      publicationFailed = true; await rm(staging, { recursive: true, force: true }); await mkdir(staging);
      report = makeReport({ ...report, tasks: repeats.map(repeat => failureResult(tasks.find(task => task.id === repeat.result.task_id)!, new Error("artifact secret scan failed"), [])) }); await writeReportArtifacts(staging, report, repeats.map(repeat => ({ ...repeat, snapshot: undefined }))); await scanArtifactTree(staging, hidden);
    }
    await mkdir(output, { recursive: true }); await cp(staging, output, { recursive: true, force: true });
  } finally { await rm(staging, { recursive: true, force: true }); }
  const pass = !publicationFailed && repeats.length === tasks.length * completedRepeats && repeats.every(repeat => (repeat.result.pass || repeat.result.status === "unsupported") && !repeat.failed); console.log(JSON.stringify({ tasks: tasks.map(task => task.id), pass, repeats: completedRepeats, report: output, achilles_sha: first.achilles_sha, zeta_sha: first.zeta_sha })); return pass;
}

async function runStackOnly(task: EvalTask, controller: AbortController, hidden: string[]) {
  const retained = resolve(new URL(`../.cache/evals/${Date.now()}-${process.pid}/stack`, import.meta.url).pathname); const stack = await startEvalStack({ achillesDir: Bun.env.ACHILLES_DIR, zetaRev: Bun.env.ZETA_REV, model: Bun.env.MODEL, maxTurns: task.agent_turns, signal: controller.signal, beforeDelete: root => sanitizeAndScanRoot(root, hidden) }); hidden.push(...hiddenValues(stack.accountHome));
  console.log(JSON.stringify({ achilles: stack.achillesOrigin, zeta: stack.zetaOrigin, model: `${stack.provider}/${stack.model}`, achilles_sha: stack.achillesSha, zeta_sha: stack.zetaSha, retained_state: retained }));
  try { await new Promise<void>(resolveWait => controller.signal.addEventListener("abort", () => resolveWait(), { once: true })); }
  finally { let cleanup: CleanupProof; try { await collectSensitiveFiles(stack.root, hidden); } finally { cleanup = await stack.close(); } await Bun.write(join(stack.root, "cleanup.json"), JSON.stringify(cleanup, null, 2)); await sanitizeAndScanRoot(stack.root, hidden); await mkdir(join(retained, ".."), { recursive: true }); await cp(stack.root, retained, { recursive: true, force: true }); await scanArtifactTree(retained, hidden); await rm(stack.root, { recursive: true, force: true }); }
}

async function main() {
  const suiteArg = Bun.argv.indexOf("--suite"); const selection = Bun.env.TASK ?? (suiteArg >= 0 ? Bun.argv[suiteArg + 1] : undefined); const repeats = Number(Bun.env.N ?? "1");
  if (!Number.isInteger(repeats) || repeats < 1) throw new Error("N must be at least 1"); const tasks = await selectTasks(selection); assertTurnBudget(reserveTurns(tasks, repeats)); await preflightBrowser(tasks);
  const controller = new AbortController(); let signalCode = 0; const interrupt = (code: number) => { signalCode ||= code; controller.abort(new Error("eval interrupted")); };
  const onSigint = () => interrupt(130); const onSigterm = () => interrupt(143); process.once("SIGINT", onSigint); process.once("SIGTERM", onSigterm); const hidden = hiddenValues();
  try {
    if (Bun.env.EVAL_STACK_ONLY === "1") { if (tasks.length !== 1) throw new Error("EVAL_STACK_ONLY requires one task"); await runStackOnly(tasks[0], controller, hidden); }
    else {
      const runId = `${Date.now()}-${process.pid}`; const output = resolve(Bun.env.REPORT_DIR ?? join(new URL("../evals/reports/", import.meta.url).pathname, runId)); const results: RepeatResult[] = [];
      suite: for (const task of tasks) for (let index = 0; index < repeats; index++) { if (controller.signal.aborted) break suite; const repeat = await runRepeat(task, index, { scripted: Bun.env.EVAL_BACKEND === "scripted", achillesDir: Bun.env.ACHILLES_DIR, keep: Bun.env.KEEP_EVAL === "1", runId: `${runId}-${task.id}`, signal: controller.signal, hidden }); results.push(repeat); if (repeat.stop_suite) break suite; }
      if (!await publishReport(tasks, results, output, runId, hidden)) process.exitCode = 1;
    }
  } finally { process.off("SIGINT", onSigint); process.off("SIGTERM", onSigterm); if (signalCode) process.exitCode = signalCode; }
}
if (import.meta.main) { await main(); if (Bun.env.EVAL_SKIP_EXPLICIT_EXIT !== "1") process.exit(process.exitCode ?? 0); }
