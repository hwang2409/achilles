// adapted from gamma@6cd69671 src/connection.ts
import { createClient, webSocketTransport, ZetaError, type ZetaClient, type ZetaDiscovery, type ZetaRole } from "@fulcrum/zeta";

const TAKEOVER_RETRY_LIMIT = 5;

type TakeoverFailure = "busy_bound" | "error";

/** Every waiting state carries the number of failures and the next automatic retry time. */
export type ConnectionState =
  | { phase: "connecting"; attempt: number; lost: boolean; lastFailure?: "unresponsive" }
  | { phase: "connected"; authority: ZetaRole }
  | { phase: "taking_control"; authority: "observer"; attempt: number }
  | { phase: "takeover_failed"; authority: "observer"; reason: TakeoverFailure }
  | { phase: "not_running"; attempt: number; retryAt: number; lost: boolean }
  | { phase: "auth_failed"; reason: "origin" | "rejected"; origins: string[]; attempt: number; retryAt: number; lost: boolean }
  | { phase: "dropped"; attempt: number; retryAt: number; lost: true }
  | { phase: "unresponsive" | "incompatible" | "capacity"; attempt: number; retryAt: number; lost: boolean };

export type ConnectionEvent =
  | { type: "attempt" }
  | { type: "connected"; authority: ZetaRole }
  | { type: "takeover_started" }
  | { type: "takeover_cancelled" }
  | { type: "takeover_outcome"; outcome: "success" | "busy" | "error" }
  | { type: "not_running"; now: number }
  | { type: "auth_failed"; reason: "origin" | "rejected"; origins: string[]; now: number }
  | { type: "unresponsive" | "incompatible" | "capacity"; now: number }
  | { type: "closed"; now: number };

export const initialConnection: ConnectionState = { phase: "connecting", attempt: 0, lost: false };

/** 0.5 s, 1 s, 2 s, 4 s, 8 s, then every 10 s. */
export const backoff = (attempt: number) => Math.min(10_000, 500 * 2 ** Math.max(0, attempt - 1));

const attemptOf = (state: ConnectionState) => ("attempt" in state ? state.attempt : 0);
const hasLiveClient = (state: ConnectionState) => state.phase === "connected" || state.phase === "taking_control" || state.phase === "takeover_failed";
const lostOf = (state: ConnectionState) => hasLiveClient(state) || ("lost" in state && state.lost);

export function reduceConnection(state: ConnectionState, event: ConnectionEvent): ConnectionState {
  if (event.type === "takeover_started")
    return (state.phase === "connected" && state.authority === "observer") || state.phase === "takeover_failed" ? { phase: "taking_control", authority: "observer", attempt: 0 } : state;
  if (event.type === "takeover_cancelled")
    return state.phase === "taking_control" ? { phase: "connected", authority: "observer" } : state;
  if (event.type === "takeover_outcome") {
    if (state.phase !== "taking_control") return state;
    if (event.outcome === "success") return { phase: "connected", authority: "controller" };
    if (event.outcome === "error") return { phase: "takeover_failed", authority: "observer", reason: "error" };
    const attempt = state.attempt + 1;
    return attempt > TAKEOVER_RETRY_LIMIT
      ? { phase: "takeover_failed", authority: "observer", reason: "busy_bound" }
      : { ...state, attempt };
  }

  const lost = lostOf(state);
  switch (event.type) {
    case "attempt":
      return hasLiveClient(state) ? state : { phase: "connecting", attempt: attemptOf(state), lost, ...(state.phase === "unresponsive" || (state.phase === "connecting" && state.lastFailure === "unresponsive") ? { lastFailure: "unresponsive" as const } : {}) };
    case "connected":
      return { phase: "connected", authority: event.authority };
    case "closed":
      return hasLiveClient(state) ? { phase: "dropped", attempt: 1, retryAt: event.now + backoff(1), lost: true } : state;
    default: {
      if (state.phase !== "connecting") return state;
      const attempt = state.attempt + 1;
      const retryAt = event.now + backoff(attempt);
      if (event.type === "auth_failed") return { phase: "auth_failed", reason: event.reason, origins: event.origins, attempt, retryAt, lost };
      return { phase: event.type, attempt, retryAt, lost };
    }
  }
}

export type ConnectionDeps = {
  origin: string;
  discover?: () => Promise<ZetaDiscovery | null>;
  connect?: (discovery: ZetaDiscovery, role: ZetaRole, opened?: (close: () => void) => void) => Promise<ZetaClient>;
  now?: () => number;
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (timer: unknown) => void;
  helloTimeoutMs?: number;
  initialPort?: number;
};

export type Connection = {
  readonly state: ConnectionState;
  readonly client: ZetaClient | null;
  readonly port: number;
  subscribe(listener: () => void): () => void;
  retryNow(): void;
  takeControl(): void;
  cancelTakeControl(): void;
  stop(): void;
};

export const FEATURES = ["approval_history", "approval_reconnect", "delivery_id", "delivery_session_guard", "session_history_fidelity", "session_replay_seq", "served_turn_end", "user_message_event", "user_message_delivery_id", "session_cwd", "session_mcp_bindings", "serve_observers"];

const negotiatedRequests = new WeakMap<ZetaClient, ReadonlySet<string>>();
export const supportsFeature = (client: ZetaClient, feature: string) => client.features.includes(feature);

type OpenResult = { kind: "connected"; client: ZetaClient } | { kind: "busy" | "unresponsive" | "version_mismatch" | "rejected" };

async function connectRole(discovery: ZetaDiscovery, role: ZetaRole, opened?: (close: () => void) => void) {
  const url = new URL(discovery.url);
  for (const key of [...url.searchParams.keys()]) if (key.toLowerCase() === "token") url.searchParams.delete(key);
  let transport;
  const token = role === "controller" ? discovery.controller_token : discovery.observer_token;
  try { transport = await webSocketTransport(url.toString(), ["zeta.v1", `zeta.bearer.${token}`]); }
  catch { throw new ZetaError("connect_failed"); }
  opened?.(() => transport.close());
  const client = createClient(transport, undefined, (handshaken, code) => new ZetaError(handshaken ? "closed" : "connect_failed", code));
  try { const hello = await client.hello(FEATURES, role); negotiatedRequests.set(client, new Set(hello.capabilities?.requests ?? [])); }
  catch (error) {
    transport.close();
    const code = (error as { code?: unknown }).code;
    throw new ZetaError(code === -32001 ? "busy" : code === -32002 ? "version_mismatch" : "connect_failed", typeof code === "number" ? code : undefined);
  }
  return client;
}

async function openRole(discovery: ZetaDiscovery, role: ZetaRole, connect: NonNullable<ConnectionDeps["connect"]>, helloTimeoutMs: number): Promise<OpenResult> {
  let timedOut = false;
  let closePending = () => {};
  let connectTimeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const opened = await Promise.race([
      connect(discovery, role, (close) => { closePending = close; }).then((value) => { if (timedOut) value.close(); return value; }),
      new Promise<never>((_, reject) => { connectTimeout = setTimeout(() => { timedOut = true; closePending(); reject(new Error("hello timeout")); }, helloTimeoutMs); }),
    ]);
    return { kind: "connected", client: opened };
  } catch (error) {
    if (timedOut) return { kind: "unresponsive" };
    const kind = error instanceof ZetaError ? error.kind : "connect_failed";
    return { kind: kind === "busy" || kind === "version_mismatch" ? kind : "rejected" };
  } finally { clearTimeout(connectTimeout); }
}

export function createConnection({
  origin,
  discover = async () => { const response = await fetch("/api/zeta/discovery", { cache: "no-store" }); return response.ok ? await response.json() : null; },
  connect = connectRole,
  now = Date.now,
  setTimer = (callback, ms) => setTimeout(callback, ms),
  clearTimer = (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
  helloTimeoutMs = 15_000,
  initialPort = 8765,
}: ConnectionDeps): Connection {
  let state = initialConnection;
  let client: ZetaClient | null = null;
  let port = initialPort;
  let timer: unknown = null;
  let generation = 0;
  let stopped = false;
  const listeners = new Set<() => void>();
  const publish = (next: ConnectionState) => { if (next !== state) { state = next; listeners.forEach((listener) => listener()); } };
  const send = (event: ConnectionEvent) => {
    publish(reduceConnection(state, event));
    if ("retryAt" in state && !(state.phase === "capacity" && state.attempt > TAKEOVER_RETRY_LIMIT)) schedule(state.retryAt - now());
  };
  const schedule = (ms: number) => {
    if (timer !== null) clearTimer(timer);
    timer = setTimer(() => { timer = null; void attempt(); }, Math.max(0, ms));
  };
  const installClient = (next: ZetaClient, authority: ZetaRole, takingOver: boolean) => {
    if (takingOver) client?.close();
    client = next;
    next.onClose(() => { if (client === next) { client = null; send({ type: "closed", now: now() }); } });
    send(takingOver ? { type: "takeover_outcome", outcome: "success" } : { type: "connected", authority });
  };
  const finishControllerOpen = async (opened: OpenResult, discovery: ZetaDiscovery, takingOver: boolean, current: () => boolean) => {
    if (!current()) { if (opened.kind === "connected") opened.client.close(); return; }
    if (takingOver) {
      const outcome = opened.kind === "connected" ? "success" : opened.kind === "busy" ? "busy" : "error";
      if (opened.kind === "connected") installClient(opened.client, "controller", true);
      else { send({ type: "takeover_outcome", outcome }); if (state.phase === "taking_control") schedule(backoff(state.attempt)); }
      return;
    }
    if (opened.kind === "connected") return installClient(opened.client, "controller", false);
    if (opened.kind !== "busy") {
      if (opened.kind === "unresponsive") return send({ type: "unresponsive", now: now() });
      if (opened.kind === "version_mismatch") return send({ type: "incompatible", now: now() });
      return send({ type: "auth_failed", reason: "rejected", origins: discovery.origins, now: now() });
    }
    if (!discovery.observer_token) return send({ type: "capacity", now: now() });
    const observer = await openRole(discovery, "observer", connect, helloTimeoutMs);
    if (!current()) { if (observer.kind === "connected") observer.client.close(); return; }
    if (observer.kind === "connected") return installClient(observer.client, "observer", false);
    if (observer.kind === "unresponsive") return send({ type: "unresponsive", now: now() });
    if (observer.kind === "version_mismatch") return send({ type: "incompatible", now: now() });
    send({ type: "capacity", now: now() });
  };
  const failAttempt = (event: ConnectionEvent, takingOver: boolean) => {
    if (takingOver) send({ type: "takeover_outcome", outcome: "error" });
    else send(event);
  };
  const attempt = async () => {
    const takingOver = state.phase === "taking_control";
    if (stopped || (hasLiveClient(state) && !takingOver)) return;
    const mine = ++generation;
    if (!takingOver) send({ type: "attempt" });
    const current = () => mine === generation && !stopped;
    let discovery: ZetaDiscovery | null;
    try { discovery = await discover(); } catch { discovery = null; }
    if (!current()) return;
    if (!discovery) return failAttempt({ type: "not_running", now: now() }, takingOver);
    port = Number(new URL(discovery.url).port) || port;
    if (discovery.origins.length && !discovery.origins.includes(origin))
      return failAttempt({ type: "auth_failed", reason: "origin", origins: discovery.origins, now: now() }, takingOver);
    await finishControllerOpen(await openRole(discovery, "controller", connect, helloTimeoutMs), discovery, takingOver, current);
  };
  void attempt();
  return {
    get state() { return state; },
    get client() { return client; },
    get port() { return port; },
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    retryNow() {
      if (state.phase === "takeover_failed") { send({ type: "takeover_started" }); schedule(0); return; }
      if (hasLiveClient(state) || state.phase === "connecting" || stopped) return;
      if (timer !== null) { clearTimer(timer); timer = null; }
      void attempt();
    },
    takeControl() {
      if (state.phase !== "connected" || state.authority !== "observer" || stopped) return;
      send({ type: "takeover_started" });
      schedule(0);
    },
    cancelTakeControl() {
      if (state.phase !== "taking_control") return;
      generation++;
      if (timer !== null) { clearTimer(timer); timer = null; }
      send({ type: "takeover_cancelled" });
    },
    stop() {
      stopped = true; generation++;
      if (timer !== null) clearTimer(timer);
      const open = client; client = null; open?.close();
    },
  };
}
