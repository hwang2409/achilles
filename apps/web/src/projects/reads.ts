import type { ZetaClient } from "@fulcrum/zeta";
import { supportsFeature } from "../zeta";

// The one owner of the project read calls and their projections. Every result is outside input: keep only the listed
// fields, and treat any malformed row as an unreadable page. Bodies are never cached here.

export const STATE_FEATURE = "state_read_v1";
const PAGE = 50;

export type ProjectRow = { id: string; name: string; path: string | null; sessions: number; memory: number; inbox: { new: number; claimed: number; done: number } };
export const memoryKinds = ["brief", "decision", "state", "backlog", "changelog", "legacy"] as const;
export type MemoryKind = typeof memoryKinds[number];
export type MemoryRow = { id: string; kind: MemoryKind; automatic: boolean; accepted: boolean | null; summary: string; sourceSession: string | null };
const inboxStatuses = ["new", "claimed", "done"] as const;
const inboxKinds = ["bug_report", "change_request", "question", "info", "reply"] as const;
export type InboxRow = { id: string; kind: typeof inboxKinds[number]; status: typeof inboxStatuses[number]; sender: string; summary: string; createdNs: number; trusted: boolean; hasBody: boolean };
export type Page<T> = { rows: T[]; nextCursor: string | null };
// `oldFormat`: a format 1 project. zeta lists its five memory files by file name; achilles shows only format 2 text.
export type MemoryPage = Page<MemoryRow> & { oldFormat: boolean };
// `digest` is the memory revision a later edit compares against.
export type KindText = { text: string; truncated: boolean; digest: string };
export type Body = { text: string; truncated: boolean };

/** Thrown when zeta answers with a shape this view cannot read. */
export class Unreadable extends Error {}

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const count = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
// nanosecond clocks pass 2^53, so a time is any non-negative number; it is only shown, never compared exactly.
const time = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
const text = (value: unknown): value is string => typeof value === "string";
const oneOf = <T extends string>(values: readonly T[], value: unknown) => values.find((item) => item === value);
const formatOneFiles = new Set(["brief.md", "state.md", "backlog.md", "changelog.md", "decisions.md"]);
// state_memory names format 2 decisions `decision`; project_show keys them by the schema kind `decisions`.
const showKey = (kind: MemoryKind) => kind === "decision" ? "decisions" : kind;

export const projectReads = (client: ZetaClient) => supportsFeature(client, STATE_FEATURE);
/** `legacy` rows are whole documents with no kind of their own in `project_show`, so they have no kind text. */
export const hasKindText = (kind: MemoryKind) => kind !== "legacy";

function page<T>(result: unknown, row: (item: Record<string, unknown>) => T | undefined): Page<T> | null {
  if (!record(result) || !Array.isArray(result.items) || !(result.next_cursor === null || text(result.next_cursor))) return null;
  const rows: T[] = [];
  for (const item of result.items) {
    const parsed = record(item) ? row(item) : undefined;
    if (!parsed) return null;
    rows.push(parsed);
  }
  return { rows, nextCursor: result.next_cursor };
}

export function projectProjects(result: unknown): Page<ProjectRow> | null {
  return page(result, ({ project_id, name, path, session_count, memory_count, inbox }) => {
    if (!text(project_id) || !text(name) || !(path === null || text(path)) || !count(session_count) || !count(memory_count) ||
        !record(inbox) || !count(inbox.new) || !count(inbox.claimed) || !count(inbox.done)) return undefined;
    return { id: project_id, name, path, sessions: session_count, memory: memory_count, inbox: { new: inbox.new, claimed: inbox.claimed, done: inbox.done } };
  });
}

export function projectMemory(result: unknown): MemoryPage | null {
  const parsed = page(result, ({ memory_id, kind, automatic, accepted, summary, source_session_id }) => {
    const known = oneOf(memoryKinds, kind);
    if (!text(memory_id) || !known || typeof automatic !== "boolean" || !text(summary) ||
        !(source_session_id == null || text(source_session_id)) || (accepted !== undefined && typeof accepted !== "boolean")) return undefined;
    return { id: memory_id, kind: known, automatic, accepted: accepted ?? null, summary, sourceSession: source_session_id ?? null };
  });
  return parsed && { ...parsed, oldFormat: parsed.rows.some(({ id }) => formatOneFiles.has(id)) };
}

export function projectInbox(result: unknown): Page<InboxRow> | null {
  return page(result, ({ message_id, kind, status, sender, summary, created_ns, trusted_assignment, has_body }) => {
    const known = oneOf(inboxKinds, kind), state = oneOf(inboxStatuses, status);
    if (!text(message_id) || !known || !state || !text(sender) || !text(summary) || !time(created_ns) ||
        typeof trusted_assignment !== "boolean" || typeof has_body !== "boolean") return undefined;
    return { id: message_id, kind: known, status: state, sender, summary, createdNs: created_ns, trusted: trusted_assignment, hasBody: has_body };
  });
}

/** One kind's rendered text from `project_show`; the other kinds in the reply are dropped. */
export function projectKindText(result: unknown, kind: MemoryKind): KindText | null {
  const memory = record(result) ? result.memory : undefined;
  if (!record(memory) || !text(memory.digest) || !Array.isArray(memory.kinds)) return null;
  const found = memory.kinds.find((item) => record(item) && item.key === showKey(kind));
  if (!record(found) || !text(found.rendered) || typeof found.rendered_truncated !== "boolean") return null;
  return { text: found.rendered, truncated: found.rendered_truncated, digest: memory.digest };
}

export const canAcceptMemory = (row: Pick<MemoryRow, "automatic" | "accepted">) => row.automatic && row.accepted === false;
export const isMemoryId = (value: unknown): value is string => text(value) && /^[A-Za-z0-9_-]{1,128}(?![\s\S])/.test(value);
export const isMemoryDigest = (value: unknown): value is string => text(value) && /^[a-f0-9]{64}(?![\s\S])/.test(value);

/** Format 2 uses `kinds` instead of the legacy `files`. No text from this controller-only reply survives. */
export function projectMemoryRevision(result: unknown) {
  const memory = record(result) ? result.memory : undefined;
  if (!record(memory) || !isMemoryDigest(memory.digest) || !isMemoryId(memory.version_id) || !count(memory.schema_version) ||
      !Array.isArray(memory.kinds) || !memory.kinds.length || !memory.kinds.every((item) =>
        record(item) && text(item.key) && text(item.rendered) && typeof item.rendered_truncated === "boolean")) return null;
  return { digest: memory.digest, versionId: memory.version_id };
}

export function projectMessage(result: unknown, messageId: string): Body | null {
  if (!record(result) || !record(result.message) || result.message.message_id !== messageId || !text(result.body) || typeof result.truncated !== "boolean") return null;
  return { text: result.body, truncated: result.truncated };
}

function checked<T>(value: T | null) {
  if (value === null) throw new Unreadable("zeta sent data this view cannot read");
  return value;
}
type Read = { signal?: AbortSignal; timeoutMs?: number };

export const readProjects = async (client: ZetaClient, cursor: string | null, { signal }: Read = {}) =>
  checked(projectProjects(await client.request("state_projects", { limit: PAGE, cursor }, { signal })));
export const readMemory = async (client: ZetaClient, projectId: string, cursor: string | null, options: Read = {}) =>
  checked(projectMemory(await client.request("state_memory", { project_id: projectId, limit: PAGE, cursor }, options)));
export const readInbox = async (client: ZetaClient, projectId: string, cursor: string | null, { signal }: Read = {}) =>
  checked(projectInbox(await client.request("state_inbox", { project_id: projectId, limit: PAGE, cursor }, { signal })));
/** Controller only: `project_show` returns every kind; only the one asked for is kept. */
export const readKindText = async (client: ZetaClient, projectId: string, kind: MemoryKind, { signal }: Read = {}) =>
  checked(projectKindText(await client.request("project_show", { project_id: projectId }, { signal }), kind));
/** Controller only. */
export const readMemoryRevision = async (client: ZetaClient, projectId: string, options: Read = {}) =>
  checked(projectMemoryRevision(await client.request("project_show", { project_id: projectId }, options)));
/** Controller only. */
export const readMessage = async (client: ZetaClient, projectId: string, messageId: string, { signal }: Read = {}) =>
  checked(projectMessage(await client.request("state_inbox_detail", { project_id: projectId, message_id: messageId }, { signal }), messageId));
