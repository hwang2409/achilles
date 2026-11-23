import type { ZetaClient } from "@fulcrum/zeta";
import { createWriteForms } from "../writeForms";
import { supportsRequest } from "../zeta";
import { createMcpReads, projectMcpSnapshot, type McpRow } from "./mcpReads";

export const mcpMethods = { enabled: "mcp_server_set_enabled", trusted: "mcp_server_set_trusted", remove: "mcp_server_remove" } as const;
export type McpAction = keyof typeof mcpMethods;
export type McpAttempt = Readonly<{ revision: string; scope: McpRow["scope"]; name: string } & (
  { action: "enabled" | "trusted"; value: boolean } | { action: "remove" }
)>;
type Restart = { sessions: string[]; complete: boolean };
export type McpOutcome =
  | { status: "committed"; restart: Restart | null }
  | { status: "stale" | "busy" | "unavailable" | "invalid" | "refused" | "unsupported" | "conflict" | "changed" | "cancelled" | "unknown" };
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

function matches(attempt: McpAttempt, rows: readonly McpRow[]) {
  const row = rows.find(({ name }) => name === attempt.name);
  return attempt.action === "remove" ? !row : row?.[attempt.action] === attempt.value;
}

/** One global flight: the revision spans user, project, and trust. A new socket is only used to read, never to retry a write. */
export function createMcpOwner({ live, acquire, release, supports = supportsRequest, canRead, wait = waitFor }: {
  live: () => ZetaClient | null;
  acquire: () => Promise<ZetaClient | null>;
  release: () => Promise<void>;
  supports?: typeof supportsRequest;
  canRead?: (client: ZetaClient) => boolean;
  wait?: typeof waitFor;
}) {
  const reads = createMcpReads(canRead);
  const { run, ...forms } = createWriteForms<McpOutcome, McpAttempt>({ inProgress: { status: "conflict" }, unexpected: UNKNOWN });
  const outcomes = new WeakMap<McpAttempt, McpOutcome>();
  const refresh = (signal?: AbortSignal) => {
    const client = live();
    return client && !signal?.aborted ? reads.refresh(client, signal) : null;
  };
  async function settle(attempt: McpAttempt, signal: AbortSignal): Promise<McpOutcome> {
    const view = await refresh(signal);
    const concrete = view?.[attempt.scope];
    if (signal.aborted || !concrete || !("rows" in concrete)) return UNKNOWN;
    if (matches(attempt, concrete.rows)) return { status: "committed", restart: null };
    return concrete.revision === attempt.revision ? UNKNOWN : { status: "changed" };
  }
  async function send(client: ZetaClient, attempt: McpAttempt, signal: AbortSignal): Promise<McpOutcome> {
    const { action, name, scope, revision } = attempt;
    if (action === "trusted" && scope !== "project") return { status: "invalid" };
    const method = mcpMethods[action];
    if (!supports(client, method)) return { status: "unsupported" };
    const mutation = action === "trusted" ? { name, trusted: attempt.value }
      : action === "enabled" ? { name, scope, enabled: attempt.value } : { name, scope };
    for (let retry = 0; ; retry++) {
      if (signal.aborted) return CANCELLED;
      if (live() !== client) return { status: "refused" };
      let result: unknown;
      try {
        // Do not abort a sent write: closing the review does not undo it.
        result = await client.request(method, { revision, mutation }, { timeoutMs: 5_000 });
      } catch (error) {
        const failure = rpcFailure(error);
        if (!failure) return UNKNOWN;
        if (failure.status !== "busy" || retry === BACKOFF.length) return failure;
        if (signal.aborted) return CANCELLED;
        await wait(BACKOFF[retry]!, signal);
        continue;
      }
      const next = projectMcpSnapshot(result, scope);
      const restart = projectRestart(result);
      if (!next || !restart || !matches(attempt, next.rows)) return UNKNOWN;
      reads.apply(scope, next);
      return { status: "committed", restart };
    }
  }
  async function execute(attempt: McpAttempt, signal: AbortSignal): Promise<McpOutcome> {
    let client: ZetaClient | null = null;
    let outcome: McpOutcome = { status: "refused" };
    try {
      client = await acquire();
      if (client) outcome = signal.aborted ? CANCELLED : await send(client, attempt, signal);
    } finally {
      if (client) await release().catch(() => {});
    }
    if (outcome.status === "unknown") outcome = await settle(attempt, signal);
    else if (["committed", "stale", "unavailable"].includes(outcome.status)) await refresh(signal);
    return outcome;
  }
  const submit = (form: string, attempt: McpAttempt, check: boolean) => run(form, "mcp", JSON.stringify(attempt), attempt, async (signal) => {
    const prior = outcomes.get(attempt);
    const outcome = check ? prior?.status === "unknown" ? await settle(attempt, signal) : prior ?? UNKNOWN
      : prior ?? await execute(attempt, signal);
    outcomes.set(attempt, outcome);
    return outcome;
  });
  return { reads, ...forms, execute: (form: string, attempt: McpAttempt) => submit(form, attempt, false),
    check: (form: string, attempt: McpAttempt) => submit(form, attempt, true) };
}

export type McpOwner = ReturnType<typeof createMcpOwner>;
