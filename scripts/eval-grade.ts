export type TaskCheck = {
  id: string;
  type: "page_exists" | "count" | "tool" | "tool_absent" | "refused_tool_name" | "operations" | "updated_record" | "schema_roundtrip" | "approval" | "reconnect" | "record" | "records_exact" | "successful_result" | "no_error" | "browser_text" | "prompt" | "same_page" | "layout_contains" | "list_shows" | "detail_selects" | "metric_count" | "layout_update" | "layout_restore" | "no_unrecovered_error" | "assigned_tools_only" | "tool_evolution" | "answer_mentions" | "no_new_page" | "form_submit" | "approval_outcomes" | "reload" | "no_duplicate_writes" | "denied_step" | "restart_recovery" | "overwrite_disclosed" | "error_shown" | "new_chat_kept" | "delivered_once";
  required?: boolean;
  page?: string;
  chat?: string;
  name?: string;
  value?: unknown;
  collection?: string;
  transition?: { before: string[]; after: string[] };
  count?: number;
  text?: string;
  tool?: string;
  route?: string;
  synonyms?: string[];
  step?: string;
  max?: number;
  fields?: string[];
};
export type PagePlan = { alias: string; source: "fixture" | "setup" | "created"; bind_chat: boolean; create_mode: boolean; route?: string };
// a browser_prompt step types its prompt into the real page; `reload` reloads that page once, at the n-th matching
// zeta event of the turn, and `follow_up` is typed into the reloaded page while the turn may still run. `new_chat`
// instead clicks "new chat" on the reloaded page (it took over the running chat) and sends that text there
export type ReloadTrigger = { on: "tool_start" | "assistant_delta" | "approval_request"; tool?: string; nth?: number };
// `during` acts while a prompt step's turn runs: before the harness answers the n-th approval request of `tool`
// in that step, it makes one user write (like a second chat or a form), steers the running turn, or kills the private
// zeta serve and starts it again (the pending request is never answered; the harness resumes the chat like a page would)
export type Interjection = { tool: string; nth?: number; user_write?: { tool: string; arguments: Record<string, unknown> }; steer?: string; restart_zeta?: true };
// a scripted-provider fault: after the step's first tool result, the next `times` model requests fail with HTTP `status`
// (zeta retries a 5xx up to 5 attempts, so times 1 is a retried blip and times 5 ends the turn with the error)
export type ProviderError = { status: number; times: number };
// a browser_prompt's send or steer of its prompt meets one fault on the page's socket to zeta (eval-browser.ts): zeta's
// dropped answer, zeta's -32010 answer (for a delivery zeta took: delivered or queued; for one it never got: unknown),
// or the socket closing before the request reaches zeta or before zeta's answer reaches the page
export type DeliveryFault = "dropped" | "evicted_delivered" | "evicted_queued" | "evicted_unknown" | "closed_before_send" | "closed_after_send";
export type TaskStep = { id: string; kind: "prompt" | "annotate" | "reconnect" | "user_write" | "browser_prompt"; page: string; chat: string; prompt?: string; tool?: string; arguments?: Record<string, unknown>; approval?: "approve" | "deny" | { tool: string; decisions: Array<"approve" | "deny"> }; reload?: ReloadTrigger; follow_up?: string; new_chat?: string; during?: Interjection; provider_error?: ProviderError; delivery_fault?: DeliveryFault };
export type TaskSetup = { tools: Array<{ name: string; operation: "list" | "get" | "insert" | "update"; collection: string; input_schema?: Record<string, unknown>; data_schema?: Record<string, unknown> }>; records: Array<{ id: string; collection: string; data: Record<string, unknown> }>; initial_layout?: { blocks: unknown[] } };
export type EvalTask = { id: string; prompt?: string; page_plan: PagePlan[]; agent_turns: number; steps: TaskStep[]; checks: TaskCheck[]; setup?: TaskSetup; approval_mode?: "allow" | "ask"; requires?: string[]; goal_capabilities?: string[]; suite: "core" | "focused" | "hard" };
export type EvalSnapshot = {
  pages?: Array<Record<string, unknown>>; tools?: Array<Record<string, unknown>>; assignments?: Array<Record<string, unknown>>;
  records?: Array<Record<string, unknown>>; layouts?: Array<Record<string, unknown>>; chats?: Array<Record<string, unknown>>;
  calls?: Array<Record<string, unknown>>; results?: Array<Record<string, unknown>>; approvals?: Array<Record<string, unknown>>;
  errors?: Array<Record<string, unknown>>; failed_turns?: Array<Record<string, unknown>>; browser?: Array<Record<string, unknown>>; tool_versions?: Array<Record<string, unknown>>;
  reconnects?: Array<Record<string, unknown>>; form_submits?: Array<Record<string, unknown>>; user_writes?: Array<Record<string, unknown>>; bundle_validations?: Array<Record<string, unknown>>; related_page_ids?: string[];
  tool_schema_validations?: Array<Record<string, unknown>>; tool_schema_validation_error?: string;
  turns?: number; wall_ms?: number; usage?: Record<string, unknown>; tool_policy?: string; observed_catalog?: string[]; session_history?: unknown[];
  answers?: Record<string, string>; reloads?: Array<Record<string, unknown>>; delivery_faults?: Array<Record<string, unknown>>; interjections?: Array<Record<string, unknown>>; browser_frames?: Record<string, unknown>;
  initial?: EvalSnapshot;
};
export type CheckResult = { id: string; pass: boolean; expected: unknown; actual: unknown; evidence: unknown; reason?: string };

const STEP_KINDS = new Set(["prompt", "annotate", "reconnect", "user_write", "browser_prompt"]);
const MODEL_STEPS = new Set(["prompt", "annotate", "browser_prompt"]);
const RELOAD_EVENTS = new Set(["tool_start", "assistant_delta", "approval_request"]);
const CHECK_TYPES = new Set(["page_exists", "count", "tool", "tool_absent", "refused_tool_name", "operations", "updated_record", "schema_roundtrip", "approval", "reconnect", "record", "records_exact", "successful_result", "no_error", "browser_text", "prompt", "same_page", "layout_contains", "list_shows", "detail_selects", "metric_count", "layout_update", "layout_restore", "no_unrecovered_error", "assigned_tools_only", "tool_evolution", "answer_mentions", "no_new_page", "form_submit", "approval_outcomes", "reload", "no_duplicate_writes", "denied_step", "restart_recovery", "overwrite_disclosed", "error_shown", "new_chat_kept", "delivered_once"]);
const SNAPSHOT_COLLECTIONS = new Set(["pages", "tools", "tool_versions", "assignments", "records", "layouts", "chats", "calls", "results", "approvals", "reconnects", "errors", "browser", "reloads"]);
const own = (value: object, keys: string[], where: string) => { for (const key of Object.keys(value)) if (!keys.includes(key)) throw new Error(`${where}: unknown key ${key}`); };
const identifier = (value: unknown) => typeof value === "string" && /^[a-z][a-z0-9_-]*$/.test(value);

function validateSetup(value: unknown): TaskSetup | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("setup must be an object");
  own(value, ["tools", "records", "initial_layout"], "setup"); const setup = value as TaskSetup;
  if (!Array.isArray(setup.tools) || !Array.isArray(setup.records)) throw new Error("setup tools and records must be arrays");
  setup.tools.forEach((tool, i) => { own(tool, ["name", "operation", "collection", "input_schema", "data_schema"], `setup.tools[${i}]`); if (!identifier(tool.name) || !["list", "get", "insert", "update"].includes(tool.operation) || !identifier(tool.collection) || [tool.input_schema, tool.data_schema].some(schema => schema !== undefined && (!schema || typeof schema !== "object" || Array.isArray(schema)))) throw new Error(`invalid setup.tools[${i}]`); });
  setup.records.forEach((record, i) => { own(record, ["id", "collection", "data"], `setup.records[${i}]`); if (typeof record.id !== "string" || !identifier(record.collection) || !record.data || typeof record.data !== "object" || Array.isArray(record.data)) throw new Error(`invalid setup.records[${i}]`); });
  if (setup.initial_layout !== undefined && (!setup.initial_layout || !Array.isArray(setup.initial_layout.blocks))) throw new Error("invalid setup.initial_layout");
  return setup;
}

function validatePages(value: unknown): PagePlan[] {
  if (!Array.isArray(value) || !value.length) throw new Error("page_plan must not be empty");
  const aliases = new Set<string>(); const routes = new Set<string>();
  return value.map((item, i) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error(`page_plan[${i}] must be an object`);
    own(item, ["alias", "source", "bind_chat", "create_mode", "route"], `page_plan[${i}]`); const page = item as PagePlan;
    if (!identifier(page.alias) || aliases.has(page.alias) || !["fixture", "setup", "created"].includes(page.source) || typeof page.bind_chat !== "boolean" || typeof page.create_mode !== "boolean") throw new Error(`invalid page_plan[${i}]`);
    // a created page names the route the agent makes; a fixture page names the second page the harness makes
    if (page.route !== undefined && (page.source === "setup" || typeof page.route !== "string" || !page.route.startsWith("/") || page.route === "/" || routes.has(page.route))) throw new Error(`page_plan[${i}] has invalid route`);
    if (page.route) routes.add(page.route);
    aliases.add(page.alias); return page;
  });
}

function validateSteps(value: unknown, aliases: Set<string>, taskPrompt?: string, approvalMode?: EvalTask["approval_mode"]): TaskStep[] {
  if (!Array.isArray(value) || !value.length) throw new Error("steps must not be empty");
  const missingPrompts = value.filter(item => item && typeof item === "object" && MODEL_STEPS.has((item as TaskStep).kind) && !(item as TaskStep).prompt).length;
  if ((taskPrompt && missingPrompts !== 1) || (!taskPrompt && missingPrompts > 0)) throw new Error("task needs exactly one prompt source per step");
  return value.map((item, i) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error(`steps[${i}] must be an object`);
    own(item, ["id", "page", "chat", "prompt", "kind", "tool", "arguments", "approval", "reload", "follow_up", "new_chat", "during", "provider_error", "delivery_fault"], `steps[${i}]`); const step = item as TaskStep;
    if (!identifier(step.id) || !STEP_KINDS.has(step.kind) || !aliases.has(step.page) || !identifier(step.chat)) throw new Error(`invalid steps[${i}]`);
    const isWrite = step.kind === "user_write"; const args = step.arguments;
    // the harness fills the current revision, like a form that loaded the record
    if (isWrite && (!identifier(step.tool) || !args || typeof args !== "object" || Array.isArray(args) || typeof args.record_id !== "string" || "revision" in args)) throw new Error(`steps[${i}] user_write needs tool and arguments with record_id and no revision`);
    if (!isWrite && (step.tool !== undefined || args !== undefined)) throw new Error(`steps[${i}] only user_write takes tool and arguments`);
    const needsPrompt = MODEL_STEPS.has(step.kind); const hasPrompt = typeof step.prompt === "string" && step.prompt.length > 0;
    if (!needsPrompt && hasPrompt) throw new Error(`steps[${i}] has invalid prompt source`);
    // the harness answers every approval request of a model step; other kinds run no model turn
    const rule = step.approval; const sequence = rule && typeof rule === "object" && !Array.isArray(rule);
    if (sequence) own(rule, ["tool", "decisions"], `steps[${i}].approval`);
    const validRule = typeof rule === "string" ? ["approve", "deny"].includes(rule) : sequence && typeof rule.tool === "string" && rule.tool.startsWith("achilles__") && Array.isArray(rule.decisions) && rule.decisions.length > 0 && rule.decisions.every(decision => ["approve", "deny"].includes(decision));
    if (rule !== undefined && (!needsPrompt || approvalMode !== "ask" || !validRule)) throw new Error(`steps[${i}] approval must be approve, deny, or { tool, decisions }, on a prompt step of an approval_mode ask task`);
    validateReload(step, i); validateDuring(step, i, approvalMode); validateProviderError(step, i);
    if (step.delivery_fault !== undefined && (step.kind !== "browser_prompt" || step.reload !== undefined || !(step.delivery_fault in DELIVERY_FAULTS))) throw new Error(`steps[${i}] delivery_fault needs a browser_prompt step without reload and one of ${Object.keys(DELIVERY_FAULTS).join(", ")}`);
    return step;
  });
}

function validateReload(step: TaskStep, i: number) {
  const reload = step.reload;
  if ((reload !== undefined || step.follow_up !== undefined) && step.kind !== "browser_prompt") throw new Error(`steps[${i}] only browser_prompt takes reload and follow_up`);
  if (step.follow_up !== undefined && (reload === undefined || typeof step.follow_up !== "string" || !step.follow_up)) throw new Error(`steps[${i}] follow_up needs text and a reload`);
  if (step.new_chat !== undefined && (reload === undefined || step.follow_up !== undefined || typeof step.new_chat !== "string" || !step.new_chat)) throw new Error(`steps[${i}] new_chat needs text and a reload, and no follow_up`);
  if (reload === undefined) return;
  if (!reload || typeof reload !== "object" || Array.isArray(reload)) throw new Error(`steps[${i}] reload must be an object`);
  own(reload, ["on", "tool", "nth"], `steps[${i}].reload`);
  if (!RELOAD_EVENTS.has(reload.on) || (reload.nth !== undefined && (!Number.isInteger(reload.nth) || reload.nth < 1))) throw new Error(`steps[${i}] reload needs on: tool_start, assistant_delta, or approval_request, and a positive nth`);
  if (reload.on === "tool_start" ? typeof reload.tool !== "string" || !reload.tool.startsWith("achilles__") : reload.tool !== undefined && (reload.on !== "approval_request" || typeof reload.tool !== "string")) throw new Error(`steps[${i}] reload tool must be an achilles tool; tool_start requires one`);
}

const validWriteArguments = (args: unknown) => Boolean(args) && typeof args === "object" && !Array.isArray(args) && typeof (args as Record<string, unknown>).record_id === "string" && !("revision" in (args as object));
function validateDuring(step: TaskStep, i: number, approvalMode?: EvalTask["approval_mode"]) {
  const during = step.during; if (during === undefined) return;
  // the approval request pauses the turn, so the action lands at a known point; the browser path has no such hook
  if (step.kind !== "prompt" || approvalMode !== "ask") throw new Error(`steps[${i}] during needs a prompt step of an approval_mode ask task`);
  if (!during || typeof during !== "object" || Array.isArray(during)) throw new Error(`steps[${i}] during must be an object`);
  own(during, ["tool", "nth", "user_write", "steer", "restart_zeta"], `steps[${i}].during`);
  if (typeof during.tool !== "string" || !during.tool.startsWith("achilles__") || (during.nth !== undefined && (!Number.isInteger(during.nth) || during.nth < 1))) throw new Error(`steps[${i}] during needs an achilles tool and a positive nth`);
  if ([during.user_write, during.steer, during.restart_zeta].filter(value => value !== undefined).length !== 1) throw new Error(`steps[${i}] during needs exactly one of user_write, steer, or restart_zeta`);
  if (during.restart_zeta !== undefined && during.restart_zeta !== true) throw new Error(`steps[${i}] during restart_zeta must be true`);
  if (during.steer !== undefined && (typeof during.steer !== "string" || !during.steer)) throw new Error(`steps[${i}] during steer needs text`);
  const write = during.user_write;
  if (write !== undefined) {
    if (!write || typeof write !== "object" || Array.isArray(write)) throw new Error(`steps[${i}] during user_write must be an object`);
    own(write, ["tool", "arguments"], `steps[${i}].during.user_write`);
    if (!identifier(write.tool) || !validWriteArguments(write.arguments)) throw new Error(`steps[${i}] during user_write needs tool and arguments with record_id and no revision`);
  }
}

function validateProviderError(step: TaskStep, i: number) {
  const fault = step.provider_error; if (fault === undefined) return;
  if (step.kind !== "prompt" || !fault || typeof fault !== "object" || Array.isArray(fault)) throw new Error(`steps[${i}] provider_error needs a prompt step and an object`);
  own(fault, ["status", "times"], `steps[${i}].provider_error`);
  if (!Number.isInteger(fault.status) || fault.status < 400 || fault.status > 599 || !Number.isInteger(fault.times) || fault.times < 1 || fault.times > 10) throw new Error(`steps[${i}] provider_error needs an HTTP error status and times 1..10`);
}

// the browser holds zeta's one controller slot, so a browser task never mixes in protocol-driven model steps
function validateBrowserSteps(steps: TaskStep[], pages: PagePlan[]) {
  const browser = steps.filter(step => step.kind === "browser_prompt");
  if (!browser.length) return;
  if (steps.some(step => ["prompt", "annotate", "reconnect"].includes(step.kind))) throw new Error("a task with browser_prompt steps cannot also have prompt, annotate, or reconnect steps");
  const chats = new Map<string, string>();
  for (const step of browser) {
    if (pages.find(page => page.alias === step.page)?.source === "created") throw new Error(`step ${step.id}: browser_prompt needs a fixture or setup page`);
    if ((chats.get(step.page) ?? step.chat) !== step.chat) throw new Error(`step ${step.id}: browser_prompt uses one chat per page`);
    // the fault needs the chat's session, which the page makes with the chat's first message
    if (step.delivery_fault && !chats.has(step.page)) throw new Error(`step ${step.id}: a delivery_fault step needs an earlier step in its chat`);
    chats.set(step.page, step.chat);
  }
}

function validateCheckShape(check: TaskCheck, i: number) {
  if (typeof check.page !== "string") throw new Error(`checks[${i}] needs page`);
  if (check.type === "count" && (!identifier(check.name) || !SNAPSHOT_COLLECTIONS.has(check.name!) || !Number.isInteger(check.count))) throw new Error(`checks[${i}] needs a known collection and count`);
  if (["tool", "tool_absent", "refused_tool_name"].includes(check.type) && !identifier(check.name)) throw new Error(`checks[${i}] needs tool name`);
  if (check.type === "operations" && (!Array.isArray(check.value) || !(check.value as unknown[]).length || !(check.value as unknown[]).every(value => ["insert", "update", "list", "get"].includes(String(value))))) throw new Error(`checks[${i}] needs operation kinds`);
  if (check.type === "approval" && (typeof check.tool !== "string" || (check.count === undefined) === (check.max === undefined) || !Number.isInteger(check.count ?? check.max) || (check.max !== undefined && check.max < 1))) throw new Error(`checks[${i}] needs tool and either count or max >= 1`);
  if (check.type !== "approval" && check.max !== undefined) throw new Error(`checks[${i}] only approval takes max`);
  if (check.type === "successful_result" && typeof check.tool !== "string") throw new Error(`checks[${i}] needs tool`);
  if (["record", "records_exact", "updated_record", "schema_roundtrip", "layout_contains", "detail_selects", "metric_count", "layout_update", "tool_evolution", "form_submit"].includes(check.type) && check.value === undefined) throw new Error(`checks[${i}] needs value`);
  if (check.type === "tool_evolution") {
    if (!check.value || typeof check.value !== "object" || Array.isArray(check.value)) throw new Error(`checks[${i}] needs a tool evolution spec`);
    own(check.value, ["tool", "from", "to", "new_value", "legacy_record", "read_tool"], `checks[${i}].value`);
    const value = check.value as Record<string, unknown>;
    if (!identifier(value.tool) || !Number.isInteger(value.from) || !Number.isInteger(value.to) || Number(value.to) <= Number(value.from) || typeof value.new_value !== "number" || typeof value.legacy_record !== "string" || !identifier(value.read_tool)) throw new Error(`checks[${i}] has invalid tool evolution spec`);
  }
  if (check.type === "list_shows" && ((check.collection !== undefined && !identifier(check.collection)) || (check.value !== undefined && typeof check.value !== "string") || (check.collection === undefined && check.value === undefined))) throw new Error(`checks[${i}] needs a collection or string value`);
  if (check.type === "detail_selects" && (typeof check.value !== "string" || !identifier(check.collection))) throw new Error(`checks[${i}] needs a collection and string value`);
  if (check.type === "metric_count") {
    const value = check.value as Record<string, unknown>; const where = value?.where as Record<string, unknown>;
    if (!value || typeof value !== "object" || Array.isArray(value) || !identifier(value.collection) || !where || typeof where !== "object" || Array.isArray(where) || !identifier(where.field) || !("equals" in where) || !Number.isInteger(value.count) || value.position !== "first") throw new Error(`checks[${i}] needs a collection, equality predicate, count, and first position`);
    own(value, ["collection", "where", "count", "position"], `checks[${i}].value`); own(where, ["field", "equals"], `checks[${i}].value.where`);
  }
  if (check.type === "records_exact" && !Array.isArray(check.value)) throw new Error(`checks[${i}] needs a record array`);
  if (check.type === "schema_roundtrip" && (!Array.isArray(check.value) || !(check.value as unknown[]).length || !(check.value as unknown[]).every(value => typeof value === "string"))) throw new Error(`checks[${i}] needs string values`);
  if (check.type === "updated_record") {
    if (typeof check.chat !== "string" || typeof check.value !== "string" || !check.transition) throw new Error(`checks[${i}] needs chat, identity value, and transition`);
    own(check.transition, ["before", "after"], `checks[${i}].transition`);
    if ([check.transition.before, check.transition.after].some(values => !Array.isArray(values) || !values.length || !values.every(value => typeof value === "string"))) throw new Error(`checks[${i}] transition sets need string values`);
  }
  if (["browser_text", "prompt"].includes(check.type) && typeof check.text !== "string") throw new Error(`checks[${i}] needs text`);
  if (check.synonyms !== undefined && (!["browser_text", "schema_roundtrip"].includes(check.type) || !Array.isArray(check.synonyms) || !check.synonyms.length || !check.synonyms.every(value => typeof value === "string"))) throw new Error(`checks[${i}] has invalid synonyms`);
  if (check.type === "answer_mentions" && (typeof check.step !== "string" || !Array.isArray(check.value) || !(check.value as unknown[]).length || !(check.value as unknown[]).every(value => typeof value === "string" && value.trim() === value && value.length > 0))) throw new Error(`checks[${i}] needs a step and non-empty mention values`);
  // form_submit: what the harness types into each required input, by the input's schema type
  if (check.type === "form_submit") {
    const value = check.value as Record<string, unknown>;
    if (!value || typeof value !== "object" || Array.isArray(value) || typeof value.string !== "string" || !value.string) throw new Error(`checks[${i}] needs a value map with a string value`);
    own(value, ["string", "number", "integer"], `checks[${i}].value`);
    for (const kind of ["number", "integer"] as const) if (value[kind] !== undefined && (typeof value[kind] !== "string" || !Number.isFinite(Number(value[kind])) || (kind === "integer" && !Number.isInteger(Number(value[kind]))))) throw new Error(`checks[${i}].value.${kind} must be a ${kind} string`);
  }
  if (check.fields !== undefined && check.type === "no_duplicate_writes" && (!identifier(check.collection) || !Array.isArray(check.fields) || !check.fields.length || !check.fields.every(identifier))) throw new Error(`checks[${i}] fields must name record fields`);
  if (check.fields !== undefined && check.type !== "no_duplicate_writes" && check.type !== "restart_recovery" && (check.type !== "list_shows" || check.collection === undefined || !Array.isArray(check.fields) || !check.fields.length || !check.fields.every(identifier))) throw new Error(`checks[${i}] fields must be a list_shows check with a collection and field names`);
  // approval_outcomes: which records the tool's approval requests must target, and what an approved write sets
  if (check.type === "approval_outcomes") {
    const value = check.value as Record<string, unknown>;
    if (typeof check.tool !== "string" || !check.tool.startsWith("achilles__") || !identifier(check.collection) || !value || typeof value !== "object" || Array.isArray(value)) throw new Error(`checks[${i}] needs an achilles tool, a collection, and a value`);
    own(value, ["records", "set"], `checks[${i}].value`);
    const set = value.set as Record<string, unknown>;
    if (!Array.isArray(value.records) || !value.records.length || !value.records.every(id => typeof id === "string") || new Set(value.records).size !== value.records.length || !set || typeof set !== "object" || Array.isArray(set) || !Object.keys(set).length) throw new Error(`checks[${i}] needs unique record ids and a non-empty set`);
  }
  // denied_step: one create_tool request was denied; that tool is never asked again or created, every other named tool exists, and the step's answer names it
  if (check.type === "denied_step" && (check.tool !== "achilles__create_tool" || typeof check.step !== "string" || !Array.isArray(check.value) || !(check.value as unknown[]).length || !(check.value as unknown[]).every(identifier))) throw new Error(`checks[${i}] needs tool achilles__create_tool, a step, and the tool names the step creates`);
  // restart_recovery: the step after the restart; its answer must name, by `fields[0]`, every record of `collection` that existed at the restart
  if (check.type === "restart_recovery" && (typeof check.step !== "string" || !identifier(check.collection) || !Array.isArray(check.fields) || check.fields.length !== 1 || !identifier(check.fields[0]))) throw new Error(`checks[${i}] needs the step after the restart, a collection, and one name field`);
  // overwrite_disclosed: the step whose `during` user write set `field`; the agent wanted `agent_value`
  if (check.type === "overwrite_disclosed") {
    const value = check.value as Record<string, unknown>;
    if (typeof check.step !== "string" || !identifier(check.collection) || !value || typeof value !== "object" || Array.isArray(value) || !identifier(value.field) || !["string", "number"].includes(typeof value.agent_value)) throw new Error(`checks[${i}] needs a step, a collection, and a value with field and agent_value`);
    own(value, ["field", "agent_value"], `checks[${i}].value`);
  }
  if (check.type === "error_shown" && (!Number.isInteger(check.value) || (check.value as number) < 400 || (check.value as number) > 599)) throw new Error(`checks[${i}] needs the HTTP status the chat must show`);
  if (check.step !== undefined && !["answer_mentions", "reload", "denied_step", "restart_recovery", "overwrite_disclosed", "new_chat_kept", "delivered_once"].includes(check.type)) throw new Error(`checks[${i}] has an unused step`);
  if ((check.type === "reload" || check.type === "new_chat_kept" || check.type === "delivered_once") && typeof check.step !== "string") throw new Error(`checks[${i}] needs the step that reloads`);
  if (check.type === "no_duplicate_writes" && (typeof check.tool !== "string" || !check.tool.startsWith("achilles__") || (check.collection === undefined) !== (check.fields === undefined))) throw new Error(`checks[${i}] needs an achilles tool, and a collection with fields or neither`);
  if (check.type === "page_exists" && check.route !== undefined && !check.route.startsWith("/")) throw new Error(`checks[${i}] has invalid route`);
}

function validateChecks(value: unknown, aliases: Set<string>): TaskCheck[] {
  if (!Array.isArray(value) || !value.length) throw new Error("checks must not be empty");
  return value.map((item, i) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error(`checks[${i}] must be an object`);
    own(item, ["id", "type", "required", "page", "chat", "name", "value", "collection", "transition", "count", "text", "tool", "route", "synonyms", "step", "max", "fields"], `checks[${i}]`); const check = item as TaskCheck;
    if (!identifier(check.id) || !CHECK_TYPES.has(check.type) || (check.page !== undefined && !aliases.has(check.page))) throw new Error(`invalid checks[${i}]`);
    validateCheckShape(check, i); return check;
  });
}

const EXPECTATION_TOKEN_KEYS = new Set(["value", "name", "tool", "text", "route"]);
const LAYOUT_STRUCTURAL_TOKENS = new Set([
  "original", // layout_update wrapper for the setup layout
  "added", // layout_update wrapper for the requested block
  "version", // harness-owned layout revision field
  "blocks", // fixed root field in every layout document
  "type", // fixed discriminator in every layout block
  "collection", // fixed data-source field in list and detail blocks
]);
// form_submit values are input the harness types, not expectations
const SCHEMA_RELATIVE_CHECKS = new Set<TaskCheck["type"]>(["overwrite_disclosed", "approval_outcomes", "form_submit", "operations", "updated_record", "schema_roundtrip", "list_shows", "detail_selects", "metric_count", "tool_evolution"]);
function nestedTokens(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(nestedTokens);
  if (value && typeof value === "object") return Object.entries(value as Record<string, unknown>).flatMap(([key, nested]) => [key, ...nestedTokens(nested)]);
  return typeof value === "string" ? [value] : [];
}
export function expectationTokens(check: TaskCheck): string[] {
  if (SCHEMA_RELATIVE_CHECKS.has(check.type)) return [];
  return [...new Set(Object.entries(check).filter(([key]) => EXPECTATION_TOKEN_KEYS.has(key)).flatMap(([, value]) => nestedTokens(value)).map(token => token.replace(/^achilles__/, "")))];
}
const NUMBER_WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen", "twenty"];
// An answer may only be graded for a fact the seeded records hold: a record's string value, or a
// count of records in a collection (optionally where one field equals one value), as digits or a word.
function seededFact(value: string, setup?: TaskSetup, written: string[] = []) {
  const records = setup?.records ?? []; const lower = value.toLowerCase();
  // a value a scripted user write stored is a fact of the task too, as a record value
  if (written.some(item => item.toLowerCase() === lower)) return true;
  if (records.some(record => Object.values(record.data).some(item => typeof item === "string" && item.toLowerCase() === lower))) return true;
  const number = /^\d+$/.test(value) ? Number(value) : NUMBER_WORDS.indexOf(lower);
  if (number < 0) return false;
  const counts = new Map<string, number>();
  for (const record of records) {
    const keys = [record.collection, ...Object.entries(record.data).filter(([, item]) => item === null || typeof item !== "object").map(([field, item]) => `${record.collection}\0${field}\0${JSON.stringify(item)}`)];
    for (const key of keys) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.values()].includes(number);
}
// Case-insensitive mention of one value as a whole token: no letter or digit touches either end.
// Digit values also skip decimals and digit groups ("12" never matches "120", "12.5", "1,12", or "12th");
// word values also skip hyphenated compounds ("three" never matches "threefold" or "thirty-three").
// shortcut: this is a plain substring scan, not language understanding. it cannot see negation
// ("it's not 3, it's 2" still mentions "3"), a numbered list item ("1. Dune\n2. Emma\n3. Beloved"
// mentions "3"), or a record id ("book-3" mentions "3"). only use this check where the other
// plausible answers in the task are unlikely to appear this way in the same sentence.
const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
export function mentions(answer: string, value: string) {
  const edges = /^\d+$/.test(value) ? ["(?<!\\d[.,])", "(?![.,]\\d)"] : ["(?<![\\p{L}\\p{N}]-)", "(?!-[\\p{L}\\p{N}])"];
  return new RegExp(`(?<![\\p{L}\\p{N}])${edges[0]}${escapeRegex(value)}(?![\\p{L}\\p{N}])${edges[1]}`, "iu").test(answer);
}
function validateExpectations(checks: TaskCheck[], promptText: string, setup?: TaskSetup, requires: string[] = [], written: string[] = []) {
  const declared = new Set<string>(["inspect_page", ...requires]);
  for (const tool of setup?.tools ?? []) {
    declared.add(tool.name); declared.add(tool.collection); const properties = tool.input_schema?.properties;
    if (properties && typeof properties === "object" && !Array.isArray(properties)) for (const [name, schema] of Object.entries(properties)) {
      declared.add(name);
      if (schema && typeof schema === "object" && !Array.isArray(schema)) {
        for (const key of ["const", "default"] as const) if (typeof schema[key] === "string") declared.add(schema[key]);
        for (const value of (schema as Record<string, unknown>).enum as unknown[] ?? []) if (typeof value === "string") declared.add(value);
      }
    }
  }
  for (const record of setup?.records ?? []) {
    declared.add(record.collection);
    for (const [key, value] of Object.entries(record.data)) { declared.add(key); if (typeof value === "string") declared.add(value); }
  }
  for (const token of nestedTokens(setup?.initial_layout)) declared.add(token);
  for (const check of checks.filter(check => check.type === "answer_mentions")) for (const value of check.value as string[]) {
    if (!seededFact(value, setup, written)) throw new Error(`check ${check.id} expects ${JSON.stringify(value)} in the answer, which is not a seeded record value or count`);
  }
  for (const check of checks) {
    for (const field of check.fields ?? []) if (!promptText.includes(field) && !declared.has(field)) throw new Error(`check ${check.id} expects list field ${JSON.stringify(field)} without a prompt quote or declared schema`);
    if (check.type !== "approval_outcomes") continue;
    const value = check.value as { records: string[]; set: Record<string, unknown> };
    for (const id of value.records) if (!setup?.records.some(record => record.id === id && record.collection === check.collection)) throw new Error(`check ${check.id} names record ${JSON.stringify(id)}, which is not seeded in ${check.collection}`);
    for (const token of nestedTokens(value.set)) if (!promptText.includes(token) && !declared.has(token)) throw new Error(`check ${check.id} expects ${JSON.stringify(token)} without a prompt quote or declared schema`);
    if (!declared.has(check.tool!.replace(/^achilles__/, ""))) throw new Error(`check ${check.id} names undeclared tool ${check.tool}`);
  }
  for (const check of checks.filter(check => check.type !== "answer_mentions")) for (const token of expectationTokens(check)) {
    // Count names select a closed snapshot collection; layout checks use a fixed document envelope.
    const structural = ["layout_contains", "layout_update"].includes(check.type) && LAYOUT_STRUCTURAL_TOKENS.has(token);
    if (check.type !== "count" && !structural && !promptText.includes(token) && !declared.has(token)) throw new Error(`check ${check.id} expects ${JSON.stringify(token)} without a prompt quote or declared schema`);
  }
}

export function validateTask(value: unknown): EvalTask {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("task must be an object");
  own(value, ["id", "prompt", "page_plan", "agent_turns", "steps", "checks", "setup", "approval_mode", "requires", "goal_capabilities", "suite"], "task"); const task = value as Record<string, unknown>;
  if (typeof task.id !== "string" || !/^[a-z0-9-]+$/.test(task.id)) throw new Error("task.id must be kebab-case");
  if (task.prompt !== undefined && typeof task.prompt !== "string") throw new Error("task.prompt must be a string");
  if (task.suite !== undefined && !["core", "focused", "hard"].includes(String(task.suite))) throw new Error("task.suite must be core, focused, or hard");
  if (!Number.isInteger(task.agent_turns) || (task.agent_turns as number) < 1 || (task.agent_turns as number) > 20) throw new Error("agent_turns must be 1..20");
  if (task.approval_mode !== undefined && !["allow", "ask"].includes(String(task.approval_mode))) throw new Error("approval_mode must be allow or ask");
  if (task.requires !== undefined && (!Array.isArray(task.requires) || !task.requires.length || !task.requires.every(identifier) || new Set(task.requires).size !== task.requires.length)) throw new Error("requires must name unique capabilities");
  if (task.goal_capabilities !== undefined && (!Array.isArray(task.goal_capabilities) || !task.goal_capabilities.length || !task.goal_capabilities.every(identifier) || new Set(task.goal_capabilities).size !== task.goal_capabilities.length)) throw new Error("goal_capabilities must name unique capabilities");
  const page_plan = validatePages(task.page_plan); const aliases = new Set(page_plan.map(page => page.alias));
  const prompt = task.prompt as string | undefined;
  const setup = validateSetup(task.setup); const steps = validateSteps(task.steps, aliases, prompt, task.approval_mode as EvalTask["approval_mode"]); const checks = validateChecks(task.checks, aliases);
  validateBrowserSteps(steps, page_plan);
  for (const check of checks) if (check.step !== undefined && !steps.some(step => step.id === check.step && step.page === check.page && MODEL_STEPS.has(step.kind) && (check.type !== "reload" || step.reload) && (check.type !== "new_chat_kept" || step.new_chat) && (check.type !== "delivered_once" || step.delivery_fault))) throw new Error(`check ${check.id} names step ${check.step}, which is not a ${check.type === "reload" ? "reloading" : check.type === "new_chat_kept" ? "new_chat" : "prompt"} step on page ${check.page}`);
  for (const check of checks.filter(check => check.type === "overwrite_disclosed")) {
    const { field, agent_value } = check.value as { field: string; agent_value: string | number }; const step = steps.find(item => item.id === check.step);
    if (!step?.during?.user_write || !(field in step.during.user_write.arguments)) throw new Error(`check ${check.id} needs step ${check.step} to have a during user_write that sets ${field}`);
    if (!String(step.prompt ?? prompt ?? "").includes(String(agent_value))) throw new Error(`check ${check.id} expects agent_value ${JSON.stringify(agent_value)} without a prompt quote`);
  }
  const written = steps.flatMap(step => Object.entries(step.arguments ?? step.during?.user_write?.arguments ?? {}).filter(([key, value]) => key !== "record_id" && ["string", "number"].includes(typeof value)).map(([, value]) => String(value)));
  validateExpectations(checks, [prompt, ...steps.flatMap(step => [step.prompt ?? "", step.follow_up ?? "", step.new_chat ?? "", step.during?.steer ?? "", ...nestedTokens(step.arguments), ...nestedTokens(step.during?.user_write?.arguments)])].join(" "), setup, task.requires as string[] ?? [], written);
  return { id: task.id, prompt, page_plan, agent_turns: task.agent_turns as number, goal_capabilities: task.goal_capabilities as string[] | undefined, approval_mode: task.approval_mode as EvalTask["approval_mode"], requires: task.requires as string[] | undefined, setup, steps, checks, suite: (task.suite as EvalTask["suite"]) ?? "focused" };
}

const rows = (snapshot: EvalSnapshot, type: keyof EvalSnapshot): Array<Record<string, unknown>> => (snapshot[type] as Array<Record<string, unknown>> | undefined) ?? [];
const expectedPageId = (snapshot: EvalSnapshot, alias?: string) => rows(snapshot, "pages").find(page => page.alias === alias)?.id;
const successful = (row: Record<string, unknown>) => row.success === true || (row.success !== false && row.error == null && row.ok !== false);
export function structurallyContains(actual: unknown, expected: unknown): boolean {
  if (Object.is(actual, expected)) return true;
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) return Boolean(actual && typeof actual === "object" && Object.values(actual).some(value => structurallyContains(value, expected)));
    if (expected.length > actual.length) return false;
    const match = (index: number, used: Set<number>): boolean => index === expected.length || actual.some((value, candidate) => !used.has(candidate) && structurallyContains(value, expected[index]) && match(index + 1, new Set([...used, candidate])));
    return match(0, new Set());
  }
  if (Array.isArray(actual)) return actual.some(value => structurallyContains(value, expected));
  if (!actual || !expected || typeof actual !== "object" || typeof expected !== "object") return false;
  const actualObject = actual as Record<string, unknown>; const entries = Object.entries(expected as Record<string, unknown>);
  if (entries.every(([key, value]) => key in actualObject && structurallyContains(actualObject[key], value))) return true;
  return Object.values(actualObject).some(value => structurallyContains(value, expected));
}

function matchingObjects(actual: unknown, expected: unknown): Array<Record<string, unknown>> {
  if (!actual || typeof actual !== "object") return [];
  if (Array.isArray(actual)) return actual.flatMap(value => matchingObjects(value, expected));
  const object = actual as Record<string, unknown>; const shape = expected as Record<string, unknown>;
  const match = expected && typeof expected === "object" && !Array.isArray(expected) && Object.entries(shape).every(([key, value]) => key in object && structurallyContains(object[key], value));
  return [...(match ? [object] : []), ...Object.values(object).flatMap(value => matchingObjects(value, expected))];
}
function schemaStringFields(version: Record<string, unknown>) {
  const fields = new Set<string>();
  for (const schema of [version.data_schema, version.input_schema]) {
    if (!schema || typeof schema !== "object" || Array.isArray(schema)) continue;
    const properties = (schema as Record<string, unknown>).properties;
    if (!properties || typeof properties !== "object" || Array.isArray(properties)) continue;
    for (const [name, value] of Object.entries(properties)) if (value && typeof value === "object" && !Array.isArray(value) && (value as Record<string, unknown>).type === "string") fields.add(name);
  }
  return fields;
}
function scalarValues(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(scalarValues);
  if (value && typeof value === "object") return Object.values(value).flatMap(scalarValues);
  return typeof value === "string" ? [value] : [];
}
const normalizeToken = (value: string) => value.toLowerCase().replace(/[\s_-]+/g, "");
function matchingSchemaObjects(actual: unknown, version: Record<string, unknown>, values: string[], synonyms: string[] = [], inheritedRecordId?: string): Array<Record<string, unknown>> {
  if (!actual || typeof actual !== "object") return [];
  if (Array.isArray(actual)) return actual.flatMap(value => matchingSchemaObjects(value, version, values, synonyms, inheritedRecordId));
  const object = actual as Record<string, unknown>; const recordId = typeof object.record_id === "string" ? object.record_id : inheritedRecordId; const fields = schemaStringFields(version);
  const match = values.every((value, index) => [...fields].some(field => index === values.length - 1 && synonyms.length && typeof object[field] === "string" ? [value, ...synonyms].some(expected => normalizeToken(object[field] as string) === normalizeToken(expected)) : object[field] === value));
  const found = match ? [{ ...object, ...(recordId && !("record_id" in object) ? { record_id: recordId } : {}) }] : [];
  return [...found, ...Object.values(object).flatMap(value => matchingSchemaObjects(value, version, values, synonyms, recordId))];
}
function valueRows(value: unknown): value is string[][] { return Array.isArray(value) && value.every(row => Array.isArray(row) && row.length > 0 && row.every(item => typeof item === "string")); }
function matchValueRows(actual: unknown, expected: string[][]) {
  const rows = Array.isArray(actual) ? actual : actual && typeof actual === "object" ? Object.values(actual).find(Array.isArray) ?? [] : [];
  if (!Array.isArray(rows) || rows.length !== expected.length) return false;
  const matches = (row: unknown, values: string[]) => row !== null && typeof row === "object" && values.every(value => Object.values(row).some(item => item === value));
  const assign = (index: number, used: Set<number>): boolean => index === expected.length || rows.some((row, candidate) => !used.has(candidate) && matches(row, expected[index]) && assign(index + 1, new Set([...used, candidate])));
  return assign(0, new Set());
}

type GradeContext = { check: TaskCheck; snapshot: EvalSnapshot; page: unknown; owned(type: keyof EvalSnapshot): Array<Record<string, unknown>> };
type CheckFailure = { reason: string; field?: string; before?: unknown; after?: unknown; evidence?: Record<string, unknown> };
type TransitionFailure = CheckFailure & { field: string; before: unknown; after: unknown };
const normalizeTransitionValue = (value: string) => value.toLowerCase().replace(/[\s_-]+/g, "");
const transitionFailure = (reason: string, field: string, before: unknown, after: unknown): TransitionFailure => ({ reason, field, before, after });
function selectBlockRecords(block: Record<string, unknown>, records: Array<Record<string, unknown>>, defaultToAll: boolean) {
  const equality = ["filter", "where"].find(key => block[key] && typeof block[key] === "object" && !Array.isArray(block[key])) as "filter" | "where" | undefined;
  if (equality) {
    const value = block[equality] as Record<string, unknown>; const field = value.field; const equals = value.equals;
    return { records: typeof field === "string" && "equals" in value ? records.filter(record => (record.data as Record<string, unknown> | undefined)?.[field] === equals) : [], selector: `${equality} ${JSON.stringify(value)}` };
  }
  const key = ["record_id", "record"].find(candidate => typeof block[candidate] === "string");
  if (key) {
    const id = block[key] as string;
    return { records: records.filter(record => record.id === id || record.record_id === id), selector: `${key}=${JSON.stringify(id)}` };
  }
  return defaultToAll ? { records, selector: "all records" } : undefined;
}
// per fault: how many times the page may send the text again with a fresh id (only zeta's dropped answer: zeta holds
// nothing), how many copies zeta's history ends with, and the row the page shows ("maybe sent" when zeta never answered)
const DELIVERY_FAULTS: Record<DeliveryFault, { resends: number; copies: number; shown: string | null }> = {
  dropped: { resends: 1, copies: 1, shown: null },
  evicted_delivered: { resends: 0, copies: 1, shown: null },
  evicted_queued: { resends: 0, copies: 1, shown: null },
  evicted_unknown: { resends: 0, copies: 0, shown: "maybe sent" },
  closed_before_send: { resends: 0, copies: 0, shown: "maybe sent" },
  closed_after_send: { resends: 0, copies: 1, shown: null },
};
const userCopies = (history: unknown, text: string) => {
  let parsed: unknown = []; try { parsed = typeof history === "string" ? JSON.parse(history) : history; } catch {}
  const needle = JSON.stringify(text).slice(1, -1);
  return (Array.isArray(parsed) ? parsed : []).filter(row => row?.role === "user" && JSON.stringify(row.content ?? "").includes(needle)).length;
};
const CHECK_GRADERS: Record<CheckType, (context: GradeContext) => unknown> = {
  page_exists: ({ check, snapshot, page }) => rows(snapshot, "pages").some(row => row.id === page && (!check.route || row.route === check.route)),
  count: ({ check, snapshot, page, owned }) => check.name === "pages" ? rows(snapshot, "pages").filter(row => row.id === page).length : owned(check.name as keyof EvalSnapshot).length,
  tool: ({ check, owned }) => owned("tools").some(row => row.name === check.name),
  tool_absent: ({ check, snapshot }) => !rows(snapshot, "tools").some(row => row.name === check.name),
  refused_tool_name: ({ check, snapshot, page }) => {
    const call = rows(snapshot, "calls").find(row => row.page_id === page && row.tool === "achilles__create_tool" && structurallyContains(row.arguments, { bundle: { name: check.name } }));
    const result = rows(snapshot, "results").find(row => row.page_id === page && row.call_id === call?.id && (row.success === false || row.is_error === true));
    const refusal = result?.data ?? result?.result;
    const structured = refusal && typeof refusal === "object" && !Array.isArray(refusal) && ("code" in refusal || "path" in refusal);
    const otherwiseValid = rows(snapshot, "bundle_validations").some(row => row.call_id === call?.id && row.valid === true);
    return Boolean(result) && otherwiseValid && (!structured || structurallyContains(refusal, { code: "invalid_input", path: "/bundle/name" }));
  },
  operations: ({ check, owned }) => {
    const versions = owned("tool_versions"); const required = check.value as string[];
    return [...new Set(versions.map(row => row.collection))].some(collection => required.every(operation => versions.some(row => row.collection === collection && row.operation === operation)));
  },
  updated_record: ({ check, snapshot, page, owned }) => {
    const versions = owned("tool_versions"); const results = rows(snapshot, "results").filter(row => row.page_id === page && row.chat_id === check.chat && successful(row));
    const identity = check.value as string; const before = new Set(check.transition!.before.map(normalizeTransitionValue)); const after = new Set(check.transition!.after.map(normalizeTransitionValue));
    let failure: TransitionFailure | undefined;
    for (const collection of new Set(versions.map(row => row.collection))) {
      const collectionVersions = versions.filter(version => version.collection === collection);
      const fields = [...new Set(collectionVersions.flatMap(version => [...schemaStringFields(version)]))];
      const toolResults = (operation: string) => collectionVersions.filter(version => version.operation === operation).flatMap(version => results.filter(row => row.tool === `achilles__${version.name}`).flatMap(row => matchingObjects(row.data ?? row.result, {})));
      for (const inserted of toolResults("insert")) {
        const identityField = fields.find(field => inserted[field] === identity);
        if (!identityField || typeof inserted.record_id !== "string" || !inserted.record_id.length) continue;
        const updates = toolResults("update").filter(row => row.record_id === inserted.record_id && (!(identityField in row) || row[identityField] === identity));
        const reads = toolResults("list").filter(row => row.record_id === inserted.record_id);
        for (const read of reads) {
          if (read[identityField] !== identity) {
            failure ??= transitionFailure(`identity_changed: ${identityField}=${String(inserted[identityField])}->${String(read[identityField])}`, identityField, inserted[identityField], read[identityField]);
            continue;
          }
          if (!updates.length) continue;
          const transitionFields = fields.filter(field => field !== identityField && typeof inserted[field] === "string" && before.has(normalizeTransitionValue(inserted[field] as string)));
          for (const field of transitionFields) {
            const finalValue = read[field];
            if (typeof finalValue === "string" && after.has(normalizeTransitionValue(finalValue))) return true;
            failure ??= transitionFailure(`unmapped_after_value: ${field}=${String(inserted[field])}->${String(finalValue)}`, field, inserted[field], finalValue);
          }
          if (!transitionFields.length) {
            const field = fields.find(candidate => candidate !== identityField && candidate in inserted && candidate in read && !Object.is(inserted[candidate], read[candidate]));
            if (field) failure ??= transitionFailure(`transition_mismatch: ${field}=${String(inserted[field])}->${String(read[field])}`, field, inserted[field], read[field]);
          }
        }
      }
    }
    return failure ?? false;
  },
  schema_roundtrip: ({ check, snapshot, page, owned }) => {
    const values = check.value as string[]; const results = rows(snapshot, "results").filter(row => row.page_id === page && successful(row)); const records = owned("records");
    return owned("tool_versions").some(version => {
      const matches = (actual: unknown) => matchingSchemaObjects(actual, version, values, check.synonyms).length > 0;
      return records.some(record => record.collection === version.collection && matches(record.data ?? record)) && results.some(result => result.tool === `achilles__${version.name}` && matches(result.data ?? result.result));
    });
  },
  tool_evolution: ({ check, snapshot, page, owned }) => {
    const spec = check.value as { tool: string; from: number; to: number; new_value: number; legacy_record: string; read_tool: string };
    const versions = owned("tool_versions").filter(row => row.name === spec.tool);
    const before = versions.find(row => row.version === spec.from); const after = versions.find(row => row.version === spec.to && row.tool_id === before?.tool_id);
    const assignment = owned("assignments").find(row => row.tool_id === before?.tool_id);
    const properties = (schema: unknown) => schema && typeof schema === "object" && !Array.isArray(schema) && (schema as Record<string, unknown>).properties && typeof (schema as Record<string, unknown>).properties === "object" ? (schema as { properties: Record<string, unknown> }).properties : {};
    const oldProperties = properties(before?.input_schema); const newProperties = properties(after?.input_schema);
    const required = new Set(Array.isArray((after?.input_schema as Record<string, unknown> | undefined)?.required) ? (after!.input_schema as { required: unknown[] }).required : []);
    const addedFields = Object.keys(newProperties).filter(name => !(name in oldProperties) && !required.has(name));
    const calls = rows(snapshot, "calls").filter(row => row.page_id === page && row.chat_id === check.chat && row.tool === `achilles__${spec.tool}`);
    const results = rows(snapshot, "results");
    const use = calls.find(call => addedFields.some(field => structurallyContains(call.arguments, { [field]: spec.new_value })) && results.some(result => result.call_id === call.id && successful(result) && addedFields.some(field => structurallyContains(result.data ?? result.result, { [field]: spec.new_value }))));
    const useResult = results.find(result => result.call_id === use?.id && successful(result));
    const usedField = addedFields.find(field => structurallyContains(use?.arguments, { [field]: spec.new_value }) && structurallyContains(useResult?.data ?? useResult?.result, { [field]: spec.new_value }));
    const newRecord = matchingObjects(useResult?.data ?? useResult?.result, {}).find(row => typeof row.record_id === "string")?.record_id;
    const stored = owned("records").find(row => (row.id ?? row.record_id) === newRecord && row.collection === after?.collection && row.version === spec.to && usedField && structurallyContains(row.data ?? row, { [usedField]: spec.new_value }));
    const read = results.filter(result => result.page_id === page && result.chat_id === check.chat && result.tool === `achilles__${spec.read_tool}` && successful(result)).at(-1);
    const readData = read?.data ?? read?.result;
    const readIsValid = structurallyContains(readData, { record_id: spec.legacy_record }) && typeof newRecord === "string" && usedField && structurallyContains(readData, { record_id: newRecord, [usedField]: spec.new_value });
    const legacy = owned("records").find(row => (row.id ?? row.record_id) === spec.legacy_record && row.version === spec.from);
    const initialLegacy = rows(snapshot.initial ?? {}, "records").find(row => (row.id ?? row.record_id) === spec.legacy_record && row.version === spec.from);
    const validation = rows(snapshot, "tool_schema_validations").find(row => row.tool === spec.tool && row.version === spec.to && row.field === usedField);
    return Boolean(before && after && assignment?.active_version === spec.to && usedField && validation?.number_valid === true && validation.string_valid === false && stored && readIsValid && legacy && initialLegacy && sameSeedValue(legacy.data ?? legacy, initialLegacy.data ?? initialLegacy));
  },
  answer_mentions: ({ check, snapshot }) => {
    const answer = snapshot.answers?.[check.step!];
    if (typeof answer !== "string") return { reason: `no final answer captured for step ${check.step}` } satisfies CheckFailure;
    return (check.value as string[]).some(value => mentions(answer, value)) || { reason: `answer mentions none of ${JSON.stringify(check.value)}: ${JSON.stringify(answer.slice(0, 500))}` } satisfies CheckFailure;
  },
  // the tool's approval requests target exactly the expected records; an approved record ends with `set`,
  // a denied record is never asked again and keeps its seed data, and every other record keeps its seed data
  approval_outcomes: ({ check, snapshot, page, owned }) => {
    const { records: expected, set } = check.value as { records: string[]; set: Record<string, unknown> };
    const calls = new Map(rows(snapshot, "calls").map(call => [call.id, call]));
    const requests = owned("approvals").filter(row => row.tool === check.tool).map(row => {
      const args = calls.get(row.request_id)?.arguments as Record<string, unknown> | undefined;
      return { record: typeof args?.record_id === "string" ? args.record_id : undefined, decision: row.decision === "deny" ? "deny" : "approve" };
    });
    if (requests.some(request => request.record === undefined)) return { reason: `an approval request for ${check.tool} has no record_id` } satisfies CheckFailure;
    const asked = [...new Set(requests.map(request => request.record!))].sort();
    if (JSON.stringify(asked) !== JSON.stringify([...expected].sort())) return { reason: `asked to write ${JSON.stringify(asked)}, expected ${JSON.stringify([...expected].sort())}`, evidence: { asked } } satisfies CheckFailure;
    const retried = requests.find((request, index) => request.decision === "deny" && requests.slice(index + 1).some(later => later.record === request.record));
    if (retried) return { reason: `asked again to write ${retried.record} after it was denied` } satisfies CheckFailure;
    const data = (source: EvalSnapshot, id: string) => { const row = rows(source, "records").find(record => record.page_id === page && record.collection === check.collection && (record.id ?? record.record_id) === id); return row?.data ?? row; };
    const ids = new Set([...rows(snapshot.initial ?? {}, "records").filter(row => row.page_id === page), ...owned("records")].filter(row => row.collection === check.collection).map(row => String(row.id ?? row.record_id)));
    for (const id of ids) {
      const approved = requests.some(request => request.record === id && request.decision === "approve");
      if (approved && !structurallyContains(data(snapshot, id), set)) return { reason: `approved record ${id} does not have ${JSON.stringify(set)}`, evidence: { record: id, data: data(snapshot, id) } } satisfies CheckFailure;
      if (!approved && !sameSeedValue(data(snapshot, id), data(snapshot.initial ?? {}, id))) return { reason: `record ${id} changed without an approved write`, evidence: { record: id, before: data(snapshot.initial ?? {}, id), after: data(snapshot, id) } } satisfies CheckFailure;
    }
    return true;
  },
  // shortcut: reads the tool name at bundle.name, so only create_tool; add a key when another authoring tool needs it
  denied_step: ({ check, snapshot, owned }) => {
    const names = check.value as string[]; const calls = new Map(rows(snapshot, "calls").map(call => [call.id, call]));
    const requests = owned("approvals").filter(row => row.tool === check.tool).map(row => ({ name: ((calls.get(row.request_id)?.arguments as { bundle?: { name?: unknown } } | undefined)?.bundle?.name), decision: row.decision }));
    const index = requests.findIndex(request => request.decision === "deny");
    if (index < 0) return { reason: `no ${check.tool} request was denied (${requests.length} requests)`, evidence: { requests } } satisfies CheckFailure;
    const denied = requests[index].name; const evidence = { requests, denied };
    if (typeof denied !== "string" || !names.includes(denied)) return { reason: `the denied request created ${JSON.stringify(denied)}, which is not one of ${JSON.stringify(names)}`, evidence } satisfies CheckFailure;
    if (requests.slice(index + 1).some(request => request.name === denied)) return { reason: `asked again to create ${denied} after it was denied`, evidence } satisfies CheckFailure;
    const present = new Set(owned("tool_versions").map(row => String(row.name)));
    if (present.has(denied)) return { reason: `denied tool ${denied} exists on the page`, evidence } satisfies CheckFailure;
    const missing = names.filter(name => name !== denied && !present.has(name));
    if (missing.length) return { reason: `the rest was not finished: missing ${missing.join(", ")}`, evidence } satisfies CheckFailure;
    const answer = snapshot.answers?.[check.step!];
    return (typeof answer === "string" && mentions(answer, denied)) || { reason: `the answer does not say ${denied} was not created: ${JSON.stringify(String(answer ?? "").slice(0, 500))}`, evidence } satisfies CheckFailure;
  },
  approval: ({ check, owned }) => owned("approvals").filter(row => row.tool === check.tool).length,
  // text typed after "new chat" on a page that took over a running chat was written for a new chat: it never reaches the
  // running chat, and it is either sent to another chat or still shown unsent on the page
  new_chat_kept: ({ check, owned }) => {
    const row = owned("reloads").find(item => item.step === check.step);
    if (!row) return { reason: `no reload row for step ${check.step}` } satisfies CheckFailure;
    const evidence = { reload: row }; const sent = (row.new_chat_sent ?? []) as Array<{ method: string; session_id: unknown }>;
    if (row.fired !== true || row.new_chat_typed !== true) return { reason: "the page never typed the new chat's text during the turn", evidence } satisfies CheckFailure;
    const wrong = sent.filter(frame => frame.session_id === row.session_before);
    if (wrong.length) return { reason: `the new chat's text went to the running chat as ${wrong.map(frame => frame.method).join(", ")}`, evidence } satisfies CheckFailure;
    if (!sent.length && row.new_chat_visible !== true) return { reason: "the new chat's text was not sent and is no longer shown", evidence } satisfies CheckFailure;
    return true;
  },
  // the faulted send reached the model at most once: zeta's final history holds the expected copies, the page sent the
  // text again with a fresh id only for zeta's dropped answer, and the row it shows matches what zeta knows
  delivered_once: ({ check, snapshot, owned }) => {
    const row = owned("delivery_faults").find(item => item.step === check.step);
    if (!row) return { reason: `no delivery fault row for step ${check.step}` } satisfies CheckFailure;
    const expected = DELIVERY_FAULTS[row.fault as DeliveryFault]; const text = String(row.text);
    const sent = (row.sent ?? []) as Array<{ method: string; delivery_id: unknown }>; const ids = new Set(sent.map(frame => frame.delivery_id));
    const copies = userCopies(rows(snapshot, "chats").find(chat => chat.chat_id === row.chat)?.history, text);
    const shown = (row.shown as { label?: string } | null)?.label ?? null;
    const evidence = { delivery: row, copies, expected };
    if (row.fired !== true || !expected) return { reason: "the fault never met the page's send", evidence } satisfies CheckFailure;
    if (copies > 1) return { reason: `the model saw the text ${copies} times`, evidence } satisfies CheckFailure;
    if (sent.length !== ids.size || ids.size !== 1 + expected.resends) return { reason: `the page sent the text ${sent.length} times with ${ids.size} delivery ids; expected ${1 + expected.resends}`, evidence } satisfies CheckFailure;
    if (copies !== expected.copies) return { reason: `zeta's history holds the text ${copies} times; expected ${expected.copies}`, evidence } satisfies CheckFailure;
    if (shown !== expected.shown) return { reason: `the page shows ${JSON.stringify(row.shown)}; expected ${expected.shown ? `a "${expected.shown}" row` : "no row"}`, evidence } satisfies CheckFailure;
    return true;
  },
  // the page reloaded at its trigger during the turn, came back on the same chat, attached to the running turn, and shows the turn's final answer
  reload: ({ check, owned }) => {
    const row = owned("reloads").find(item => item.step === check.step);
    if (!row) return { reason: `no reload row for step ${check.step}` } satisfies CheckFailure;
    const evidence = { reload: row };
    if (row.fired !== true) return { reason: `the reload trigger ${JSON.stringify(row.trigger)} never fired before the turn ended`, evidence } satisfies CheckFailure;
    if (row.session_after !== row.session_before) return { reason: `the reloaded page opened chat ${String(row.session_after)}, not ${String(row.session_before)}`, evidence } satisfies CheckFailure;
    if (row.attached !== "live_turn") return { reason: `the reloaded page did not attach to the running turn (attached=${JSON.stringify(row.attached ?? null)}${row.turn_ended_before_attach ? ", the turn had already ended" : ""})`, evidence } satisfies CheckFailure;
    if (row.answer_visible !== true) return { reason: "the turn's final answer is not shown on the reloaded page", evidence } satisfies CheckFailure;
    return true;
  },
  // no write ran twice: no two successful calls of the tool with the same arguments (revision aside),
  // and, with a collection and fields, no two records share those field values
  no_duplicate_writes: ({ check, snapshot, page, owned }) => {
    const key = (value: unknown) => JSON.stringify(canonicalSeedValue(value));
    const seen = new Map<string, number>();
    for (const call of rows(snapshot, "calls").filter(row => row.page_id === page && row.tool === check.tool && successful(row))) {
      const { revision: _revision, ...args } = (call.arguments ?? {}) as Record<string, unknown>; seen.set(key(args), (seen.get(key(args)) ?? 0) + 1);
    }
    const repeated = [...seen].filter(([, count]) => count > 1);
    if (repeated.length) return { reason: `${check.tool} ran ${repeated[0][1]} times with ${repeated[0][0]}`, evidence: { repeated: repeated.map(([args, count]) => ({ arguments: JSON.parse(args), count })) } } satisfies CheckFailure;
    if (!check.collection) return true;
    const records = new Map<string, string[]>();
    for (const row of owned("records").filter(item => item.collection === check.collection)) {
      const data = (row.data ?? row) as Record<string, unknown>; const id = key(check.fields!.map(field => data[field]));
      records.set(id, [...(records.get(id) ?? []), String(row.id ?? row.record_id)]);
    }
    const twins = [...records].filter(([, ids]) => ids.length > 1);
    return twins.length ? { reason: `${twins[0][1].length} ${check.collection} records share ${check.fields!.join(", ")} = ${twins[0][0]}`, evidence: { duplicates: twins.map(([values, ids]) => ({ values: JSON.parse(values), records: ids })) } } satisfies CheckFailure : true;
  },
  // the serve was killed and started again; the same chat came back with every earlier row, it finished a turn after the
  // restart (no hang), it did not redo a record that existed when the serve died, and its answer names each such record or says they were already done
  restart_recovery: ({ check, snapshot, owned }) => {
    const row = owned("interjections").find(item => item.action === "restart_zeta");
    if (!row) return { reason: "the zeta serve was never restarted (the agent never made the matching request)" } satisfies CheckFailure;
    const evidence = { restart: row };
    if (row.ok !== true) return { reason: `the restart failed: ${String(row.error ?? "unknown")}`, evidence } satisfies CheckFailure;
    if (row.resumed_session_id !== row.original_session_id) return { reason: "the chat came back as a different session", evidence } satisfies CheckFailure;
    if (row.history_continuity !== true) return { reason: "rows from before the restart are missing from the chat", evidence } satisfies CheckFailure;
    // an approval the dead turn left open must be closed (approval_end) by the end: an open one keeps a live card on the page
    const dangling = (row.dangling_approvals ?? []) as unknown[];
    if (dangling.length) return { reason: `${dangling.length} approval request(s) of the dead turn were never closed`, evidence } satisfies CheckFailure;
    const answer = snapshot.answers?.[check.step!];
    if (typeof answer !== "string") return { reason: `no turn finished after the restart (step ${check.step})`, evidence } satisfies CheckFailure;
    const field = check.fields![0]; const before = ((row.records_before ?? []) as Array<Record<string, unknown>>).filter(item => item.collection === check.collection).map(item => (item.data as Record<string, unknown> | undefined)?.[field]).filter((value): value is string => typeof value === "string");
    // naming them is not enough: an agent that redid them claims work it repeated
    const redone = before.filter(value => owned("records").filter(item => item.collection === check.collection && (item.data as Record<string, unknown> | undefined)?.[field] === value).length > 1);
    if (redone.length) return { reason: `the agent redid ${redone.join(", ")}, which existed before the restart`, evidence } satisfies CheckFailure;
    // a correct summary may name each earlier record or say they were already done ("the first two were already added")
    if (before.every(value => mentions(answer, value)) || /\b(already|earlier|before the restart)\b/i.test(answer)) return true;
    return { reason: `the answer after the restart does not say ${before.join(", ")} existed before it: ${JSON.stringify(answer.slice(0, 500))}`, evidence } satisfies CheckFailure;
  },
  // a user write during the step changed `field`; keeping the user's value passes, the agent's value passes only if the step's answer tells the user about this record's overwritten value
  overwrite_disclosed: ({ check, snapshot, owned }) => {
    const { field, agent_value } = check.value as { field: string; agent_value: unknown };
    const write = rows(snapshot, "interjections").find(row => row.step === check.step && row.action === "user_write");
    if (!write) return { reason: `no user write happened during ${check.step}` } satisfies CheckFailure;
    const args = write.arguments as Record<string, unknown>; const userValue = args[field];
    const record = owned("records").find(row => row.collection === check.collection && (row.id ?? row.record_id) === args.record_id);
    const final = ((record?.data ?? record) as Record<string, unknown> | undefined)?.[field]; const evidence = { record: args.record_id, field, user_value: userValue, agent_value, final };
    if (sameSeedValue(final, userValue)) return true;
    if (!sameSeedValue(final, agent_value)) return { reason: `${field} is ${JSON.stringify(final)}, neither the user's nor the agent's value`, evidence } satisfies CheckFailure;
    // told = the answer names this record, and a sentence names the user's value and no other record's title
    // shortcut: "Ship docs and Plan offsite were both set to low" by a correct agent also fails; fine for one-record steps
    // (an answer that lists every task and says "Plan offsite stays low" is not telling the user about Ship docs)
    const title = (row: Record<string, unknown> | undefined) => String(((row?.data ?? row) as Record<string, unknown> | undefined)?.title ?? row?.id ?? "");
    const others = owned("records").filter(row => row.collection === check.collection && row !== record).map(title).filter(Boolean);
    const answer = snapshot.answers?.[check.step!];
    const told = typeof answer === "string" && mentions(answer, title(record)) && answer.split(/[.!?;\n]+/).some(sentence => mentions(sentence, String(userValue)) && !others.some(other => mentions(sentence, other)));
    return told || { reason: `the agent overwrote the user's ${field} ${JSON.stringify(userValue)} with ${JSON.stringify(agent_value)} without saying so: ${JSON.stringify(String(answer ?? "").slice(0, 500))}`, evidence } satisfies CheckFailure;
  },
  // a failed turn is a durable history row the chat renders as an error, live and after a reload
  error_shown: ({ check, snapshot, page }) => rows(snapshot, "failed_turns").some(row => row.page_id === page && (!check.chat || row.chat_id === check.chat) && JSON.stringify(row).includes(String(check.value))) || { reason: `the chat shows no error with ${String(check.value)}` } satisfies CheckFailure,
  reconnect: ({ owned }) => owned("reconnects").some(row => row.original_session_id === row.resumed_session_id && row.history_continuity === true),
  record: ({ check, owned }) => owned("records").some(row => structurallyContains(row.data ?? row, check.value)),
  records_exact: ({ check, owned }) => {
    const actual = owned("records").map(row => row.data ?? row); const expected = check.value as unknown[];
    return actual.length === expected.length && (valueRows(expected) ? matchValueRows(actual, expected) : structurallyContains(actual, expected));
  },
  successful_result: ({ check, snapshot, page }) => rows(snapshot, "results").some(row => {
    const actual = row.data ?? row.result; const expected = check.value;
    return row.page_id === page && successful(row) && row.tool === check.tool && (!check.chat || row.chat_id === check.chat) && (expected === undefined || (valueRows(expected) ? matchValueRows(actual, expected) : structurallyContains(actual, expected)));
  }),
  no_error: ({ check, snapshot, page }) => rows(snapshot, "errors").filter(row => row.page_id === page && (!check.chat || row.chat_id === check.chat)).length === 0,
  no_unrecovered_error: ({ check, snapshot, page }) => {
    const attempts = rows(snapshot, "results").filter(row => row.page_id === page && (!check.chat || row.chat_id === check.chat) && row.tool === (check.tool ?? "achilles__update_layout"));
    return attempts.length === 0 || (attempts.at(-1)?.success === true && attempts.every((attempt, index) => attempt.success !== false || attempts.slice(index + 1).some(later => later.success === true)));
  },
  assigned_tools_only: ({ snapshot, page, owned }) => {
    const assigned = new Set(owned("tool_versions").map(row => `achilles__${String(row.name)}`));
    // discovery and the read-only page view are listed on every page, so they are not "unassigned" tools
    const always = new Set(["mcp_discover", "achilles__inspect_page"]);
    const other = rows(snapshot, "calls").filter(row => row.page_id === page && !always.has(String(row.tool)) && !assigned.has(String(row.tool))).map(row => String(row.tool));
    return other.length ? { reason: `called tools the page does not assign: ${[...new Set(other)].join(", ")}` } satisfies CheckFailure : true;
  },
  no_new_page: ({ snapshot }) => {
    if (!snapshot.initial) return { reason: "no initial snapshot to compare pages with" } satisfies CheckFailure;
    const before = new Set(rows(snapshot.initial, "pages").map(row => row.id));
    const added = rows(snapshot, "pages").filter(row => !before.has(row.id)).map(row => String(row.route ?? row.id));
    return added.length ? { reason: `new pages: ${added.join(", ")}` } satisfies CheckFailure : true;
  },
  layout_restore: ({ snapshot, page }) => {
    const layouts = rows(snapshot, "layouts").filter(row => row.page_id === page).sort((a, b) => Number(a.version) - Number(b.version));
    const activeVersion = rows(snapshot, "pages").find(row => row.id === page)?.active_layout_version;
    const original = layouts[0]; const active = layouts.at(-1);
    if (!original || original.version !== 1 || !active || active.version !== activeVersion || layouts.some((row, index) => row.version !== index + 1)) return { reason: `layout history is not versions 1..${String(activeVersion)} with the last one active` } satisfies CheckFailure;
    if (!layouts.slice(1, -1).some(row => !sameSeedValue(row.document, original.document))) return { reason: "no layout change before the undo" } satisfies CheckFailure;
    if (!sameSeedValue(active.document, original.document)) return { reason: `active layout v${String(active.version)} is not a copy of v1` } satisfies CheckFailure;
    // the active version is the last one appended, so a restore result that made it implies the order; tool restores do not count
    const restored = rows(snapshot, "results").some(row => row.page_id === page && successful(row) && row.tool === "achilles__restore_version" && structurallyContains(row.data ?? row.result, { kind: "layout", version: active.version }));
    if (!restored) return { reason: `no successful restore_version made layout v${String(active.version)}` } satisfies CheckFailure;
    return true;
  },
  browser_text: ({ check, owned }) => owned("browser").some(row => check.synonyms ? String(row.text ?? "").split(/[\t\r\n]+/).some(cell => [check.text!, ...check.synonyms!].some(value => normalizeToken(cell.trim()) === normalizeToken(value))) : String(row.text ?? "").includes(String(check.text))),
  // one row per insert form block the browser submitted; each must add exactly one record (from the DB, not the screen)
  form_submit: ({ owned }) => {
    const submits = owned("form_submits");
    if (!submits.length) return { reason: "the page has no insert form" } satisfies CheckFailure;
    for (const row of submits) {
      if (typeof row.unsupported === "string") return { reason: `form ${String(row.tool)} shows "this form needs the chat": unsupported field ${row.unsupported}`, evidence: { tool: row.tool, field: row.unsupported } } satisfies CheckFailure;
      if (typeof row.error === "string") return { reason: `form ${String(row.tool)}: ${row.error}`, evidence: { tool: row.tool } } satisfies CheckFailure;
      if (row.new_records !== 1) return { reason: `form ${String(row.tool)} added ${String(row.new_records)} records to ${String(row.collection)}, expected 1`, evidence: { tool: row.tool, new_records: row.new_records } } satisfies CheckFailure;
    }
    return true;
  },
  prompt: ({ check, owned }) => owned("chats").some(row => row.prompt === check.text || row.first_prompt === check.text),
  same_page: ({ snapshot, page }) => (snapshot.related_page_ids?.length ?? 0) > 0 && snapshot.related_page_ids!.every(id => id === page),
  layout_contains: ({ check, owned }) => owned("layouts").some(row => structurallyContains(row.document, check.value)),
  list_shows: ({ check, owned }) => {
    const layouts = owned("layouts").sort((a, b) => Number(a.version ?? 0) - Number(b.version ?? 0));
    const blocks = (layouts.at(-1)?.document as { blocks?: unknown[] } | undefined)?.blocks;
    const lists = Array.isArray(blocks) ? blocks.filter((block): block is Record<string, unknown> => Boolean(block && typeof block === "object" && !Array.isArray(block) && (block as Record<string, unknown>).type === "list")) : [];
    if (!lists.length) return { reason: "no list block" } satisfies CheckFailure;
    let failure: CheckFailure = { reason: "no matching list block" };
    for (const list of lists) {
      const recordCollections = [...new Set(owned("records").map(record => record.collection).filter((value): value is string => typeof value === "string"))];
      const collection = typeof list.collection === "string" ? list.collection : recordCollections.length === 1 ? recordCollections[0] : undefined;
      if (check.collection !== undefined && collection !== check.collection) { failure = { reason: `list on ${String(collection)}, expected ${check.collection}` }; continue; }
      if (collection === undefined) { failure = { reason: "list has no collection" }; continue; }
      if (check.fields && JSON.stringify(list.fields) !== JSON.stringify(check.fields)) { failure = { reason: `list on ${collection} has fields ${JSON.stringify(list.fields ?? null)}, expected ${JSON.stringify(check.fields)} in that order` }; continue; }
      if (check.value === undefined) return true;
      const selected = selectBlockRecords(list, owned("records").filter(record => record.collection === collection), true)!;
      if (selected.records.some(record => record.data && typeof record.data === "object" && !Array.isArray(record.data) && Object.values(record.data).some(value => value === check.value))) return true;
      failure = { reason: `${selected.selector} on ${collection} has no record with ${JSON.stringify(check.value)}` };
    }
    return failure;
  },
  detail_selects: ({ check, owned }) => {
    const layouts = owned("layouts").sort((a, b) => Number(a.version ?? 0) - Number(b.version ?? 0));
    const blocks = (layouts.at(-1)?.document as { blocks?: unknown[] } | undefined)?.blocks;
    const details = Array.isArray(blocks) ? blocks.filter((block): block is Record<string, unknown> => Boolean(block && typeof block === "object" && !Array.isArray(block) && (block as Record<string, unknown>).type === "detail")) : [];
    if (!details.length) return { reason: "no detail block" } satisfies CheckFailure;
    let failure: CheckFailure = { reason: "no supported detail selector" };
    for (const detail of details) {
      if (detail.collection !== check.collection) { failure = { reason: `detail collection ${JSON.stringify(detail.collection)} is not ${JSON.stringify(check.collection)}` }; continue; }
      const selected = selectBlockRecords(detail, owned("records").filter(record => record.collection === check.collection), false);
      if (!selected) continue;
      if (selected.records.length !== 1) { failure = { reason: `${selected.selector} matches ${selected.records.length} records` }; continue; }
      const data = selected.records[0].data;
      if (data && typeof data === "object" && !Array.isArray(data) && Object.values(data).some(value => value === check.value)) return true;
      failure = { reason: `${selected.selector} selects a record without ${JSON.stringify(check.value)}` };
    }
    return failure;
  },
  metric_count: ({ check, snapshot, page, owned }) => {
    const expected = check.value as { collection: string; where: { field: string; equals: unknown }; count: number; position: "first" };
    const layouts = owned("layouts").sort((a, b) => Number(a.version ?? 0) - Number(b.version ?? 0));
    const blocks = (layouts.at(-1)?.document as { blocks?: unknown[] } | undefined)?.blocks;
    const metric = Array.isArray(blocks) && blocks[0] && typeof blocks[0] === "object" && !Array.isArray(blocks[0]) ? blocks[0] as Record<string, unknown> : undefined;
    if (!metric || metric.type !== "metric" || metric.collection !== expected.collection || metric.count !== true || !structurallyContains(metric.where, expected.where)) return false;
    const records = owned("records").filter(record => record.collection === expected.collection);
    if (selectBlockRecords(metric, records, false)?.records.length !== expected.count) return false;
    const inspect = rows(snapshot, "results").filter(row => row.page_id === page && row.tool === "achilles__inspect_page" && successful(row)).at(-1);
    return Boolean(inspect && structurallyContains(inspect.data ?? inspect.result, { metric_values: [{ block: 0, value: expected.count }] }));
  },
  layout_update: ({ check, snapshot, page }) => {
    const expected = check.value as { original: { blocks: unknown[] }; added: unknown; version: number };
    const layouts = rows(snapshot, "layouts");
    const target = layouts.filter(row => row.page_id === page).sort((a, b) => Number(a.version) - Number(b.version));
    const active = target.at(-1);
    const blocks = (active?.document as { blocks?: unknown[] } | undefined)?.blocks;
    const otherPageChanged = layouts.some(row => row.page_id !== page && Number(row.version) > 1);
    return !otherPageChanged && Number(active?.version) === expected.version && target.some(row => Number(row.version) === 1 && structurallyContains(row.document, expected.original)) && Array.isArray(blocks) && blocks.length === expected.original.blocks.length + 1 && structurallyContains(blocks, [...expected.original.blocks, expected.added]);
  },
};
export function gradeCheck(check: TaskCheck, snapshot: EvalSnapshot): CheckResult {
  const expected = check.value ?? check.count ?? (check.max === undefined ? undefined : `1..${check.max}`) ?? check.text ?? true; const page = expectedPageId(snapshot, check.page); const owned = (type: keyof EvalSnapshot) => rows(snapshot, type).filter(row => row.page_id === page || row.pageId === page);
  const result = CHECK_GRADERS[check.type]({ check, snapshot, page, owned });
  const failure = result && typeof result === "object" && "reason" in result ? result as CheckFailure : undefined;
  // max: the agent asked at least once and did not loop past the bound
  const pass = failure ? false : check.max !== undefined ? typeof result === "number" && result >= 1 && result <= check.max : ["count", "approval"].includes(check.type) ? result === expected : Boolean(result);
  const transition = failure?.field === undefined ? {} : { transition: { field: failure.field, before: failure.before, after: failure.after } };
  return { id: check.id, pass, expected, actual: failure ? false : result, evidence: { type: check.type, page, ...transition, ...failure?.evidence }, ...(failure ? { reason: failure.reason } : {}) };
}

const canonicalSeedValue = (value: unknown): unknown => Array.isArray(value) ? value.map(canonicalSeedValue) : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonicalSeedValue(item)])) : value;
const sameSeedValue = (left: unknown, right: unknown) => JSON.stringify(canonicalSeedValue(left)) === JSON.stringify(canonicalSeedValue(right));

export function declaredSeedMismatches(setup: TaskSetup, storedState: EvalSnapshot & Record<string, any>): string[] {
  const failures: string[] = [];
  const inspected = storedState.inspect as Record<string, any> | undefined;
  const tools = storedState.tool_versions ?? inspected?.tools ?? [];
  for (const expected of setup.tools) {
    const tool = tools.find((row: Record<string, any>) => (row.page_id === undefined || row.page_id === "home") && row.name === expected.name);
    const stored = tool && { ...tool, operation: tool.operation ?? tool.operations?.[0] };
    if (!stored || Object.entries(expected).some(([key, value]) => !sameSeedValue(stored[key], value))) failures.push(`seed mismatch: tool ${expected.name}`);
  }

  const records = Array.isArray(storedState.records) ? storedState.records : Object.entries(storedState.records ?? {}).flatMap(([collection, items]) => (items as Array<Record<string, unknown>>).map(item => ({ ...item, id: item.record_id, collection, data: Object.fromEntries(Object.entries(item).filter(([key]) => !["record_id", "revision"].includes(key))) })));
  for (const expected of setup.records) {
    const record = records.find((row: Record<string, any>) => (row.page_id === undefined || row.page_id === "home") && (row.id ?? row.record_id) === expected.id && row.collection === expected.collection);
    const stored = record && { ...record, id: record.id ?? record.record_id, data: record.data ?? Object.fromEntries(Object.keys(expected.data).map(key => [key, record[key]])) };
    if (!stored || Object.entries(expected).some(([key, value]) => !sameSeedValue(stored[key], value))) failures.push(`seed mismatch: record ${expected.collection}/${expected.id}`);
  }

  if (setup.initial_layout) {
    const layout = storedState.layouts?.find((row: Record<string, any>) => row.page_id === "home" && row.version === 1)?.document ?? storedState.layout;
    const version = storedState.layouts ? (layout === undefined ? undefined : 1) : inspected?.layout_version ?? inspected?.layout?.version;
    if (version !== 1 || !sameSeedValue(layout, setup.initial_layout)) failures.push("seed mismatch: initial_layout at version 1");
  }
  return failures;
}

export function setupPreconditionFailures(task: EvalTask, snapshot: EvalSnapshot): string[] {
  const failures = task.setup ? declaredSeedMismatches(task.setup, snapshot) : [];
  const evolutionPage = task.checks.find(check => check.type === "tool_evolution")?.page;
  const page = expectedPageId(snapshot, evolutionPage) ?? (task.page_plan.find(plan => plan.alias === evolutionPage)?.source === "created" ? undefined : "home");
  for (const check of task.checks.filter(check => check.type === "tool_evolution")) {
    const spec = check.value as { tool: string; from: number; legacy_record: string; read_tool: string };
    for (const name of [spec.tool, spec.read_tool]) {
      const tool = rows(snapshot, "tools").find(row => row.page_id === page && row.name === name);
      const version = rows(snapshot, "tool_versions").find(row => row.page_id === page && row.tool_id === tool?.id && row.name === name && row.version === spec.from);
      const assignment = rows(snapshot, "assignments").find(row => row.page_id === page && row.tool_id === tool?.id && row.active_version === spec.from);
      if (!tool || !version || !assignment) failures.push(`seed mismatch: ${name} is not active at v${spec.from}`);
    }
    const legacy = rows(snapshot, "records").find(row => row.page_id === page && (row.id ?? row.record_id) === spec.legacy_record && row.version === spec.from);
    if (!legacy) failures.push(`seed mismatch: record ${spec.legacy_record} is not v${spec.from}`);
  }
  return failures;
}
function userWriteFailures(task: EvalTask, snapshot: EvalSnapshot): string[] {
  const during = task.steps.filter(step => step.during?.user_write).flatMap(step => {
    // no row: the agent never made the n-th request, so the write never had its moment; the graded state shows it
    const write = rows(snapshot, "interjections").find(row => row.step === step.id);
    if (!write) return [];
    return write.ok === true && write.revision_after === Number(write.revision_before) + 1 ? [] : [`user write during ${step.id} failed (${write.status})`];
  });
  return [...during, ...task.steps.filter(step => step.kind === "user_write").flatMap(step => {
    const write = rows(snapshot, "user_writes").find(row => row.step === step.id);
    // a write that never ran because the agent used every turn first is the agent's cap hit, not a harness error
    if (!write && (snapshot.turns ?? 0) >= task.agent_turns) return [];
    if (!write || write.ok !== true) return [`user write ${step.id} failed (${write?.status ?? "not run"})`];
    return write.revision_after === Number(write.revision_before) + 1 ? [] : [`user write ${step.id} did not bump the revision`];
  })];
}
function setupFailures(task: EvalTask, snapshot: EvalSnapshot): string[] {
  const failures = userWriteFailures(task, snapshot);
  if (!task.setup) return failures;
  failures.push(...(snapshot.initial ? setupPreconditionFailures(task, snapshot.initial) : ["setup precondition unverifiable"]));
  if (task.checks.some(check => check.type === "tool_evolution") && !Array.isArray(snapshot.tool_schema_validations)) failures.push(snapshot.tool_schema_validation_error ?? "product schema validation unavailable");
  return failures;
}
export function assertSetupPreconditions(task: EvalTask, snapshot: EvalSnapshot) {
  const failures = setupPreconditionFailures(task, snapshot);
  if (failures.length) throw new Error(`task grader preconditions failed: ${failures.join(", ")}`);
}

export function hostToolsGap(snapshot: EvalSnapshot): boolean {
  const forbidden = /^(bash|sqlite|write|edit|read|fetch|process|shell)(__|$)/i;
  return rows(snapshot, "calls").some(call => forbidden.test(String(call.tool ?? call.name ?? ""))) || rows(snapshot, "errors").some(error => /unknown[- ]?tool|tool not available|disallowed tool/i.test(String(error.code ?? error.message ?? "")));
}
export type EvalDiagnostics = { first_call_validity: Record<string, boolean>; observed_catalog?: string[]; structured_tool_errors: Array<{ code: unknown; path: unknown; expected: unknown }>; unstructured_tool_errors: number; conflict_seen?: boolean };
// report-only evidence for user_write tasks: did the agent's stale write get a conflict? an agent that reads again first never sees one, so this is never graded
function conflictSeen(task: EvalTask, snapshot: EvalSnapshot): { conflict_seen?: boolean } {
  const tools = new Set(task.steps.flatMap(step => step.kind === "user_write" ? [step.tool] : step.during?.user_write ? [step.during.user_write.tool] : []).map(tool => `achilles__${tool}`));
  if (!tools.size) return {};
  return { conflict_seen: rows(snapshot, "results").some(row => tools.has(String(row.tool)) && (row.data as { code?: unknown } | undefined)?.code === "conflict") };
}
export function diagnostics(snapshot: EvalSnapshot): EvalDiagnostics {
  const first_call_validity: Record<string, boolean> = {};
  for (const name of ["create_page", "create_tool"]) { const call = rows(snapshot, "calls").find(row => String(row.tool ?? row.name ?? "").endsWith(name)); if (call) first_call_validity[name] = successful(call); }
  const errors = rows(snapshot, "errors"); const structured = errors.filter(row => "code" in row && "path" in row && "expected" in row);
  return { first_call_validity, structured_tool_errors: structured.map(row => ({ code: row.code, path: row.path, expected: row.expected })), unstructured_tool_errors: errors.length - structured.length };
}
export function gradeTask(task: EvalTask, snapshot: EvalSnapshot) {
  const preconditions = setupFailures(task, snapshot);
  if (preconditions.length) return { task_id: task.id, pass: false, score: 0, checks: [{ id: "harness", pass: false, expected: "grader preconditions", actual: preconditions, evidence: { initial: snapshot.initial } }], turns: snapshot.turns ?? 0, wall_ms: snapshot.wall_ms ?? 0, tool_calls: rows(snapshot, "calls").length, approvals: rows(snapshot, "approvals").length, usage: snapshot.usage ?? "unavailable", host_tools_gap: hostToolsGap(snapshot), diagnostics: { ...diagnostics(snapshot), ...conflictSeen(task, snapshot) } };
  const checks = task.checks.map(check => gradeCheck(check, snapshot)); const required = checks.filter((_, i) => task.checks[i].required !== false);
  const score = Math.round((checks.filter(result => result.pass).length / checks.length) * 100);
  return { task_id: task.id, pass: required.every(result => result.pass) && score >= 80, score, checks, turns: snapshot.turns ?? 0, wall_ms: snapshot.wall_ms ?? 0, tool_calls: rows(snapshot, "calls").length, approvals: rows(snapshot, "approvals").length, usage: snapshot.usage ?? "unavailable", host_tools_gap: hostToolsGap(snapshot), diagnostics: { ...diagnostics(snapshot), ...conflictSeen(task, snapshot) } };
}

export function gradeReference(task: EvalTask, snapshot: EvalSnapshot) {
  const result = gradeTask(task, snapshot); const preconditions = setupFailures(task, snapshot);
  const staticFailure = rows(snapshot, "browser").some(row => /static file not found/i.test(String(row.text ?? "")));
  return { ...result, status: preconditions.length || staticFailure ? "harness_error" as const : result.pass ? "pass" as const : "agent_fail" as const };
}
