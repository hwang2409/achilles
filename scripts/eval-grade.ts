export type TaskCheck = {
  id: string;
  type: "page_exists" | "count" | "tool" | "record" | "successful_result" | "no_error" | "browser_text" | "prompt" | "same_page" | "history_absent" | "layout_contains";
  required?: boolean;
  page?: string;
  chat?: string;
  name?: string;
  value?: unknown;
  count?: number;
  text?: string;
  tool?: string;
  route?: string;
};
export type PagePlan = { alias: string; source: "fixture" | "setup" | "created"; bind_chat: boolean; create_mode: boolean; route?: string };
export type TaskStep = { id: string; kind: "prompt" | "annotate" | "reconnect"; page: string; chat: string; prompt?: string };
export type TaskSetup = { tools: Array<{ name: string; operation: "list" | "get" | "insert" | "update"; collection: string }>; records: Array<{ id: string; collection: string; data: Record<string, unknown> }> };
export type EvalTask = { id: string; prompt?: string; page_plan: PagePlan[]; agent_turns: number; steps: TaskStep[]; checks: TaskCheck[]; setup?: TaskSetup; approval_mode?: "allow" | "ask" };
export type EvalSnapshot = {
  pages?: Array<Record<string, unknown>>; tools?: Array<Record<string, unknown>>; assignments?: Array<Record<string, unknown>>;
  records?: Array<Record<string, unknown>>; layouts?: Array<Record<string, unknown>>; chats?: Array<Record<string, unknown>>;
  calls?: Array<Record<string, unknown>>; results?: Array<Record<string, unknown>>; approvals?: Array<Record<string, unknown>>;
  errors?: Array<Record<string, unknown>>; browser?: Array<Record<string, unknown>>; related_page_ids?: string[];
  turns?: number; wall_ms?: number; usage?: Record<string, unknown>; tool_policy?: string; observed_catalog?: string[]; session_history?: unknown[];
};
export type CheckResult = { id: string; pass: boolean; expected: unknown; actual: unknown; evidence: unknown };

const STEP_KINDS = new Set(["prompt", "annotate", "reconnect"]);
const CHECK_TYPES = new Set(["page_exists", "count", "tool", "record", "successful_result", "no_error", "browser_text", "prompt", "same_page", "history_absent", "layout_contains"]);
const own = (value: object, keys: string[], where: string) => { for (const key of Object.keys(value)) if (!keys.includes(key)) throw new Error(`${where}: unknown key ${key}`); };
const identifier = (value: unknown) => typeof value === "string" && /^[a-z][a-z0-9_-]*$/.test(value);

function validateSetup(value: unknown): TaskSetup | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("setup must be an object");
  own(value, ["tools", "records"], "setup"); const setup = value as TaskSetup;
  if (!Array.isArray(setup.tools) || !Array.isArray(setup.records)) throw new Error("setup tools and records must be arrays");
  setup.tools.forEach((tool, i) => { own(tool, ["name", "operation", "collection"], `setup.tools[${i}]`); if (!identifier(tool.name) || !["list", "get", "insert", "update"].includes(tool.operation) || !identifier(tool.collection)) throw new Error(`invalid setup.tools[${i}]`); });
  setup.records.forEach((record, i) => { own(record, ["id", "collection", "data"], `setup.records[${i}]`); if (typeof record.id !== "string" || !identifier(record.collection) || !record.data || typeof record.data !== "object" || Array.isArray(record.data)) throw new Error(`invalid setup.records[${i}]`); });
  return setup;
}

function validatePages(value: unknown): PagePlan[] {
  if (!Array.isArray(value) || !value.length) throw new Error("page_plan must not be empty");
  const aliases = new Set<string>();
  return value.map((item, i) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error(`page_plan[${i}] must be an object`);
    own(item, ["alias", "source", "bind_chat", "create_mode", "route"], `page_plan[${i}]`); const page = item as PagePlan;
    if (!identifier(page.alias) || aliases.has(page.alias) || !["fixture", "setup", "created"].includes(page.source) || typeof page.bind_chat !== "boolean" || typeof page.create_mode !== "boolean") throw new Error(`invalid page_plan[${i}]`);
    if (page.source === "created" && (typeof page.route !== "string" || !page.route.startsWith("/"))) throw new Error(`created page_plan[${i}] needs route`);
    if (page.source !== "created" && page.route !== undefined) throw new Error(`non-created page_plan[${i}] cannot set route`);
    aliases.add(page.alias); return page;
  });
}

function validateSteps(value: unknown, aliases: Set<string>): TaskStep[] {
  if (!Array.isArray(value) || !value.length) throw new Error("steps must not be empty");
  return value.map((item, i) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error(`steps[${i}] must be an object`);
    own(item, ["id", "page", "chat", "prompt", "kind"], `steps[${i}]`); const step = item as TaskStep;
    if (!identifier(step.id) || !STEP_KINDS.has(step.kind) || !aliases.has(step.page) || !identifier(step.chat)) throw new Error(`invalid steps[${i}]`);
    if ((step.kind === "prompt" || step.kind === "annotate") !== (typeof step.prompt === "string" && step.prompt.length > 0)) throw new Error(`steps[${i}] has invalid prompt`);
    return step;
  });
}

function validateCheckShape(check: TaskCheck, i: number) {
  const needsPage = !["history_absent"].includes(check.type);
  if (needsPage && typeof check.page !== "string") throw new Error(`checks[${i}] needs page`);
  if (check.type === "count" && (!identifier(check.name) || !Number.isInteger(check.count))) throw new Error(`checks[${i}] needs name and count`);
  if (check.type === "tool" && !identifier(check.name)) throw new Error(`checks[${i}] needs tool name`);
  if (check.type === "successful_result" && typeof check.tool !== "string") throw new Error(`checks[${i}] needs tool`);
  if (["record", "layout_contains"].includes(check.type) && check.value === undefined) throw new Error(`checks[${i}] needs value`);
  if (["browser_text", "prompt", "history_absent"].includes(check.type) && typeof check.text !== "string") throw new Error(`checks[${i}] needs text`);
  if (check.type === "page_exists" && check.route !== undefined && !check.route.startsWith("/")) throw new Error(`checks[${i}] has invalid route`);
}

function validateChecks(value: unknown, aliases: Set<string>): TaskCheck[] {
  if (!Array.isArray(value) || !value.length) throw new Error("checks must not be empty");
  return value.map((item, i) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error(`checks[${i}] must be an object`);
    own(item, ["id", "type", "required", "page", "chat", "name", "value", "count", "text", "tool", "route"], `checks[${i}]`); const check = item as TaskCheck;
    if (!identifier(check.id) || !CHECK_TYPES.has(check.type) || (check.page !== undefined && !aliases.has(check.page))) throw new Error(`invalid checks[${i}]`);
    validateCheckShape(check, i); return check;
  });
}

export function validateTask(value: unknown): EvalTask {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("task must be an object");
  own(value, ["id", "prompt", "page_plan", "agent_turns", "steps", "checks", "setup", "approval_mode"], "task"); const task = value as Record<string, unknown>;
  if (typeof task.id !== "string" || !/^[a-z0-9-]+$/.test(task.id)) throw new Error("task.id must be kebab-case");
  if (task.prompt !== undefined && typeof task.prompt !== "string") throw new Error("task.prompt must be a string");
  if (!Number.isInteger(task.agent_turns) || (task.agent_turns as number) < 1 || (task.agent_turns as number) > 20) throw new Error("agent_turns must be 1..20");
  if (task.approval_mode !== undefined && !["allow", "ask"].includes(String(task.approval_mode))) throw new Error("approval_mode must be allow or ask");
  const page_plan = validatePages(task.page_plan); const aliases = new Set(page_plan.map(page => page.alias));
  return { id: task.id, prompt: task.prompt as string | undefined, page_plan, agent_turns: task.agent_turns as number, approval_mode: task.approval_mode as EvalTask["approval_mode"], setup: validateSetup(task.setup), steps: validateSteps(task.steps, aliases), checks: validateChecks(task.checks, aliases) };
}

const rows = (snapshot: EvalSnapshot, type: keyof EvalSnapshot): Array<Record<string, unknown>> => (snapshot[type] as Array<Record<string, unknown>> | undefined) ?? [];
const expectedPageId = (snapshot: EvalSnapshot, alias?: string) => rows(snapshot, "pages").find(page => page.alias === alias)?.id;
const successful = (row: Record<string, unknown>) => row.success === true || (row.success !== false && row.error == null && row.ok !== false);
export function structurallyContains(actual: unknown, expected: unknown): boolean {
  if (Object.is(actual, expected)) return true;
  if (Array.isArray(actual)) return actual.some(value => structurallyContains(value, expected));
  if (!actual || !expected || typeof actual !== "object" || typeof expected !== "object" || Array.isArray(expected)) return false;
  const actualObject = actual as Record<string, unknown>; const entries = Object.entries(expected as Record<string, unknown>);
  if (entries.every(([key, value]) => key in actualObject && structurallyContains(actualObject[key], value))) return true;
  return Object.values(actualObject).some(value => structurallyContains(value, expected));
}

type GradeContext = { check: TaskCheck; snapshot: EvalSnapshot; page: unknown; owned(type: keyof EvalSnapshot): Array<Record<string, unknown>> };
const CHECK_GRADERS: Record<CheckType, (context: GradeContext) => unknown> = {
  page_exists: ({ check, snapshot, page }) => rows(snapshot, "pages").some(row => row.id === page && (!check.route || row.route === check.route)),
  count: ({ check, owned }) => owned(check.name as keyof EvalSnapshot).length,
  tool: ({ check, owned }) => owned("tools").some(row => row.name === check.name),
  record: ({ check, owned }) => owned("records").some(row => structurallyContains(row.data ?? row, check.value)),
  successful_result: ({ check, snapshot, page }) => rows(snapshot, "results").some(row => row.page_id === page && successful(row) && row.tool === check.tool && (!check.chat || row.chat_id === check.chat) && (check.value === undefined || structurallyContains(row.data ?? row.result, check.value))),
  no_error: ({ check, snapshot, page }) => rows(snapshot, "errors").filter(row => row.page_id === page && (!check.chat || row.chat_id === check.chat)).length === 0,
  browser_text: ({ check, owned }) => owned("browser").some(row => String(row.text ?? "").includes(String(check.text))),
  prompt: ({ check, owned }) => owned("chats").some(row => row.prompt === check.text || row.first_prompt === check.text),
  same_page: ({ snapshot, page }) => (snapshot.related_page_ids?.length ?? 0) > 0 && snapshot.related_page_ids!.every(id => id === page),
  history_absent: ({ check, snapshot }) => !rows(snapshot, "chats").filter(row => !check.chat || row.chat_id === check.chat).some(row => String(row.history ?? "").includes(String(check.text))),
  layout_contains: ({ check, owned }) => owned("layouts").some(row => structurallyContains(row.document, check.value)),
};
export function gradeCheck(check: TaskCheck, snapshot: EvalSnapshot): CheckResult {
  const expected = check.value ?? check.count ?? check.text ?? true; const page = expectedPageId(snapshot, check.page); const owned = (type: keyof EvalSnapshot) => rows(snapshot, type).filter(row => row.page_id === page || row.pageId === page);
  const actual = CHECK_GRADERS[check.type]({ check, snapshot, page, owned }); const pass = check.type === "count" ? actual === expected : Boolean(actual);
  return { id: check.id, pass, expected, actual, evidence: { type: check.type, page } };
}

export function hostToolsGap(snapshot: EvalSnapshot): boolean {
  const forbidden = /^(bash|sqlite|write|edit|read|fetch|process|shell)(__|$)/i;
  return rows(snapshot, "calls").some(call => forbidden.test(String(call.tool ?? call.name ?? ""))) || rows(snapshot, "errors").some(error => /unknown[- ]?tool|tool not available|disallowed tool/i.test(String(error.code ?? error.message ?? "")));
}
export type EvalDiagnostics = { first_call_validity: Record<string, boolean>; observed_catalog?: string[]; structured_tool_errors: Array<{ code: unknown; path: unknown; expected: unknown }>; unstructured_tool_errors: number };
export function diagnostics(snapshot: EvalSnapshot): EvalDiagnostics {
  const first_call_validity: Record<string, boolean> = {};
  for (const name of ["create_page", "create_tool"]) { const call = rows(snapshot, "calls").find(row => String(row.tool ?? row.name ?? "").endsWith(name)); if (call) first_call_validity[name] = successful(call); }
  const errors = rows(snapshot, "errors"); const structured = errors.filter(row => "code" in row && "path" in row && "expected" in row);
  return { first_call_validity, structured_tool_errors: structured.map(row => ({ code: row.code, path: row.path, expected: row.expected })), unstructured_tool_errors: errors.length - structured.length };
}
export function gradeTask(task: EvalTask, snapshot: EvalSnapshot) {
  const checks = task.checks.map(check => gradeCheck(check, snapshot)); const required = checks.filter((_, i) => task.checks[i].required !== false);
  const score = Math.round((checks.filter(result => result.pass).length / checks.length) * 100);
  return { task_id: task.id, pass: required.every(result => result.pass) && score >= 80, score, checks, turns: snapshot.turns ?? 0, wall_ms: snapshot.wall_ms ?? 0, tool_calls: rows(snapshot, "calls").length, approvals: rows(snapshot, "approvals").length, usage: snapshot.usage ?? "unavailable", host_tools_gap: hostToolsGap(snapshot), diagnostics: diagnostics(snapshot) };
}
