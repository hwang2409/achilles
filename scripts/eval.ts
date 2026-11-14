import { mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { startEvalStack, TOOL_POLICY } from "./eval-stack";
import { connectEvalProtocol, REQUIRED_FEATURES } from "./eval-protocol";
import { assertTurnBudget, reserveTurns } from "./eval-protocol";

export { startEvalStack, TOOL_POLICY } from "./eval-stack";
export { assertTurnBudget, reserveTurns, REQUIRED_FEATURES, connectEvalProtocol, enforceTurnBudget } from "./eval-protocol";
export type { EvalStackConfig, EvalStack } from "./eval-stack";

export type EvalTask = { id: string; agent_turns: number; judge_turns?: number; prompts?: string[] };
export type EvalResult = { task: string; pass: boolean; turns: number; model: string; provider: string; tool_policy: string; error?: string };

const secrets = (value: string, hidden: string[]) => hidden.reduce((text, secret) => secret ? text.replaceAll(secret, "[REDACTED]") : text, value);
export function scanSecrets(value: string, hidden: string[] = []): void {
  if (hidden.some(secret => secret && value.includes(secret))) throw new Error("artifact contains a known secret");
  const scrubbed = secrets(value, hidden);
  if (/\b(?:sk-[A-Za-z0-9_-]{16,}|Bearer\s+[A-Za-z0-9._~+/=-]{12,}|gh[pousr]_[A-Za-z0-9_]{20,})\b/i.test(scrubbed)) throw new Error("artifact contains a secret-shaped value");
}
export function reportJson(result: EvalResult) { return JSON.stringify({ ...result, tool_policy: result.tool_policy }, null, 2) + "\n"; }
export function reportMarkdown(result: EvalResult) { return `# achilles eval: ${result.task}\n\n- result: ${result.pass ? "pass" : "fail"}\n- model: ${result.provider}/${result.model}\n- tool set: \`${result.tool_policy}\`\n- observed turns: ${result.turns}\n${result.error ? `- error: ${result.error}\n` : ""}`; }

async function scriptedHello() {
  const server = Bun.serve<{ ok: boolean }>({ port: 0, fetch(request, server) { if (server.upgrade(request, { data: { ok: true } })) return; return new Response("not found", { status: 404 }); }, websocket: { message(socket, raw) { const request = JSON.parse(String(raw)); if (request.jsonrpc !== "2.0" || request.params?.protocol_version !== "1.1") throw new Error("scripted hello did not negotiate protocol 1.1"); if (request.method === "hello") socket.send(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { capabilities: { requests: REQUIRED_FEATURES } } })); }, open() {}, close() {} } });
  try { await connectEvalProtocol({ url: `ws://127.0.0.1:${server.port}`, controller_token: "scripted-token" }); } finally { server.stop(true); }
}

async function main() {
  const taskId = Bun.env.TASK ?? Bun.argv[Bun.argv.indexOf("--suite") + 1] ?? "harness-smoke";
  const repeats = Math.max(1, Number(Bun.env.N ?? "1"));
  const task: EvalTask = { id: taskId, agent_turns: 3 };
  assertTurnBudget(reserveTurns([task], repeats));
  if (Bun.env.EVAL_BACKEND === "scripted") await scriptedHello();
  const stack = Bun.env.EVAL_BACKEND === "scripted" ? null : await startEvalStack({ achillesDir: Bun.env.ACHILLES_DIR, model: Bun.env.MODEL, keep: Bun.env.KEEP_EVAL === "1" });
  const result: EvalResult = { task: task.id, pass: true, turns: 0, provider: stack?.provider ?? "scripted", model: stack?.model ?? "offline", tool_policy: TOOL_POLICY };
  if (stack && Bun.env.EVAL_BACKEND !== "scripted") {
    const discovery = await fetch(`${stack.achillesOrigin}/api/zeta/discovery`).then(response => response.json()) as { url: string; controller_token: string };
    const page = await fetch(`${stack.achillesOrigin}/api/pages/home`).then(response => response.json()) as { workspace: string };
    const credential = await fetch(`${stack.achillesOrigin}/api/pages/home/credential`).then(response => response.json()) as { credential: string };
    const events: Record<string, unknown>[] = [];
    const protocol = await connectEvalProtocol(discovery, event => events.push(event));
    try {
      const session = await protocol.newSession({ cwd: page.workspace, mcp_bindings: [{ server: "achilles", headers: { Authorization: `Bearer ${credential.credential}` } }] });
      const sessionId = (session.session?.session_id ?? session.session_id) as string;
      if (!sessionId) throw new Error("new_session returned no session id");
      await fetch(`${stack.achillesOrigin}/api/pages/home/chats`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ session_id: sessionId }) });
      await protocol.send(sessionId, "run the harness smoke task");
      const deadline = Date.now() + 90_000;
      while (!events.some(event => event.method === "served_turn_end")) { if (Date.now() >= deadline) { const turns = events.filter(event => event.method === "turn_start").length; throw new Error(turns ? "provider turn did not finish within 90s" : "no provider turn started within 90s; inspect the scrubbed zeta serve log"); } await Bun.sleep(100); }
      result.turns = events.filter(event => event.method === "turn_start").length;
    } finally { protocol.close(); }
  }
  const runId = `${Date.now()}-${process.pid}`;
  const output = resolve(Bun.env.REPORT_DIR ?? join(new URL("..", import.meta.url).pathname, "evals/reports", runId));
  try { await mkdir(output, { recursive: true }); scanSecrets(reportJson(result)); await Bun.write(join(output, "report.json"), reportJson(result)); await Bun.write(join(output, "report.md"), reportMarkdown(result)); if (stack) console.log(JSON.stringify({ achilles: stack.achillesOrigin, model: `${stack.provider}/${stack.model}`, tool_policy: TOOL_POLICY, report: output, retained_state: stack.root })); }
  finally { await stack?.close(); }
}
if (import.meta.main) await main();
