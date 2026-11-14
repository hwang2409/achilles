export type TaskCheck = {
  id: string;
  type: "page_exists" | "count" | "tool" | "tool_absent" | "refused_tool_name" | "operations" | "updated_record" | "schema_roundtrip" | "approval" | "reconnect" | "record" | "records_exact" | "successful_result" | "no_error" | "browser_text" | "prompt" | "same_page" | "layout_contains" | "layout_update" | "no_unrecovered_error";
  required?: boolean;
  page?: string;
  chat?: string;
  name?: string;
  value?: unknown;
  transition?: { before: string[]; after: string[] };
  count?: number;
  text?: string;
  tool?: string;
  route?: string;
};
export type PagePlan = { alias: string; source: "fixture" | "setup" | "created"; bind_chat: boolean; create_mode: boolean; route?: string };
export type TaskStep = { id: string; kind: "prompt" | "annotate" | "reconnect"; page: string; chat: string; prompt?: string };
export type TaskSetup = { tools: Array<{ name: string; operation: "list" | "get" | "insert" | "update"; collection: string; input_schema?: Record<string, unknown> }>; records: Array<{ id: string; collection: string; data: Record<string, unknown> }>; initial_layout?: { blocks: unknown[] } };
export type EvalTask = { id: string; prompt?: string; page_plan: PagePlan[]; agent_turns: number; steps: TaskStep[]; checks: TaskCheck[]; setup?: TaskSetup; approval_mode?: "allow" | "ask"; requires?: string[]; goal_capabilities?: string[] };
export type EvalSnapshot = {
  pages?: Array<Record<string, unknown>>; tools?: Array<Record<string, unknown>>; assignments?: Array<Record<string, unknown>>;
  records?: Array<Record<string, unknown>>; layouts?: Array<Record<string, unknown>>; chats?: Array<Record<string, unknown>>;
  calls?: Array<Record<string, unknown>>; results?: Array<Record<string, unknown>>; approvals?: Array<Record<string, unknown>>;
  errors?: Array<Record<string, unknown>>; browser?: Array<Record<string, unknown>>; tool_versions?: Array<Record<string, unknown>>;
  reconnects?: Array<Record<string, unknown>>; bundle_validations?: Array<Record<string, unknown>>; related_page_ids?: string[];
  turns?: number; wall_ms?: number; usage?: Record<string, unknown>; tool_policy?: string; observed_catalog?: string[]; session_history?: unknown[];
};
export type CheckResult = { id: string; pass: boolean; expected: unknown; actual: unknown; evidence: unknown; reason?: string };

const STEP_KINDS = new Set(["prompt", "annotate", "reconnect"]);
const CHECK_TYPES = new Set(["page_exists", "count", "tool", "tool_absent", "refused_tool_name", "operations", "updated_record", "schema_roundtrip", "approval", "reconnect", "record", "records_exact", "successful_result", "no_error", "browser_text", "prompt", "same_page", "layout_contains", "layout_update", "no_unrecovered_error"]);
const SNAPSHOT_COLLECTIONS = new Set(["pages", "tools", "tool_versions", "assignments", "records", "layouts", "chats", "calls", "results", "approvals", "reconnects", "errors", "browser"]);
const own = (value: object, keys: string[], where: string) => { for (const key of Object.keys(value)) if (!keys.includes(key)) throw new Error(`${where}: unknown key ${key}`); };
const identifier = (value: unknown) => typeof value === "string" && /^[a-z][a-z0-9_-]*$/.test(value);

function validateSetup(value: unknown): TaskSetup | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("setup must be an object");
  own(value, ["tools", "records", "initial_layout"], "setup"); const setup = value as TaskSetup;
  if (!Array.isArray(setup.tools) || !Array.isArray(setup.records)) throw new Error("setup tools and records must be arrays");
  setup.tools.forEach((tool, i) => { own(tool, ["name", "operation", "collection", "input_schema"], `setup.tools[${i}]`); if (!identifier(tool.name) || !["list", "get", "insert", "update"].includes(tool.operation) || !identifier(tool.collection) || (tool.input_schema !== undefined && (!tool.input_schema || typeof tool.input_schema !== "object" || Array.isArray(tool.input_schema)))) throw new Error(`invalid setup.tools[${i}]`); });
  setup.records.forEach((record, i) => { own(record, ["id", "collection", "data"], `setup.records[${i}]`); if (typeof record.id !== "string" || !identifier(record.collection) || !record.data || typeof record.data !== "object" || Array.isArray(record.data)) throw new Error(`invalid setup.records[${i}]`); });
  if (setup.initial_layout !== undefined && (!setup.initial_layout || !Array.isArray(setup.initial_layout.blocks))) throw new Error("invalid setup.initial_layout");
  return setup;
}

function validatePages(value: unknown): PagePlan[] {
  if (!Array.isArray(value) || !value.length) throw new Error("page_plan must not be empty");
  const aliases = new Set<string>();
  return value.map((item, i) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error(`page_plan[${i}] must be an object`);
    own(item, ["alias", "source", "bind_chat", "create_mode", "route"], `page_plan[${i}]`); const page = item as PagePlan;
    if (!identifier(page.alias) || aliases.has(page.alias) || !["fixture", "setup", "created"].includes(page.source) || typeof page.bind_chat !== "boolean" || typeof page.create_mode !== "boolean") throw new Error(`invalid page_plan[${i}]`);
    if (page.route !== undefined && (page.source !== "created" || typeof page.route !== "string" || !page.route.startsWith("/"))) throw new Error(`page_plan[${i}] has invalid route`);
    aliases.add(page.alias); return page;
  });
}

function validateSteps(value: unknown, aliases: Set<string>, taskPrompt?: string): TaskStep[] {
  if (!Array.isArray(value) || !value.length) throw new Error("steps must not be empty");
  const missingPrompts = value.filter(item => item && typeof item === "object" && ["prompt", "annotate"].includes((item as TaskStep).kind) && !(item as TaskStep).prompt).length;
  if ((taskPrompt && missingPrompts !== 1) || (!taskPrompt && missingPrompts > 0)) throw new Error("task needs exactly one prompt source per step");
  return value.map((item, i) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error(`steps[${i}] must be an object`);
    own(item, ["id", "page", "chat", "prompt", "kind"], `steps[${i}]`); const step = item as TaskStep;
    if (!identifier(step.id) || !STEP_KINDS.has(step.kind) || !aliases.has(step.page) || !identifier(step.chat)) throw new Error(`invalid steps[${i}]`);
    const needsPrompt = step.kind === "prompt" || step.kind === "annotate"; const hasPrompt = typeof step.prompt === "string" && step.prompt.length > 0;
    if (!needsPrompt && hasPrompt) throw new Error(`steps[${i}] has invalid prompt source`);
    return step;
  });
}

function validateCheckShape(check: TaskCheck, i: number) {
  if (typeof check.page !== "string") throw new Error(`checks[${i}] needs page`);
  if (check.type === "count" && (!identifier(check.name) || !SNAPSHOT_COLLECTIONS.has(check.name!) || !Number.isInteger(check.count))) throw new Error(`checks[${i}] needs a known collection and count`);
  if (["tool", "tool_absent", "refused_tool_name"].includes(check.type) && !identifier(check.name)) throw new Error(`checks[${i}] needs tool name`);
  if (check.type === "operations" && (!Array.isArray(check.value) || !(check.value as unknown[]).length || !(check.value as unknown[]).every(value => ["insert", "update", "list", "get"].includes(String(value))))) throw new Error(`checks[${i}] needs operation kinds`);
  if (check.type === "approval" && (typeof check.tool !== "string" || !Number.isInteger(check.count))) throw new Error(`checks[${i}] needs tool and count`);
  if (check.type === "successful_result" && typeof check.tool !== "string") throw new Error(`checks[${i}] needs tool`);
  if (["record", "records_exact", "updated_record", "schema_roundtrip", "layout_contains", "layout_update"].includes(check.type) && check.value === undefined) throw new Error(`checks[${i}] needs value`);
  if (check.type === "records_exact" && !Array.isArray(check.value)) throw new Error(`checks[${i}] needs a record array`);
  if (check.type === "schema_roundtrip" && (!Array.isArray(check.value) || !(check.value as unknown[]).length || !(check.value as unknown[]).every(value => typeof value === "string"))) throw new Error(`checks[${i}] needs string values`);
  if (check.type === "updated_record") {
    if (typeof check.chat !== "string" || typeof check.value !== "string" || !check.transition) throw new Error(`checks[${i}] needs chat, identity value, and transition`);
    own(check.transition, ["before", "after"], `checks[${i}].transition`);
    if ([check.transition.before, check.transition.after].some(values => !Array.isArray(values) || !values.length || !values.every(value => typeof value === "string"))) throw new Error(`checks[${i}] transition sets need string values`);
  }
  if (["browser_text", "prompt"].includes(check.type) && typeof check.text !== "string") throw new Error(`checks[${i}] needs text`);
  if (check.type === "page_exists" && check.route !== undefined && !check.route.startsWith("/")) throw new Error(`checks[${i}] has invalid route`);
}

function validateChecks(value: unknown, aliases: Set<string>): TaskCheck[] {
  if (!Array.isArray(value) || !value.length) throw new Error("checks must not be empty");
  return value.map((item, i) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error(`checks[${i}] must be an object`);
    own(item, ["id", "type", "required", "page", "chat", "name", "value", "transition", "count", "text", "tool", "route"], `checks[${i}]`); const check = item as TaskCheck;
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
const SCHEMA_RELATIVE_CHECKS = new Set<TaskCheck["type"]>(["operations", "updated_record", "schema_roundtrip"]);
function nestedTokens(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(nestedTokens);
  if (value && typeof value === "object") return Object.entries(value as Record<string, unknown>).flatMap(([key, nested]) => [key, ...nestedTokens(nested)]);
  return typeof value === "string" ? [value] : [];
}
export function expectationTokens(check: TaskCheck): string[] {
  if (SCHEMA_RELATIVE_CHECKS.has(check.type)) return [];
  return [...new Set(Object.entries(check).filter(([key]) => EXPECTATION_TOKEN_KEYS.has(key)).flatMap(([, value]) => nestedTokens(value)).map(token => token.replace(/^achilles__/, "")))];
}
function validateExpectations(checks: TaskCheck[], promptText: string, setup?: TaskSetup) {
  const declared = new Set<string>();
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
  for (const check of checks) for (const token of expectationTokens(check)) {
    // Count names select a closed snapshot collection; layout checks use a fixed document envelope.
    const structural = ["layout_contains", "layout_update"].includes(check.type) && LAYOUT_STRUCTURAL_TOKENS.has(token);
    if (check.type !== "count" && !structural && !promptText.includes(token) && !declared.has(token)) throw new Error(`check ${check.id} expects ${JSON.stringify(token)} without a prompt quote or declared schema`);
  }
}

export function validateTask(value: unknown): EvalTask {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("task must be an object");
  own(value, ["id", "prompt", "page_plan", "agent_turns", "steps", "checks", "setup", "approval_mode", "requires", "goal_capabilities"], "task"); const task = value as Record<string, unknown>;
  if (typeof task.id !== "string" || !/^[a-z0-9-]+$/.test(task.id)) throw new Error("task.id must be kebab-case");
  if (task.prompt !== undefined && typeof task.prompt !== "string") throw new Error("task.prompt must be a string");
  if (!Number.isInteger(task.agent_turns) || (task.agent_turns as number) < 1 || (task.agent_turns as number) > 20) throw new Error("agent_turns must be 1..20");
  if (task.approval_mode !== undefined && !["allow", "ask"].includes(String(task.approval_mode))) throw new Error("approval_mode must be allow or ask");
  if (task.requires !== undefined && (!Array.isArray(task.requires) || !task.requires.length || !task.requires.every(identifier) || new Set(task.requires).size !== task.requires.length)) throw new Error("requires must name unique capabilities");
  if (task.goal_capabilities !== undefined && (!Array.isArray(task.goal_capabilities) || !task.goal_capabilities.length || !task.goal_capabilities.every(identifier) || new Set(task.goal_capabilities).size !== task.goal_capabilities.length)) throw new Error("goal_capabilities must name unique capabilities");
  const page_plan = validatePages(task.page_plan); const aliases = new Set(page_plan.map(page => page.alias));
  const prompt = task.prompt as string | undefined;
  const setup = validateSetup(task.setup); const steps = validateSteps(task.steps, aliases, prompt); const checks = validateChecks(task.checks, aliases);
  validateExpectations(checks, [prompt, ...steps.flatMap(step => step.prompt ?? [])].join(" "), setup);
  return { id: task.id, prompt, page_plan, agent_turns: task.agent_turns as number, goal_capabilities: task.goal_capabilities as string[] | undefined, approval_mode: task.approval_mode as EvalTask["approval_mode"], requires: task.requires as string[] | undefined, setup, steps, checks };
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
function matchingSchemaObjects(actual: unknown, version: Record<string, unknown>, values: string[], inheritedRecordId?: string): Array<Record<string, unknown>> {
  if (!actual || typeof actual !== "object") return [];
  if (Array.isArray(actual)) return actual.flatMap(value => matchingSchemaObjects(value, version, values, inheritedRecordId));
  const object = actual as Record<string, unknown>; const recordId = typeof object.record_id === "string" ? object.record_id : inheritedRecordId; const fields = schemaStringFields(version);
  const match = values.every(value => [...fields].some(field => object[field] === value)); const found = match ? [{ ...object, ...(recordId && !("record_id" in object) ? { record_id: recordId } : {}) }] : [];
  return [...found, ...Object.values(object).flatMap(value => matchingSchemaObjects(value, version, values, recordId))];
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
type TransitionFailure = { reason: string; field: string; before: unknown; after: unknown };
const normalizeTransitionValue = (value: string) => value.toLowerCase().replace(/[\s_-]+/g, "");
const transitionFailure = (reason: string, field: string, before: unknown, after: unknown): TransitionFailure => ({ reason, field, before, after });
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
      const matches = (actual: unknown) => matchingSchemaObjects(actual, version, values).length > 0 || matchingSchemaObjects(actual, version, [values[0]]).some(row => [...schemaStringFields(version)].some(field => typeof row[field] === "string"));
      return records.some(record => record.collection === version.collection && matches(record.data ?? record)) && results.some(result => result.tool === `achilles__${version.name}` && matches(result.data ?? result.result));
    });
  },
  approval: ({ check, owned }) => owned("approvals").filter(row => row.tool === check.tool).length,
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
    const attempts = rows(snapshot, "results").filter(row => row.page_id === page && (!check.chat || row.chat_id === check.chat) && row.tool === "achilles__update_layout");
    return attempts.length === 0 || (attempts.at(-1)?.success === true && attempts.every((attempt, index) => attempt.success !== false || attempts.slice(index + 1).some(later => later.success === true)));
  },
  browser_text: ({ check, owned }) => owned("browser").some(row => String(row.text ?? "").includes(String(check.text))),
  prompt: ({ check, owned }) => owned("chats").some(row => row.prompt === check.text || row.first_prompt === check.text),
  same_page: ({ snapshot, page }) => (snapshot.related_page_ids?.length ?? 0) > 0 && snapshot.related_page_ids!.every(id => id === page),
  layout_contains: ({ check, owned }) => owned("layouts").some(row => structurallyContains(row.document, check.value)),
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
  const expected = check.value ?? check.count ?? check.text ?? true; const page = expectedPageId(snapshot, check.page); const owned = (type: keyof EvalSnapshot) => rows(snapshot, type).filter(row => row.page_id === page || row.pageId === page);
  const result = CHECK_GRADERS[check.type]({ check, snapshot, page, owned });
  const failure = result && typeof result === "object" && "reason" in result ? result as TransitionFailure : undefined;
  const pass = failure ? false : ["count", "approval"].includes(check.type) ? result === expected : Boolean(result);
  return { id: check.id, pass, expected, actual: failure ? false : result, evidence: { type: check.type, page, ...(failure ? { transition: { field: failure.field, before: failure.before, after: failure.after } } : {}) }, ...(failure ? { reason: failure.reason } : {}) };
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

export function gradeReference(task: EvalTask, snapshot: EvalSnapshot) {
  const result = gradeTask(task, snapshot);
  const staticFailure = rows(snapshot, "browser").some(row => /static file not found/i.test(String(row.text ?? "")));
  return { ...result, status: staticFailure ? "harness_error" as const : result.pass ? "pass" as const : "agent_fail" as const };
}
