import { ChildRunHistoryError, openChildRun, type ChildRunHistoryProgress, type ChildRunKey, type OpenChildRunResult, type ZetaClient } from "@fulcrum/zeta";
import { supportsFeature, supportsRequest } from "../zeta/connection";
import { AGENT_REFRESH_MS, readAttachedRoot } from "./reads";

export const childHistorySupported = (client: ZetaClient) =>
  supportsFeature(client, "child_runs") && supportsFeature(client, "child_run_history") && supportsRequest(client, "child_run_history");
export const newerHistory = "child details need a newer zeta.";
const notAttached = "child history is readable only from the chat that started it.";
const historyError = (error: unknown) => {
  if (error instanceof ChildRunHistoryError) {
    if (error.kind === "owner_not_active") return notAttached;
    if (error.kind === "not_negotiated") return newerHistory;
    if (error.kind === "not_found") return "zeta could not find this child transcript.";
    if (error.kind === "history_kept_changing") return "child history kept changing · retry";
    if (error.kind === "corrupt_transcript") return "zeta could not read the stored child transcript.";
  }
  return "could not read child history from zeta.";
};

type Snapshot = {
  result?: OpenChildRunResult;
  progress?: ChildRunHistoryProgress;
  loading?: boolean;
  stale?: boolean;
  warning?: string;
  limited?: boolean;
};

// Selected-history ownership adapted from gamma src/child-runs.ts at 6cd69671. No write or replay join.
export function createChildRunsController(
  client: ZetaClient, key: ChildRunKey,
  { open = openChildRun, attached = readAttachedRoot, now = Date.now } = {},
) {
  let snapshot: Snapshot = {};
  let active: AbortController | undefined;
  let latestRead = -Infinity;
  const listeners = new Set<() => void>();
  const publish = (next: Snapshot) => { snapshot = next; listeners.forEach((listener) => listener()); };
  const release = () => {
    active?.abort();
    active = undefined;
    snapshot.result?.lease.release();
  };
  const refresh = async () => {
    release();
    const controller = active = new AbortController();
    const { signal } = controller;
    const current = () => active === controller && !signal.aborted;
    latestRead = now();
    publish({ loading: true });
    try {
      if (await attached(client, signal) !== key.sessionId) {
        if (current()) publish({ warning: notAttached, limited: true });
        return;
      }
      if (!current()) return;
      let progress: ChildRunHistoryProgress | undefined;
      const result = await open(client, key, {
        signal,
        onProgress(next) {
          progress = next;
          if (current() && snapshot.result) publish({ ...snapshot, progress });
        },
      });
      void result.complete.then(() => {
        if (current()) publish({ ...snapshot, progress: { messages: progress?.messages ?? 0, restart: progress?.restart ?? 0, complete: true } });
      }, (error) => {
        if (current()) publish({ ...snapshot, warning: historyError(error) });
      });
      if (!current()) result.lease.release();
      else publish({ result, progress, stale: snapshot.stale });
    } catch (error) {
      if (current()) publish({ warning: historyError(error), limited: error instanceof ChildRunHistoryError && (error.kind === "owner_not_active" || error.kind === "not_negotiated") });
    }
  };
  return {
    snapshot: () => snapshot,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    refresh,
    changed() {
      // an empty read has nothing to keep: read again at once instead of asking for a refresh
      if (!snapshot.loading && (now() - latestRead >= AGENT_REFRESH_MS || snapshot.result && !snapshot.progress?.messages)) return refresh();
      if (!snapshot.stale) publish({ ...snapshot, stale: true });
    },
    close() { release(); publish({}); },
  };
}
