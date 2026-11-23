import type { ZetaClient } from "@fulcrum/zeta";
import { createWriteForms } from "../writeForms";
import { supportsRequest } from "../zeta";
import { createMcpAuth, type AuthAttempt, type AuthOutcome } from "./mcpAuth";
import { createMcpReads, projectMcpSnapshot, readMcpScope, type McpRow } from "./mcpReads";

export const mcpMethods = { add: "mcp_server_add", enabled: "mcp_server_set_enabled", trusted: "mcp_server_set_trusted", remove: "mcp_server_remove" } as const;
export type McpAction = keyof typeof mcpMethods;
export type McpAttempt = Readonly<{ revision: string; scope: McpRow["scope"]; name: string } & (
  { action: "enabled" | "trusted"; value: boolean } | { action: "remove" }
)>;
export type McpAddMutation = { scope: McpRow["scope"]; name: string; enabled: boolean; env: Record<string, string> } & (
  { command: string; args: string[] } | { url: string; headers: Record<string, string>; oauth: boolean; client_id?: string; client_secret?: string }
);
export type McpAddAttempt = Readonly<{ action: "add"; revision: string; scope: McpRow["scope"]; name: string; existed: boolean;
  enabled: boolean; config: McpRow["config"] }>;
type Attempt = McpAttempt | McpAddAttempt;
type TakeMutation = () => McpAddMutation | null;

export function projectAdd(mutation: McpAddMutation): McpRow["config"] {
  const env = Object.keys(mutation.env).length;
  return "command" in mutation
    ? { transport: "stdio", commandProvided: true, urlProvided: false, args: mutation.args.length, env, headers: 0, oauth: null }
    : { transport: "streamable-http", commandProvided: false, urlProvided: true, args: 0, env, headers: Object.keys(mutation.headers).length,
      oauth: mutation.oauth ? { secretProvided: Boolean(mutation.client_secret) } : null };
}

type Restart = { sessions: string[]; complete: boolean };
export type McpOutcome =
  | { status: "committed"; restart: Restart | null }
  | { status: "stale" | "busy" | "unavailable" | "invalid" | "refused" | "unsupported" | "conflict" | "changed" | "cancelled" | "unknown" };
export const mcpTestMethod = "mcp_server_test";
export type ReviewedMcpTarget = Pick<McpRow, "name" | "scope" | "trusted" | "config"> & { revision: string };
export type McpTestResult = { status: "ok" | "failed" | "untrusted" | "skipped-policy"; toolCount: number };
type TestAttempt = { action: "test"; target: ReviewedMcpTarget };
type TestReply = { status: "tested"; result: McpTestResult };
export type McpTestOutcome = TestReply | McpOutcome;

export function needsMcpTestTrust({ scope, config, trusted }: ReviewedMcpTarget) {
  return scope === "project" && config.transport === "stdio" && !trusted;
}

function projectTest(value: unknown): TestReply | null {
  const data = (value as { data?: { status?: unknown; tool_count?: unknown } } | null)?.data;
  const status = data?.status;
  const toolCount = data?.tool_count;
  if (status !== "ok" && status !== "failed" && status !== "untrusted" && status !== "skipped-policy") return null;
  if (typeof toolCount !== "number" || !Number.isSafeInteger(toolCount) || toolCount < 0) return null;
  return { status: "tested", result: { status, toolCount } };
}

const TEST_FAILED = { status: "tested", result: { status: "failed", toolCount: 0 } } as const;
const UNKNOWN = { status: "unknown" } as const;
const CANCELLED = { status: "cancelled" } as const;
const BACKOFF = [500, 1_000, 2_000];
const waitFor = (ms: number, signal: AbortSignal) => new Promise<void>((resolve) => {
  const finish = () => { clearTimeout(timer); signal.removeEventListener("abort", finish); resolve(); };
  const timer = setTimeout(finish, ms);
  if (signal.aborted) finish(); else signal.addEventListener("abort", finish, { once: true });
});

function rpcFailure(error: unknown): McpOutcome | null {
  const rpc = error as { code?: unknown; data?: { reason?: unknown } } | null;
  switch (rpc?.code) {
    case -32009: return rpc.data?.reason === "stale_mcp_revision" ? { status: "stale" } : null;
    case -32004: return { status: "busy" };
    case -32005: return { status: "unavailable" };
    case -32602: return { status: "invalid" };
    case -32008: return { status: "refused" };
    case -32601: return { status: "unsupported" };
    default: return null;
  }
}

function projectRestart(value: unknown): Restart | null {
  const restart = (value as { restart?: { serve?: unknown; sessions?: unknown; complete?: unknown } } | null)?.restart;
  if (restart?.serve !== false || typeof restart.complete !== "boolean" || !Array.isArray(restart.sessions)
    || !restart.sessions.every((id) => typeof id === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(id))) return null;
  return { sessions: [...restart.sessions], complete: restart.complete };
}

function matches(attempt: Attempt, rows: readonly McpRow[]) {
  const row = rows.find(({ name }) => name === attempt.name);
  if (attempt.action === "add") return !attempt.existed && row?.enabled === attempt.enabled
    && sameConfig(row.config, attempt.config);
  return attempt.action === "remove" ? !row : row?.[attempt.action] === attempt.value;
}

function sameConfig(row: McpRow["config"], expected: McpRow["config"]) {
  return row.transport === expected.transport && row.commandProvided === expected.commandProvided && row.urlProvided === expected.urlProvided
    && row.args === expected.args && row.env === expected.env && row.headers === expected.headers
    && row.oauth?.secretProvided === expected.oauth?.secretProvided;
}

function matchesDraft(attempt: McpAddAttempt, mutation: McpAddMutation) {
  return mutation.name === attempt.name && mutation.scope === attempt.scope && mutation.enabled === attempt.enabled
    && sameConfig(projectAdd(mutation), attempt.config);
}

function mutationFor(attempt: Attempt, take?: TakeMutation) {
  const { action, scope, name } = attempt;
  if (action === "add") {
    const draft = take?.();
    return draft && matchesDraft(attempt, draft) ? draft : null;
  }
  if (action === "trusted") return { name, trusted: attempt.value };
  if (action === "enabled") return { name, scope, enabled: attempt.value };
  return { name, scope };
}

async function requestWrite(client: ZetaClient, method: typeof mcpMethods[McpAction], revision: string,
  mutation: Record<string, unknown>): Promise<McpOutcome | { result: unknown }> {
  try {
    // Do not abort a sent write: closing the review does not undo it.
    return { result: await client.request(method, { revision, mutation }, { timeoutMs: 5_000 }) };
  } catch (error) {
    const failure = rpcFailure(error);
    if (method === mcpMethods.add && failure?.status === "busy"
      && (error as { data?: { reason?: unknown } }).data?.reason !== "operation_busy") return UNKNOWN;
    return failure ?? UNKNOWN;
  }
}

/** One global flight: the revision spans user, project, and trust. A new socket is only used to read, never to retry a write. */
export function createMcpOwner({ live, acquire, release, supports = supportsRequest, canRead, wait = waitFor, liveObserver = live }: {
  live: () => ZetaClient | null;
  liveObserver?: () => ZetaClient | null;
  acquire: () => Promise<ZetaClient | null>;
  release: () => Promise<void>;
  supports?: typeof supportsRequest;
  canRead?: (client: ZetaClient) => boolean;
  wait?: typeof waitFor;
}) {
  const reads = createMcpReads(canRead);
  const { run, ...forms } = createWriteForms<McpTestOutcome | AuthOutcome, Attempt | TestAttempt | AuthAttempt>({ inProgress: { status: "conflict" }, unexpected: UNKNOWN });
  const outcomes = new WeakMap<Attempt, McpOutcome>();
  const refresh = (signal?: AbortSignal) => {
    const client = live();
    return client && !signal?.aborted ? reads.refresh(client, signal) : null;
  };
  async function settle(attempt: Attempt, signal: AbortSignal): Promise<McpOutcome> {
    const view = await refresh(signal);
    const concrete = view?.[attempt.scope];
    if (signal.aborted || !concrete || !("rows" in concrete)) return UNKNOWN;
    if ((attempt.action !== "add" || concrete.revision !== attempt.revision) && matches(attempt, concrete.rows)) return { status: "committed", restart: null };
    return concrete.revision === attempt.revision ? UNKNOWN : { status: "changed" };
  }
  async function send(client: ZetaClient, attempt: Attempt, signal: AbortSignal, take?: TakeMutation): Promise<McpOutcome> {
    const { action, scope, revision } = attempt;
    if (action === "trusted" && scope !== "project") return { status: "invalid" };
    const method = mcpMethods[action];
    if (!supports(client, method)) return { status: "unsupported" };
    const mutation = mutationFor(attempt, take);
    if (!mutation) return { status: "invalid" };
    const response = await write(client, method, revision, mutation, signal);
    if ("status" in response) return response;
    const next = projectMcpSnapshot(response.result, scope);
    const restart = projectRestart(response.result);
    if (!next || !restart || !matches(attempt, next.rows)) return UNKNOWN;
    reads.apply(scope, next);
    return { status: "committed", restart };
  }
  async function write(client: ZetaClient, method: typeof mcpMethods[McpAction], revision: string,
    mutation: Record<string, unknown>, signal: AbortSignal): Promise<McpOutcome | { result: unknown }> {
    for (let retry = 0; ; retry++) {
      if (signal.aborted) return CANCELLED;
      if (live() !== client) return { status: "refused" };
      const response = await requestWrite(client, method, revision, mutation);
      if (!("status" in response) || response.status !== "busy" || retry === BACKOFF.length) return response;
      if (signal.aborted) return CANCELLED;
      await wait(BACKOFF[retry]!, signal);
    }
  }
  async function withAcquiredControl<T>(signal: AbortSignal, perform: (client: ZetaClient) => Promise<T>): Promise<T | McpOutcome> {
    const client = await acquire();
    if (!client) return { status: "refused" };
    try { return signal.aborted ? CANCELLED : await perform(client); }
    finally { await release().catch(() => {}); }
  }
  async function confirmCurrent(client: ZetaClient, target: ReviewedMcpTarget, signal: AbortSignal): Promise<McpOutcome | null> {
    if (live() !== client) return { status: "refused" };
    const current = await readMcpScope(client, target.scope, signal);
    if (signal.aborted) return CANCELLED;
    if (live() !== client || !("rows" in current)) return { status: "unavailable" };
    const row = current.rows.find(({ name }) => name === target.name);
    if (current.revision !== target.revision || !row || row.trusted !== target.trusted || !sameConfig(row.config, target.config)) return { status: "stale" };
    // These RPCs do not accept revisions. This check narrows but cannot close the gap.
    return null;
  }
  const auth = createMcpAuth({ supports, failure: rpcFailure, liveObserver,
    withControl: (signal, send, attempt) => withAcquiredControl(signal, async (client) => {
      const failure = attempt.action === "cancel" ? null : await confirmCurrent(client, attempt, signal);
      return failure ?? send(client);
    }),
  });
  async function confirmTest(client: ZetaClient, target: ReviewedMcpTarget, signal: AbortSignal): Promise<McpTestOutcome> {
    if (live() !== client) return { status: "refused" };
    if (!supports(client, mcpTestMethod)) return { status: "unsupported" };
    const failure = await confirmCurrent(client, target, signal);
    return failure ?? sendTest(client, target, signal);
  }
  async function sendTest(client: ZetaClient, { name, scope }: ReviewedMcpTarget, signal: AbortSignal): Promise<McpTestOutcome> {
    try {
      // Abort only stops waiting locally. Zeta owns initialize/list and transport cleanup.
      const result = await client.request(mcpTestMethod, { name, scope }, { signal });
      return live() === client ? projectTest(result) ?? UNKNOWN : UNKNOWN;
    } catch (error) {
      if (live() !== client) return UNKNOWN;
      // Zeta returns its closed internal-error code when the transport fails before a receipt.
      if ((error as { code?: unknown } | null)?.code === -32000) return TEST_FAILED;
      return rpcFailure(error) ?? UNKNOWN;
    }
  }
  const test = (form: string, target: ReviewedMcpTarget) => run(form, "mcp", JSON.stringify(target), { action: "test", target }, async (signal) => {
    if (needsMcpTestTrust(target)) return { status: "tested", result: { status: "untrusted", toolCount: 0 } };
    const outcome = await withAcquiredControl(signal, (client) => confirmTest(client, target, signal));
    if (outcome.status === "stale") await refresh(signal);
    return outcome;
  });
  async function execute(attempt: Attempt, signal: AbortSignal, take?: TakeMutation): Promise<McpOutcome> {
    let outcome = await withAcquiredControl(signal, (client) => send(client, attempt, signal, take));
    if (outcome.status === "unknown") outcome = await settle(attempt, signal);
    else if (["committed", "stale", "unavailable"].includes(outcome.status)) await refresh(signal);
    return outcome;
  }
  const submit = (form: string, attempt: Attempt, check: boolean, take?: TakeMutation) => run(form, "mcp", JSON.stringify(attempt), attempt, async (signal) => {
    const prior = outcomes.get(attempt);
    const outcome = check ? prior?.status === "unknown" ? await settle(attempt, signal) : prior ?? UNKNOWN
      : prior ?? await execute(attempt, signal, take);
    outcomes.set(attempt, outcome);
    return outcome;
  });
  return { reads, ...forms, test, auth,
    authAction: (form: string, attempt: AuthAttempt, check: boolean, deliver: (value: AuthOutcome) => void) => {
      forms.attach(form, (outcome) => { if (outcome.status !== "tested") deliver(outcome); });
      return run(form, "mcp", JSON.stringify(attempt), attempt, async (signal) => {
        const outcome = await auth.run(attempt, check, signal);
        if (outcome.status === "stale") await refresh(signal);
        return outcome;
      });
    },
    attach: (form: string, deliver: (outcome: McpOutcome) => void) => forms.attach(form, (outcome) => {
      if (outcome.status !== "tested" && outcome.status !== "auth" && outcome.status !== "popup-blocked") deliver(outcome);
    }),
    attachTest: (form: string, deliver: (outcome: McpTestOutcome) => void) => forms.attach(form, (outcome) => {
      if (outcome.status !== "auth" && outcome.status !== "popup-blocked") deliver(outcome);
    }),
    execute: (form: string, attempt: McpAttempt) => submit(form, attempt, false),
    add: (form: string, attempt: McpAddAttempt, take: TakeMutation) => submit(form, attempt, false, take),
    check: (form: string, attempt: Attempt) => submit(form, attempt, true) };
}

export type McpOwner = ReturnType<typeof createMcpOwner>;
