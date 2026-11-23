import type { ZetaClient } from "@fulcrum/zeta";
import { createWriteForms } from "../writeForms";
import { supportsFeature, supportsRequest } from "../zeta/connection";
import { canAcceptMemory, isMemoryDigest, isMemoryId, readMemory, readMemoryRevision, type MemoryRow } from "./reads";

const FEATURE = "project_writes_v1";
const METHOD = "project_memory_update";
export const memoryWriteAccess = (client: ZetaClient, controller: boolean) =>
  supportsFeature(client, FEATURE) && (!controller || supportsRequest(client, METHOD));
export const MAX_RESOLVE = 64;
const BACKOFF = [500, 1_000, 2_000];
const TIMEOUT = 10_000;
const sleep = (ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  const abort = () => { clearTimeout(timer); reject(signal.reason); };
  const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, ms);
  if (signal.aborted) abort(); else signal.addEventListener("abort", abort, { once: true });
});

export type MemoryAction = "accept" | "resolve" | "undo";
export type MemoryReceipt = { action: "accept" | "resolve"; versionId: string; revision: string; ids: readonly string[] };
type Mutation = { format: 2 } & ({ op: "accept" | "undo"; target: string } | { op: "resolve"; entry_ids: readonly string[] });
export type MemoryAttempt = Readonly<{ projectId: string; projectName: string; revision: string; mutation: Mutation;
  rows: readonly Readonly<MemoryRow>[]; prior?: MemoryReceipt }>;
export type MemoryOutcome =
  | { status: "committed"; message: string; receipt?: MemoryReceipt }
  | { status: "changed" | "refused" | "not-applied" | "unverified"; message: string; refresh?: boolean }
  | { status: "unknown" };
export const CHANGED = "memory changed before this action finished. nothing was changed. review the current entries and try again.";
const UNAVAILABLE = "this zeta cannot change project memory.";
const NOT_SENT = { status: "refused", message: "this page could not send the memory action. nothing was sent." } as const;
const UNKNOWN = { status: "unknown" } as const;
const refused = (message: string, refresh = false): MemoryOutcome => ({ status: "refused", message, refresh });
const rpc = (error: unknown) => error as { code?: unknown; data?: { reason?: unknown } } | null;
const options = (signal?: AbortSignal) => ({ signal, timeoutMs: TIMEOUT });

function mapError(error: unknown): MemoryOutcome | null {
  const value = rpc(error);
  switch (value?.code) {
    case -32009: return { status: "changed", message: CHANGED, refresh: true };
    case -32602:
      switch (value.data?.reason) {
        case "secret_refused": return refused("zeta refused this memory action because the selected memory contains secret-like content. nothing changed.");
        case "operation_rejected": return refused("zeta could not apply this action to the current entry. nothing changed; review the refreshed memory.", true);
        default: return refused("zeta refused this project, entry, or action. nothing changed.", value.data?.reason === "project_not_found");
      }
    case -32004: return refused("another zeta process is writing project memory. nothing changed; try again.");
    case -32008: return refused("this tab is read-only. take control to change memory.");
    case -32003: return refused("zeta has no open chat. nothing changed.");
    case -32005: return refused("project memory is not available. nothing changed; refresh the project.");
    case -32000: return refused("zeta found this project's stored state invalid. check it with `zeta project show`. nothing changed.");
    case -32601: return refused(UNAVAILABLE);
    default: return null;
  }
}

function mutationFor(action: MemoryAction, rows: readonly MemoryRow[], prior?: MemoryReceipt): Mutation | null {
  if (action === "undo") return prior && isMemoryId(prior.versionId) ? { format: 2, op: action, target: prior.versionId } : null;
  const ids = rows.map(({ id }) => id);
  if (!ids.every(isMemoryId) || new Set(ids).size !== ids.length) return null;
  if (action === "accept") return ids.length === 1 && canAcceptMemory(rows[0]!) ? { format: 2, op: action, target: ids[0]! } : null;
  return ids.length > 0 && ids.length <= MAX_RESOLVE ? { format: 2, op: action, entry_ids: ids } : null;
}

function success(result: unknown, sent: MemoryAttempt): MemoryOutcome | null {
  const value = result as { revision?: unknown; data?: { format?: unknown; version_id?: unknown } } | null;
  if (!isMemoryDigest(value?.revision) || value.data?.format !== 2 || !isMemoryId(value.data.version_id)) return null;
  const action = sent.mutation.op;
  const message = action === "accept" ? "accepted 1 memory entry" : action === "resolve"
    ? `resolved ${sent.rows.length} memory ${sent.rows.length === 1 ? "entry" : "entries"}` : "undid this memory change";
  return { status: "committed", message: `${message}. running sessions read the change at their next prompt.`,
    ...(action === "undo" ? {} : { receipt: { action, versionId: value.data.version_id, revision: value.revision, ids: sent.rows.map(({ id }) => id) } }) };
}

/** The router supplies only a live controller with the negotiated write method. Reads and retries stop on close; a sent request is not aborted. */
export function createMemoryWriter(live: () => ZetaClient | null, wait = sleep, afterClose?: (outcome: MemoryOutcome, sent: MemoryAttempt) => void) {
  const { run, ...forms } = createWriteForms<MemoryOutcome, MemoryAttempt>({
    inProgress: refused("another memory action for this project is in progress. nothing was sent."), unexpected: NOT_SENT, afterClose,
  });

  const uncertain = new WeakSet<MemoryAttempt>();
  const sentAttempts = new WeakSet<MemoryAttempt>();

  async function prepare(projectId: string, projectName: string, action: MemoryAction, selected: readonly MemoryRow[], prior?: MemoryReceipt) {
    const rows = selected.map((row) => ({ ...row }));
    const mutation = mutationFor(action, rows, prior);
    if (!mutation) return { problem: "select valid active memory entries to review." };
    const client = live();
    if (!client) return { problem: UNAVAILABLE };
    try {
      const { digest } = await readMemoryRevision(client, projectId, options());
      if (action === "undo" && digest !== prior!.revision) return { problem: CHANGED, refresh: true };
      return { sent: { projectId, projectName, revision: digest, mutation, rows, prior } satisfies MemoryAttempt };
    } catch {
      return { problem: "could not read the current memory revision. nothing was sent; review the refreshed memory.", refresh: true };
    }
  }

  async function execute(sent: MemoryAttempt, signal: AbortSignal): Promise<MemoryOutcome | null> {
    const { projectId, revision, mutation } = sent;
    const params = { project_id: projectId, revision, mutation };
    for (let attempt = 0; !signal.aborted; attempt++) {
      const client = live();
      if (!client) return refused("this tab has no connection in control. nothing was sent.");
      try {
        return success(await client.request(METHOD, params, options()), sent) ?? UNKNOWN;
      } catch (error) {
        if (rpc(error)?.code === -32004 && attempt < BACKOFF.length) {
          try { await wait(BACKOFF[attempt]!, signal); continue; } catch { return null; }
        }
        const outcome = mapError(error);
        if (outcome?.status === "changed" && !signal.aborted) {
          // Still in the same control episode. The view refreshes its own pages before another review.
          try { await readMemoryRevision(live() ?? client, projectId, options(signal)); } catch { /* a format change can make this unreadable */ }
        }
        return outcome ?? UNKNOWN;
      }
    }
    return null;
  }

  async function check(sent: MemoryAttempt, signal: AbortSignal): Promise<MemoryOutcome> {
    const client = live();
    if (!client) return UNKNOWN;
    const { projectId, revision, mutation } = sent;
    const unverified: MemoryOutcome = { status: "unverified", refresh: true, message: mutation.op === "undo"
      ? "could not prove whether undo finished; review current memory before another action."
      : "could not prove the result. review current memory before another action." };
    if (mutation.op === "undo") return unverified;
    try {
      const before = await readMemoryRevision(client, projectId, options(signal));
      const rows = new Map<string, MemoryRow>();
      const ids = mutation.op === "resolve" ? mutation.entry_ids : [mutation.target];
      let cursor: string | null = null;
      // Absence needs a complete, stable scan. An unusually large or shifting project stays unverified.
      for (let n = 0; n < 20; n++) {
        const page = await readMemory(client, projectId, cursor, options(signal));
        if (page.oldFormat) return unverified;
        for (const row of page.rows) if (ids.includes(row.id)) rows.set(row.id, row);
        cursor = page.nextCursor;
        if (cursor === null || rows.size === ids.length) break;
      }
      const after = await readMemoryRevision(client, projectId, options(signal));
      if (before.digest !== after.digest || before.versionId !== after.versionId) return unverified;
      const matches = mutation.op === "accept" ? rows.get(mutation.target)?.accepted === true : cursor === null && rows.size === 0;
      if (matches) return { status: "committed", message: "current memory now matches this action." };
      const unchanged = mutation.op === "accept" ? rows.get(mutation.target)?.accepted === false : rows.size === ids.length;
      if (after.digest === revision && unchanged) return { status: "not-applied", message: "zeta did not apply this memory action. review the current entries and try again.", refresh: true };
    } catch { /* a partial read proves nothing */ }
    return unverified;
  }

  return { ...forms, prepare,
    execute: (form: string, sent: MemoryAttempt) => run(form, sent.projectId, JSON.stringify([sent.mutation, sent.revision]), sent, async (signal) => {
      if (sentAttempts.has(sent)) return uncertain.has(sent) ? UNKNOWN : NOT_SENT;
      sentAttempts.add(sent);
      const outcome = await execute(sent, signal);
      if (outcome?.status === "unknown") uncertain.add(sent);
      return outcome;
    }),
    checkResult: (form: string, sent: MemoryAttempt) => run(form, sent.projectId, JSON.stringify(["check", sent.mutation, sent.revision]), sent, async (signal) => {
      if (!uncertain.has(sent)) return NOT_SENT;
      const outcome = await check(sent, signal);
      if (outcome.status !== "unknown") uncertain.delete(sent);
      return outcome;
    }),
  };
}
export type MemoryWriter = ReturnType<typeof createMemoryWriter>;
