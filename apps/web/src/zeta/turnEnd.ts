import type { Transport, ZetaClient } from "@fulcrum/zeta";
import { applyApprovalMode, pageBinding, rebindPage, runningSession } from "./session";

type RunEndListener = (sessionId: string) => void;
const runEndListeners = new WeakMap<object, Set<RunEndListener>>();
const listenersOf = (client: object) => {
  let listeners = runEndListeners.get(client);
  if (!listeners) runEndListeners.set(client, listeners = new Set());
  return listeners;
};

/** Reports zeta's `agent_end` frames (any session) in arrival order, after `client` has dispatched each one. */
function publishRunEnd(client: object, sessionId: string) {
  for (const listener of [...listenersOf(client)]) listener(sessionId);
}

/**
 * The transport for one client, with every `agent_end` frame reported to `onRunEnd` listeners. fulcrum's stores
 * notify once per animation frame, so a whole short turn can pass without a render ever seeing it run: turn ends are
 * read here, off the socket, never from render snapshots.
 */
export function teeRunEnds(transport: Transport, client: () => object | null): Transport {
  return {
    ...(transport.ready ? { ready: transport.ready } : {}),
    send: (text) => transport.send(text),
    close: () => transport.close(),
    ...(transport.onClose ? { onClose: (callback: (code?: number) => void) => transport.onClose!(callback) } : {}),
    onMessage: (callback) => transport.onMessage((text) => {
      callback(text);
      if (!text.includes('"agent_end"')) return;
      let frame: { method?: unknown; params?: { event?: unknown; session_id?: unknown } };
      try { frame = JSON.parse(text); } catch { return; }
      const owner = client();
      if (owner && frame.method === "event" && frame.params?.event === "agent_end" && typeof frame.params.session_id === "string") publishRunEnd(owner, frame.params.session_id);
    }),
  };
}

/** Calls `listener` with the session id of every `agent_end` frame, in arrival order, until the returned function runs. */
export function onRunEnd(client: object, listener: RunEndListener): () => void {
  const listeners = listenersOf(client);
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Calls `ended` once when zeta is not running `sessionId`'s turn: on its `agent_end`, or at once if a status read shows it is not running. */
export function whenTurnEnds(client: ZetaClient, sessionId: string, ended: () => void): () => void {
  let done = false;
  const finish = () => { if (done) return; done = true; unsubscribe(); ended(); };
  const unsubscribe = onRunEnd(client, (id) => { if (id === sessionId) finish(); });
  void runningSession(client).then((running) => { if (running !== sessionId) finish(); }, () => {});
  return () => { done = true; unsubscribe(); };
}

type TurnEndWork = { rebind: boolean; approvalMode: string | null };
type TurnEndSettled = { rebind: false } | { approvalMode: string | null | undefined; pendingApprovalMode: string | null };
type Clock = Pick<typeof globalThis, "setTimeout" | "clearTimeout">;
type TurnEndInput = {
  client: ZetaClient;
  sessionId: string;
  binding: ReturnType<typeof pageBinding>;
  work: TurnEndWork;
  settled: (update: TurnEndSettled) => void;
  failed: (caught: unknown) => void;
  clock?: Clock;
};

// zeta can still refuse settings just after agent_end while it finishes the turn, and no frame follows: a refusal is
// tried again after a short wait, this many times; the next run end starts the count again
export const TURN_END_RETRY_LIMIT = 5;
const TURN_END_RETRY_MS = 300;
const TURN_RUNNING = -32004;
const refusedByTurn = (caught: unknown) => (caught as { code?: unknown } | null)?.code === TURN_RUNNING;

/**
 * The one owner of what a chat must do once zeta is idle: re-send its page binding (`rebind`) and apply a pending
 * approval mode. zeta is the authority: each try asks it (status, then the request), and a turn it is still running
 * refuses the change (-32004), which keeps the work pending. It tries at once, again on every turn end of any session
 * (zeta runs one turn at a time), and on `settle()`. Tries never overlap.
 */
export function createTurnEndOwner({ client, sessionId, binding, work, settled, failed, clock = globalThis }: TurnEndInput) {
  const due = { ...work };
  let disposed = false;
  let retries = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running: Promise<void> | null = null;
  let again = false;
  const clearTimer = () => { if (timer !== null) clock.clearTimeout(timer); timer = null; };
  const refused = () => {
    if (disposed || retries >= TURN_END_RETRY_LIMIT) return;
    retries += 1;
    timer = clock.setTimeout(() => { timer = null; void attempt(); }, TURN_END_RETRY_MS);
  };
  const once = async () => {
    if (!due.rebind && !due.approvalMode) return;
    if (await runningSession(client) !== null) return refused();
    if (disposed) return;
    if (due.rebind) {
      try { await rebindPage(client, sessionId, binding); }
      catch (caught) { if (refusedByTurn(caught)) return refused(); throw caught; }
      due.rebind = false;
      if (disposed) return;
      settled({ rebind: false });
    }
    const mode = due.approvalMode;
    if (!mode) return;
    const result = await applyApprovalMode(client, sessionId, mode, () => !disposed);
    if (disposed) return;
    if (!result.pending) due.approvalMode = null;
    settled({ approvalMode: result.approvalMode, pendingApprovalMode: result.pending ? mode : null });
    if (result.pending) refused();
  };
  const attempt = (): Promise<void> => {
    if (disposed) return Promise.resolve();
    if (running) { again = true; return running; }
    clearTimer();
    running = (async () => {
      try {
        do { again = false; await once(); } while (again && !disposed);
      } catch (caught) { if (!disposed) failed(caught); }
      finally { running = null; }
    })();
    return running;
  };
  const unsubscribe = onRunEnd(client, () => { retries = 0; void attempt(); });
  void attempt();
  return {
    /** One try now (send calls it first, so a message never goes out before the page binding). */
    settle: attempt,
    dispose() { disposed = true; clearTimer(); unsubscribe(); },
  };
}
