import type { ZetaClient } from "@fulcrum/zeta";
import { observerRefused, supportsFeature, supportsRequest } from "../zeta";

const METHOD = "mcp_server_list";
const REDACTED = "<redacted>";
const CONCRETE = ["user", "project"] as const;
export const mcpScopes = ["effective", ...CONCRETE] as const;
export type McpScope = typeof mcpScopes[number];
const STATUSES = ["configured", "disabled", "pending trust", "skipped-missing-env", "malformed"] as const;
const TRANSPORTS = ["stdio", "streamable-http"] as const;
const AUTH = ["none", "unauthorized"] as const;

const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const oneOf = <T extends string>(values: readonly T[], value: unknown): value is T => values.some((item) => item === value);

function countRedacted(value: unknown, list: boolean) {
  if (value === undefined) return 0;
  const fields = list ? (Array.isArray(value) ? value : null) : record(value);
  if (!fields) return null;
  const entries = Object.values(fields);
  return entries.every((entry) => entry === REDACTED) ? entries.length : null;
}

function projectConfig(value: unknown, malformed: boolean) {
  const config = record(value);
  if (!config) return null;
  const { transport, command, url, auth } = config;
  if (!oneOf(TRANSPORTS, transport) && !(transport === undefined && malformed)) return null;
  if (command !== undefined && command !== REDACTED) return null;
  if (url !== undefined && url !== "<redacted-url>") return null;
  const args = countRedacted(config.args, true);
  const env = countRedacted(config.env, false);
  const headers = countRedacted(config.headers, false);
  if (args === null || env === null || headers === null) return null;
  const oauth = record(auth);
  if (auth !== undefined && (oauth?.type !== "oauth" || (oauth.client_secret !== undefined && oauth.client_secret !== REDACTED))) return null;
  return {
    transport: transport ?? null,
    commandProvided: command === REDACTED, urlProvided: url === "<redacted-url>",
    args, env, headers,
    oauth: oauth ? { secretProvided: oauth.client_secret === REDACTED } : null,
  };
}

// Names are protocol identities. Reject non-displayable or non-round-tripping path segments.
export const isMcpName = (name: unknown): name is string => typeof name === "string" && !!name.trim()
  && [...name].length <= 256 && name !== "." && name !== ".." && !/[\p{Cc}\p{Cf}\p{Cs}]/u.test(name);

function projectRow(value: unknown) {
  const row = record(value);
  if (!row) return null;
  const { name, scope, enabled, trusted, status, auth, tool_count: toolCount } = row;
  if (!isMcpName(name)) return null;
  if (!oneOf(CONCRETE, scope) || typeof enabled !== "boolean" || typeof trusted !== "boolean" || !oneOf(STATUSES, status) || !oneOf(AUTH, auth)) return null;
  if (typeof toolCount !== "number" || !Number.isSafeInteger(toolCount) || toolCount < 0) return null;
  const config = projectConfig(row.config, status === "malformed");
  if (!config) return null;
  return { name, scope, enabled, trusted, status, auth, toolCount, config };
}

export type McpRow = NonNullable<ReturnType<typeof projectRow>>;

// Ignore additive fields; never keep the wire document or silently drop an unreadable row.
export function projectMcpSnapshot(value: unknown, scope: McpScope) {
  const list = record(value);
  if (typeof list?.revision !== "string" || !/^[a-f0-9]{64}$/.test(list.revision)) return null;
  const items = record(list.data)?.items;
  if (!Array.isArray(items)) return null;
  const rows: McpRow[] = [];
  const names = new Set<string>();
  for (const item of items) {
    const row = projectRow(item);
    if (!row || (scope !== "effective" && row.scope !== scope) || names.has(row.name)) return null;
    names.add(row.name);
    rows.push(row);
  }
  return { rows, revision: list.revision };
}

export function projectMcpList(value: unknown, scope: McpScope) {
  return projectMcpSnapshot(value, scope)?.rows ?? null;
}

export function mcpReadFailure(error: unknown, client?: ZetaClient) {
  const code = record(error)?.code;
  if (observerRefused(client, error)) return { method: METHOD, code, reason: "observer" } as const;
  if (code === -32005) return { method: METHOD, code, reason: "state_unavailable" } as const;
  if (code === -32004) return { method: METHOD, code, reason: "operation_busy" } as const;
  if (code === -32601) return { method: METHOD, code, reason: "method_unavailable" } as const;
  return { method: METHOD, reason: "read_failed" } as const;
}

type Failure = ReturnType<typeof mcpReadFailure> | { method: typeof METHOD; reason: "invalid_response" };
type ScopeRead = { rows: McpRow[]; revision: string; at: number } | { failure: Failure };
export const canReadMcp = (client: ZetaClient) => supportsFeature(client, "mcp_management_v1") && supportsRequest(client, METHOD);

export async function readMcpScope(client: ZetaClient, scope: McpScope, signal?: AbortSignal): Promise<ScopeRead> {
  try {
    const result = projectMcpSnapshot(await client.request(METHOD, { scope }, { signal, timeoutMs: 5_000 }), scope);
    return result ? { ...result, at: Date.now() } : { failure: { method: METHOD, reason: "invalid_response" } };
  } catch (error: unknown) {
    return { failure: mcpReadFailure(error, client) };
  }
}

export function createMcpReads(canRead = canReadMcp) {
  let snapshot: Record<McpScope, ScopeRead> | null = null;
  const listeners = new Set<() => void>();
  let generation = 0;
  const publish = () => listeners.forEach((listener) => listener());
  return {
    snapshot: () => snapshot,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    apply(scope: McpRow["scope"], result: NonNullable<ReturnType<typeof projectMcpSnapshot>>) {
      generation++;
      if (!snapshot) return;
      snapshot = { ...snapshot, [scope]: { ...result, at: Date.now() } };
      publish();
    },
    async refresh(client: ZetaClient, signal?: AbortSignal) {
      const current = ++generation;
      if (!canRead(client)) {
        snapshot = null;
      } else {
        const [effective, user, project] = await Promise.all(mcpScopes.map((scope) => readMcpScope(client, scope, signal)));
        if (signal?.aborted || current !== generation) return null;
        snapshot = { effective, user, project };
      }
      publish();
      return snapshot;
    },
  };
}

export type McpReads = ReturnType<typeof createMcpReads>;
