import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { startEvalStack, TOOL_POLICY, type EvalStack } from "./eval-stack";
import { connectEvalProtocol, REQUIRED_FEATURES } from "./eval-protocol";
import { assertTurnBudget, reserveTurns } from "./eval-protocol";

export { startEvalStack, TOOL_POLICY } from "./eval-stack";
export { assertTurnBudget, reserveTurns, REQUIRED_FEATURES, connectEvalProtocol, enforceTurnBudget } from "./eval-protocol";
export type { EvalStackConfig, EvalStack } from "./eval-stack";

export type EvalTask = { id: string; agent_turns: number; judge_turns?: number; prompts?: string[] };
export type EvalResult = { task: string; pass: boolean; turns: number; model: string; provider: string; tool_policy: string; error?: string };

const SMOKE_PROMPT = "Call the Achilles create_page tool now with route /eval-smoke, title Eval Smoke, and a layout containing one text block whose text is smoke. Do not only describe the call.";
const secrets = (value: string, hidden: string[]) => hidden.reduce((text, secret) => secret ? text.replaceAll(secret, "[REDACTED]") : text, value);
export function scanSecrets(value: string, hidden: string[] = []): void {
  if (hidden.some(secret => secret && value.includes(secret))) throw new Error("artifact contains a known secret");
  const scrubbed = secrets(value, hidden);
  if (/\b(?:sk-[A-Za-z0-9_-]{16,}|Bearer\s+[A-Za-z0-9._~+/=-]{12,}|gh[pousr]_[A-Za-z0-9_]{20,})\b/i.test(scrubbed)) throw new Error("artifact contains a secret-shaped value");
}
export function reportJson(result: EvalResult) { return JSON.stringify({ ...result, tool_policy: result.tool_policy }, null, 2) + "\n"; }
export function reportMarkdown(result: EvalResult) { return `# achilles eval: ${result.task}\n\n- result: ${result.pass ? "pass" : "fail"}\n- model: ${result.provider}/${result.model}\n- tool set: \`${result.tool_policy}\`\n- observed turns: ${result.turns}\n${result.error ? `- error: ${result.error}\n` : ""}`; }

async function runBoundSmoke(stack: EvalStack) {
  const discovery = await fetch(`${stack.achillesOrigin}/api/zeta/discovery`).then(response => response.json()) as { url: string; controller_token: string };
  const page = await fetch(`${stack.achillesOrigin}/api/pages/home`).then(response => response.json()) as { workspace: string };
  const createMode = await fetch(`${stack.achillesOrigin}/api/pages/home/create-mode`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled: true }) });
  if (!createMode.ok) throw new Error(`could not enable create mode (${createMode.status})`);
  const credential = await fetch(`${stack.achillesOrigin}/api/pages/home/credential`).then(response => response.json()) as { credential: string };
  const events: Record<string, unknown>[] = [];
  const protocol = await connectEvalProtocol(discovery, event => events.push(event));
  try {
    const session = await protocol.newSession({ cwd: page.workspace, mcp_bindings: [{ server: "achilles", headers: { Authorization: `Bearer ${credential.credential}` } }] });
    const sessionId = (session.session?.session_id ?? session.session_id) as string;
    if (!sessionId) throw new Error("new_session returned no session id");
    await fetch(`${stack.achillesOrigin}/api/pages/home/chats`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ session_id: sessionId }) });
    await protocol.send(sessionId, SMOKE_PROMPT);
    const deadline = Date.now() + 90_000;
    while (!events.some(event => event.event === "agent_end")) {
      if (Date.now() >= deadline) {
        const turns = events.filter(event => event.event === "turn_start").length;
        throw new Error(turns ? "provider turn did not finish within 90s" : "no provider turn started within 90s; inspect the scrubbed zeta serve log");
      }
      await Bun.sleep(100);
    }
    const successful = events.find(event => event.event === "tool_end" && (event.tool_call as { name?: string })?.name?.startsWith("achilles__") && !(event.tool_result as { is_error?: boolean })?.is_error);
    if (!successful) throw new Error("smoke completed without a successful achilles tool result");
    return { events, history: await protocol.sessionHistory(sessionId) };
  } finally { protocol.close(); }
}

async function scriptedSmoke() {
  const requests: Record<string, unknown>[] = [];
  const provider = Bun.serve({ port: 0, async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/api/show") return Response.json({ model_info: { "qwen2.context_length": 32_768 } });
    if (url.pathname !== "/api/chat") return new Response("not found", { status: 404 });
    const body = await request.json() as Record<string, unknown>;
    requests.push(body);
    const turn = requests.length;
    const toolCalls = turn === 1 ? [
      { function: { name: "mcp_discover", arguments: { action: "search", query: "" } } },
      { function: { name: "mcp_discover", arguments: { action: "search", query: "list_notes" } } },
    ] : turn === 2 ? [
      { function: { name: "achilles__create_page", arguments: { route: "/eval-smoke", title: "Eval Smoke", layout: { blocks: [{ type: "text", text: "smoke" }] } } } },
    ] : [];
    return new Response(`${JSON.stringify({ message: { content: toolCalls.length ? "" : "done", ...(toolCalls.length ? { tool_calls: toolCalls } : {}) }, done: true, done_reason: toolCalls.length ? "tool_calls" : "stop" })}\n`, { headers: { "content-type": "application/x-ndjson" } });
  } });
  let stack: EvalStack | undefined;
  try {
    stack = await startEvalStack({ model: "ollama/qwen3:4b", ollamaBaseUrl: `http://127.0.0.1:${provider.port}`, maxTurns: 3 });
    const observed = await runBoundSmoke(stack);
    const firstTools = ((requests[0]?.tools ?? []) as { function?: { name?: string } }[]).map(tool => tool.function?.name);
    if (!firstTools.includes("achilles__create_page")) throw new Error(`model-visible catalog lacks achilles tools: ${firstTools.join(", ")}`);
    const secondMessages = JSON.stringify(requests[1]?.messages ?? []);
    if (!secondMessages.includes("achilles__create_page") || !secondMessages.includes("No matching MCP tools.")) throw new Error("scripted discovery did not observe the bound catalog and the expected missing list_notes tool");
    if (!observed.history.some(row => JSON.stringify(row).includes("achilles__create_page"))) throw new Error("scripted history lacks the achilles tool result");
    return observed.events.filter(event => event.event === "turn_start").length;
  } finally {
    await stack?.close();
    provider.stop(true);
  }
}

async function main() {
  const taskId = Bun.env.TASK ?? Bun.argv[Bun.argv.indexOf("--suite") + 1] ?? "harness-smoke";
  const repeats = Math.max(1, Number(Bun.env.N ?? "1"));
  const task: EvalTask = { id: taskId, agent_turns: 3 };
  assertTurnBudget(reserveTurns([task], repeats));
  const scripted = Bun.env.EVAL_BACKEND === "scripted";
  const stack = scripted ? null : await startEvalStack({ achillesDir: Bun.env.ACHILLES_DIR, model: Bun.env.MODEL, maxTurns: task.agent_turns, keep: Bun.env.KEEP_EVAL === "1" });
  const result: EvalResult = { task: task.id, pass: true, turns: 0, provider: stack?.provider ?? "scripted", model: stack?.model ?? "offline", tool_policy: TOOL_POLICY };
  if (scripted) result.turns = await scriptedSmoke();
  else if (stack) result.turns = (await runBoundSmoke(stack)).events.filter(event => event.event === "turn_start").length;
  const runId = `${Date.now()}-${process.pid}`;
  const output = resolve(Bun.env.REPORT_DIR ?? join(new URL("..", import.meta.url).pathname, "evals/reports", runId));
  try { await mkdir(output, { recursive: true }); scanSecrets(reportJson(result)); await Bun.write(join(output, "report.json"), reportJson(result)); await Bun.write(join(output, "report.md"), reportMarkdown(result)); if (stack) console.log(JSON.stringify({ achilles: stack.achillesOrigin, model: `${stack.provider}/${stack.model}`, tool_policy: TOOL_POLICY, report: output, retained_state: stack.root })); }
  finally { await stack?.close(); }
}
if (import.meta.main) await main();
