export type TaskCheck = {
  id: string;
  type: string;
  required?: boolean;
  page?: string;
  alias?: string;
  [key: string]: unknown;
};
export type PagePlan = { alias: string; source: "fixture" | "setup" | "created"; bind_chat: boolean };
export type EvalTask = {
  id: string;
  prompt?: string;
  page_plan: PagePlan[];
  agent_turns: number;
  judge: null | { turns: number };
  steps: unknown[];
  checks: TaskCheck[];
};
export type EvalSnapshot = {
  pages?: Array<Record<string, unknown>>;
  tools?: Array<Record<string, unknown>>;
  assignments?: Array<Record<string, unknown>>;
  collections?: Array<Record<string, unknown>>;
  records?: Array<Record<string, unknown>>;
  layouts?: Array<Record<string, unknown>>;
  annotations?: Array<Record<string, unknown>>;
  chats?: Array<Record<string, unknown>>;
  calls?: Array<Record<string, unknown>>;
  results?: Array<Record<string, unknown>>;
  approvals?: Array<Record<string, unknown>>;
  errors?: Array<Record<string, unknown>>;
  browser?: Array<Record<string, unknown>>;
  turns?: number;
  wall_ms?: number;
  usage?: Record<string, unknown>;
};
export type CheckResult = { id: string; pass: boolean; expected: unknown; actual: unknown; evidence: unknown };

const own = (value: object, keys: string[], where: string) => {
  for (const key of Object.keys(value)) if (!keys.includes(key)) throw new Error(`${where}: unknown key ${key}`);
};
export function validateTask(value: unknown): EvalTask {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("task must be an object");
  const task = value as Record<string, unknown>;
  own(task, ["id", "prompt", "page_plan", "agent_turns", "judge", "steps", "checks"], "task");
  if (typeof task.id !== "string" || !/^[a-z0-9-]+$/.test(task.id)) throw new Error("task.id must be kebab-case");
  if (task.prompt !== undefined && typeof task.prompt !== "string") throw new Error("task.prompt must be a string");
  if (!Number.isInteger(task.agent_turns) || (task.agent_turns as number) < 1 || (task.agent_turns as number) > 20) throw new Error("agent_turns must be 1..20");
  if (task.judge !== null && (!task.judge || typeof task.judge !== "object" || Array.isArray(task.judge))) throw new Error("judge must be null or an object");
  if (!Array.isArray(task.page_plan) || task.page_plan.length === 0) throw new Error("page_plan must not be empty");
  if (!Array.isArray(task.steps)) throw new Error("steps must be an array");
  const aliases = new Set<string>();
  for (const [i, item] of (task.page_plan as unknown[]).entries()) {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error(`page_plan[${i}] must be an object`);
    own(item as object, ["alias", "source", "bind_chat"], `page_plan[${i}]`);
    const page = item as PagePlan;
    if (!/^[a-z][a-z0-9-]*$/.test(page.alias) || aliases.has(page.alias)) throw new Error(`invalid page alias ${page.alias}`);
    if (!["fixture", "setup", "created"].includes(page.source) || typeof page.bind_chat !== "boolean") throw new Error(`invalid page_plan[${i}]`);
    aliases.add(page.alias);
  }
  for (const [i, step] of (task.steps as unknown[]).entries()) {
    if (!step || typeof step !== "object" || Array.isArray(step)) throw new Error(`steps[${i}] must be an object`);
    const s = step as Record<string, unknown>; own(s, ["id", "page", "chat", "prompt", "kind"], `steps[${i}]`);
    if (s.page !== undefined && (typeof s.page !== "string" || !aliases.has(s.page))) throw new Error(`steps[${i}] references unknown page`);
  }
  if (!Array.isArray(task.checks)) throw new Error("checks must be an array");
  for (const [i, check] of (task.checks as unknown[]).entries()) {
    if (!check || typeof check !== "object" || Array.isArray(check)) throw new Error(`checks[${i}] must be an object`);
    const c = check as Record<string, unknown>; own(c, ["id", "type", "required", "page", "alias", "chat", "name", "value", "count", "text", "records", "tool", "collection"], `checks[${i}]`);
    if (typeof c.id !== "string" || typeof c.type !== "string") throw new Error(`checks[${i}] needs id and type`);
    const page = c.page ?? c.alias;
    if (page !== undefined && (typeof page !== "string" || !aliases.has(page))) throw new Error(`checks[${i}] references unknown page`);
  }
  const writes = (task.steps as Record<string, unknown>[]).filter((s) => ["create_tool", "insert", "update", "annotate", "create_record"].includes(String(s.kind)));
  for (const step of writes) {
    if (typeof step.page !== "string") throw new Error(`write step ${String(step.id)} must name its page`);
    const plan = (task.page_plan as PagePlan[]).find((p) => p.alias === step.page);
    if (!plan?.bind_chat) throw new Error(`write step ${String(step.id)} requires a bound page chat`);
  }
  return task as unknown as EvalTask;
}

const rows = (snapshot: EvalSnapshot, type: string): Array<Record<string, unknown>> => (snapshot[type as keyof EvalSnapshot] as Array<Record<string, unknown>> | undefined) ?? [];
const pageId = (snapshot: EvalSnapshot, alias?: string) => rows(snapshot, "pages").find((p) => p.alias === alias || p.route === alias || p.id === alias)?.id;
const successful = (r: Record<string, unknown>) => r.success === true || (r.success !== false && r.error == null && r.ok !== false);
export function gradeCheck(check: TaskCheck, snapshot: EvalSnapshot): CheckResult {
  const expected = check.value ?? check.count ?? true;
  const page = pageId(snapshot, String(check.page ?? check.alias ?? ""));
  const all = (type: string) => rows(snapshot, type).filter((r) => !page || r.page_id === page || r.pageId === page);
  let actual: unknown = false;
  switch (check.type) {
    case "page_exists": actual = Boolean(page); break;
    case "count": actual = all(String(check.name ?? "records")).length; break;
    case "tool": actual = all("tools").some((r) => r.name === check.name && (!check.tool || r.name === check.tool)); break;
    case "record": actual = all("records").some((r) => JSON.stringify(r.data ?? r.fields ?? r) === JSON.stringify(check.value)); break;
    case "successful_result": actual = rows(snapshot, "results").some((r) => successful(r) && (!check.tool || r.tool === check.tool) && (!check.chat || r.chat_id === check.chat) && (!check.value || JSON.stringify(r.data ?? r.result ?? r).includes(JSON.stringify(check.value).slice(1, -1)))); break;
    case "no_error": actual = rows(snapshot, "errors").filter((e) => !check.chat || e.chat_id === check.chat).length === 0; break;
    case "browser_text": actual = rows(snapshot, "browser").some((r) => String(r.text ?? "").includes(String(check.text))); break;
    case "prompt": actual = rows(snapshot, "chats").some((c) => c.prompt === check.text || c.first_prompt === check.text); break;
    case "same_page": {
      const ids = ["tools", "assignments", "collections", "records", "layouts", "annotations"].flatMap((t) => all(t).map((r) => r.page_id ?? r.pageId)).filter(Boolean);
      actual = ids.length > 0 && new Set(ids).size === 1;
      break;
    }
    default: throw new Error(`unsupported check type ${check.type}`);
  }
  const pass = check.type === "count" ? actual === expected : Boolean(actual) === Boolean(expected);
  return { id: check.id, pass, expected, actual, evidence: { type: check.type, page } };
}
export function hostToolsGap(snapshot: EvalSnapshot): boolean {
  const forbidden = /^(bash|sqlite|write|edit|read|fetch|process|shell)(__|$)/i;
  return rows(snapshot, "calls").some((call) => forbidden.test(String(call.tool ?? call.name ?? call.tool_name ?? ""))) ||
    rows(snapshot, "errors").some((error) => /unknown[- ]?tool|tool not available|disallowed tool/i.test(String(error.code ?? error.message ?? error.error ?? "")));
}

export function gradeTask(task: EvalTask, snapshot: EvalSnapshot) {
  const checks = task.checks.map((check) => gradeCheck(check, snapshot));
  const required = checks.filter((result, i) => task.checks[i].required !== false);
  const score = checks.length ? Math.round((checks.filter((r) => r.pass).length / checks.length) * 100) : 0;
  return { task_id: task.id, pass: required.every((r) => r.pass) && score >= 80, score, checks, turns: snapshot.turns ?? 0, wall_ms: snapshot.wall_ms ?? 0, tool_calls: rows(snapshot, "calls").length, approvals: rows(snapshot, "approvals").length, usage: snapshot.usage ?? "unavailable", host_tools_gap: hostToolsGap(snapshot) };
}
