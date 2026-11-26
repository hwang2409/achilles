// adapted from gamma@6cd69671 src/connection.ts
import { createClient, webSocketTransport, ZetaError, type ZetaClient, type ZetaDiscovery, type ZetaRole } from "@fulcrum/zeta";
import { shellHeaders } from "../shell";
import { ACCOUNT_LIST_IDLE_FEATURE } from "./accounts";
import { teeRunEnds } from "./turnEnd";

/**
 * Connection states. Every waiting state carries `attempt` (failures in a row) and `retryAt` (epoch ms of the next
 * automatic try). `lost` marks failures that follow a connection this page had, so the UI can say "connection lost".
 */
export type ConnectionState =
  | { phase: "connecting"; attempt: number; lost: boolean; lastFailure?: "unresponsive" }
  | { phase: "connected"; authority: ZetaRole }
  | { phase: "not_running"; attempt: number; retryAt: number; lost: boolean }
  | { phase: "auth_failed"; reason: "origin" | "rejected"; origins: string[]; attempt: number; retryAt: number; lost: boolean }
  | { phase: "dropped"; attempt: number; retryAt: number; lost: true }
  | { phase: "unresponsive" | "incompatible" | "controller_taken" | "observer_limit"; attempt: number; retryAt: number; lost: boolean };

export type ConnectionEvent =
  | { type: "attempt" }
  | { type: "connected"; authority: ZetaRole }
  | { type: "not_running"; now: number }
  | { type: "auth_failed"; reason: "origin" | "rejected"; origins: string[]; now: number }
  | { type: "unresponsive" | "incompatible" | "controller_taken" | "observer_limit"; now: number }
  | { type: "closed"; now: number };

/** The command that starts a server this page may connect to. The origin is exact: localhost and 127.0.0.1 differ. */

export const initialConnection: ConnectionState = { phase: "connecting", attempt: 0, lost: false };

/** 0.5 s, 1 s, 2 s, 4 s, 8 s, then every 10 s: quick after a blip, and cheap while the server stays down. */
export const backoff = (attempt: number) => Math.min(10_000, 500 * 2 ** Math.max(0, attempt - 1));

const attemptOf = (state: ConnectionState) => ("attempt" in state ? state.attempt : 0);
const lostOf = (state: ConnectionState) => state.phase === "connected" || ("lost" in state && state.lost);

/** observer wording is valid only after the server accepts the observer handshake. */
export const isObserverPresentation = (state: ConnectionState, retained: boolean) => retained && state.phase === "connected" && state.authority === "observer";

export function reduceConnection(state: ConnectionState, event: ConnectionEvent): ConnectionState {
  const lost = lostOf(state);
  switch (event.type) {
    case "attempt":
      return state.phase === "connected" ? state : { phase: "connecting", attempt: attemptOf(state), lost, ...(state.phase === "unresponsive" || (state.phase === "connecting" && state.lastFailure === "unresponsive") ? { lastFailure: "unresponsive" as const } : {}) };
    case "connected":
      return { phase: "connected", authority: event.authority };
    case "closed":
      return state.phase === "connected" ? { phase: "dropped", attempt: 1, retryAt: event.now + backoff(1), lost: true } : state;

    default: {
      if (state.phase !== "connecting") return state; // failures only finish an attempt in flight
      const attempt = state.attempt + 1;
      const retryAt = event.now + backoff(attempt);
      if (event.type === "auth_failed") return { phase: "auth_failed", reason: event.reason, origins: event.origins, attempt, retryAt, lost };
      return { phase: event.type, attempt, retryAt, lost };
    }
  }
}

type RoleState = { role: ZetaRole; reason: string | null };
type RoleEvent = "connect_writable" | "connect_read_only" | "controller_granted" | "observer_granted" | "controller_busy" | "observer_busy" | "both_busy" | "takeover_refused" | "takeover_failed" | "controller_closed" | "control_released" | "retry";

// zeta sends observers no "slot free" signal, so the refusal is a past result with its time: true for as long as it shows.
export const refusedReason = (at: number) => `at ${new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }).toLowerCase()} another tab had control. a chat tab keeps it while it is open; try again after it finishes or closes.`;

/** The reason when a takeover failed for any cause other than an occupied controller slot. */
export const TAKEOVER_FAILED = "could not take control. try again.";

// `at`: when a takeover was refused (epoch ms).
export function transitionRole(state: RoleState, event: RoleEvent, at = Date.now()): RoleState {
  switch (event) {
    case "connect_writable":
    case "controller_granted":
    case "controller_closed":
    case "both_busy":
      return { role: "controller", reason: null };
    case "connect_read_only":
    case "observer_granted":
    case "control_released":
    case "controller_busy":
    case "observer_busy":
      return { role: "observer", reason: null };
    case "takeover_refused":
      return { role: state.role, reason: refusedReason(at) };
    case "takeover_failed":
      return { role: state.role, reason: TAKEOVER_FAILED };
    case "retry":
      return { role: state.role, reason: null };
  }
}

export type ConnectionDeps = {
  /** The page origin the server's `--ws-origin` allowlist must contain. */
  origin: string;
  /** `locked`: this document only connects as an observer. `upgradable`: observer at load; `takeControl` may promote it. */
  readOnly?: "locked" | "upgradable";
  /** `{ start }` when zeta is not running and the server names the command that starts it. */
  discover?: () => Promise<ZetaDiscovery | { start: string } | null>;
  connect?: (discovery: ZetaDiscovery, role: ZetaRole, opened?: (close: () => void) => void) => Promise<ZetaClient>;
  now?: () => number;
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (timer: unknown) => void;
  helloTimeoutMs?: number;
  initialPort?: number;
};

export type Connection = {
  readonly state: ConnectionState;
  /** The live client while `state.phase` is `connected`, else `null`. */
  readonly client: ZetaClient | null;
  /** The shell command that starts zeta for this achilles: the server's own hint (`make dev`, or the attached discovery
   * file), else `zeta serve` on the last port found (8765, zeta's documented port, before any). */
  readonly startCommand: string;
  subscribe(listener: () => void): () => void;
  /** Skips the wait before the next automatic try. */
  retryNow(): void;
  /** Reopens this page as controller, or keeps it as a live observer if the slot is still occupied. */
  takeControl(): Promise<string | null>;
  /** `upgradable` only: gives the controller slot back taken by `takeControl` (reopens as observer), and reconnects
   * as observer from then on, so a chat tab can take control. */
  releaseControl(): Promise<void>;
  /** `upgradable` only: borrows control for one read. Takes control (never without the caller's user click), runs
   * `read` on the controller client, and gives control back on success, error and drop alike. A refusal sends no read.
   * A read with no answer in `BORROW_LIMIT_MS` gives control back and rejects with `NoAnswer`. */
  withControl<T>(read: (client: ZetaClient) => Promise<T>): Promise<{ value: T } | { refused: string }>;
  /** Whether the last established authority was an observer. */
  readonly observerPresentation: boolean;
  stop(): void;
};

/** A borrowed read holds the controller slot: past this, control goes back even without an answer. */
const BORROW_LIMIT_MS = 20_000;
/** A borrowed read that zeta did not answer in time. */
export class NoAnswer extends Error {}

export const TELEMETRY_FEATURE = "telemetry_read_v1";

export const FEATURES = ["approval_history", "approval_reconnect", "delivery_id", "delivery_session_guard", "mcp_refresh_tools", "session_history_fidelity", "session_replay_seq", "in_flight_replay", "served_turn_end", "user_message_event", "user_message_delivery_id", "session_cwd", "session_mcp_bindings", "resume_attach", "turn_reconnect", "tool_approval_origin", "serve_observers", TELEMETRY_FEATURE, "library_read_v1", "library_write_v1", "session_history_read_v1", "session_history_backward", "list_sessions_paging", "projects", "projects-memory-v2", "project_writes_v1", "state_read_v1", "agent_run_catalog_v1", "child_runs", "child_run_control_v1", "child_run_history", "child_run_events", "home_settings_v1", "mcp_management_v1", ACCOUNT_LIST_IDLE_FEATURE];

const negotiatedRequests = new WeakMap<ZetaClient, ReadonlySet<string>>();

export const supportsFeature = (client: ZetaClient, feature: string) => client.features.includes(feature);

/** Whether the server advertised this request method in its hello capabilities (per the negotiated protocol version). */
export const supportsRequest = (client: ZetaClient, request: string) => negotiatedRequests.get(client)?.has(request) ?? false;

async function connectRole(discovery: ZetaDiscovery, role: ZetaRole, opened?: (close: () => void) => void) {
  const url = new URL(discovery.url);
  for (const key of [...url.searchParams.keys()]) if (key.toLowerCase() === "token") url.searchParams.delete(key);
  let transport;
  const token = role === "controller" ? discovery.controller_token : discovery.observer_token;
  try { transport = await webSocketTransport(url.toString(), ["zeta.v1", `zeta.bearer.${token}`]); }
  catch { throw new ZetaError("connect_failed"); }
  opened?.(() => transport.close());
  const client: ZetaClient = createClient(teeRunEnds(transport, () => client), undefined, (handshaken, code) => new ZetaError(handshaken ? "closed" : "connect_failed", code));
  try { const hello = await client.hello(FEATURES, role); negotiatedRequests.set(client, new Set(hello.capabilities?.requests ?? [])); }
  catch (error) {
    transport.close();
    const code = (error as { code?: unknown }).code;
    throw new ZetaError(code === -32001 ? "busy" : code === -32002 ? "version_mismatch" : "connect_failed", typeof code === "number" ? code : undefined);
  }
  return client;
}

/**
 * Finds the server through the dev-server handoff, connects, and reconnects with backoff after any failure or drop.
 * A fresh client per connection means a fresh store per session, so a reconnect rebuilds history instead of
 * appending to what the old socket left behind.
 */
export function createConnection({
  origin,
  readOnly,
  discover = async () => {
    const response = await fetch("/api/zeta/discovery", { headers: shellHeaders(), cache: "no-store" });
    if (response.ok) return await response.json();
    const start = (await response.json().catch(() => null))?.start;
    return typeof start === "string" ? { start } : null;
  },
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
  let start: string | null = null;
  let timer: unknown = null;
  let generation = 0;
  let stopped = false;
  let roleState = transitionRole({ role: "controller", reason: null }, readOnly ? "connect_read_only" : "connect_writable");
  let retainedObserver = false;
  let liveDiscovery: ZetaDiscovery | null = null;
  let takingControl = false;
  // `upgradable`: true from a successful takeControl until releaseControl, so a drop meanwhile reconnects as controller.
  let holding = false;
  const listeners = new Set<() => void>();
  const send = (event: ConnectionEvent) => {
    if (event.type !== "connected" && event.type !== "closed" && event.type !== "attempt") retainedObserver = false;
    const next = reduceConnection(state, event);
    if (next === state) return;
    state = next;
    if ("retryAt" in state) schedule(state.retryAt - now());
    listeners.forEach((listener) => listener());
  };
  const schedule = (ms: number) => {
    if (timer !== null) clearTimer(timer);
    timer = setTimer(() => { timer = null; void attempt(); }, Math.max(0, ms));
  };
  type OpenResult = { kind: "connected"; client: ZetaClient } | { kind: "busy" } | { kind: "unresponsive" } | { kind: "version_mismatch" } | { kind: "rejected" };
  const openRole = async (discovery: ZetaDiscovery, role: ZetaRole): Promise<OpenResult> => {
    let timedOut = false;
    let closePending = () => {};
    let connectTimeout: unknown = null;
    try {
      const opened = await Promise.race([
        connect(discovery, role, (close) => { closePending = close; }).then((value) => { if (timedOut) value.close(); return value; }),
        new Promise<never>((_, reject) => { connectTimeout = setTimer(() => { timedOut = true; closePending(); reject(new Error("hello timeout")); }, helloTimeoutMs); }),
      ]);
      return { kind: "connected", client: opened };
    } catch (error) {
      if (timedOut) return { kind: "unresponsive" };
      const kind = error instanceof ZetaError ? error.kind : "connect_failed";
      return { kind: kind === "busy" || kind === "version_mismatch" ? kind : "rejected" };
    } finally { if (connectTimeout !== null) clearTimer(connectTimeout); }
  };
  const negotiateRole = async (discovery: ZetaDiscovery, current: () => boolean) => {
    roleState = transitionRole(roleState, "retry");
    const first = roleState.role;
    const opened = await openRole(discovery, first);
    if (opened.kind !== "busy" || !current()) return { opened, authority: first };
    if (first === "observer") {
      roleState = transitionRole(roleState, "observer_busy");
      return { opened, authority: first };
    }
    // The fallback is provisional: only an accepted observer hello changes future retries.
    const authority = transitionRole(roleState, "controller_busy").role;
    const fallback = await openRole(discovery, authority);
    if (fallback.kind === "busy" && current() && roleState.role === first) roleState = transitionRole(roleState, "both_busy");
    return { opened: fallback, authority };
  };
  const adopt = (next: ZetaClient, discovery: ZetaDiscovery, authority: ZetaRole) => {
    const previous = client;
    client = next;
    liveDiscovery = discovery;
    roleState = transitionRole(roleState, authority === "controller" ? "controller_granted" : "observer_granted");
    previous?.close();
    (next as ZetaClient & { authority?: ZetaRole }).authority = authority;
    next.onClose(() => {
      if (client !== next) return;
      client = null;
      roleState = transitionRole(roleState, authority !== "controller" ? "retry" : readOnly === "upgradable" && !holding ? "control_released" : "controller_closed");
      send({ type: "closed", now: now() });
    });
    retainedObserver = authority === "observer";
    send({ type: "connected", authority });
  };
  const attempt = async () => {
    if (stopped || state.phase === "connected") return;
    const mine = ++generation;
    send({ type: "attempt" });
    const current = () => mine === generation && !stopped;
    let discovery: ZetaDiscovery | { start: string } | null;
    try {
      discovery = await discover();
    } catch {
      discovery = null; // the dev server itself is unreachable: same remedy as a stopped zeta
    }
    if (!current()) return;
    if (discovery && !("url" in discovery)) start = discovery.start;
    if (!discovery || !("url" in discovery)) return send({ type: "not_running", now: now() });
    port = Number(new URL(discovery.url).port) || port;
    // An origin the allowlist lacks fails at the upgrade with no detail, so name it before trying.
    if (discovery.origins.length && !discovery.origins.includes(origin))
      return send({ type: "auth_failed", reason: "origin", origins: discovery.origins, now: now() });
    const { opened, authority } = await negotiateRole(discovery, current);
    if (!current()) return opened.kind === "connected" ? opened.client.close() : undefined;
    if (opened.kind === "busy") return send({ type: authority === "observer" ? "observer_limit" : "controller_taken", now: now() });
    if (opened.kind === "unresponsive") return send({ type: "unresponsive", now: now() });
    // -32002 "protocol_mismatch": the only case that is a real version mismatch.
    if (opened.kind === "version_mismatch") return send({ type: "incompatible", now: now() });
    // The process runs and the origin is allowed, so a refused upgrade means the token was refused.
    if (opened.kind === "rejected") return send({ type: "auth_failed", reason: "rejected", origins: discovery.origins, now: now() });
    // A release during the hello makes this controller obsolete before it becomes visible to callers.
    if (authority === "controller" && readOnly === "upgradable" && !holding) {
      opened.client.close();
      void attempt();
      return;
    }
    adopt(opened.client, discovery, authority);
  };
  void attempt();
  const connection: Connection = {
    get state() { return state; },
    get client() { return client; },
    get startCommand() { return start ?? `zeta serve --ws ${port} --ws-origin ${origin}`; },
    get observerPresentation() { return retainedObserver; },
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    retryNow() {
      if (state.phase === "connected" || state.phase === "connecting" || stopped) return;
      if (timer !== null) { clearTimer(timer); timer = null; }
      void attempt();
    },
    async withControl(read) {
      if (takingControl) return { refused: transitionRole(roleState, "takeover_failed").reason! };
      const reason = await connection.takeControl();
      const controller = client;
      if (reason !== null || !controller || state.phase !== "connected" || state.authority !== "controller")
        return { refused: reason ?? transitionRole(roleState, "takeover_failed").reason! };
      holding = false; // a borrow, not a hold: a drop during the read reconnects as observer
      let limit: unknown = null;
      try {
        return { value: await Promise.race([read(controller), new Promise<never>((_, reject) => { limit = setTimer(() => reject(new NoAnswer("zeta did not answer")), BORROW_LIMIT_MS); })]) };
      } finally { if (limit !== null) clearTimer(limit); await connection.releaseControl(); }
    },
    async takeControl() {
      if (readOnly === "locked" || stopped || takingControl) return null;
      // the banner can show while the observer socket reconnects: a click then says so instead of doing nothing
      if (state.phase !== "connected" || state.authority !== "observer" || !client || !liveDiscovery) return transitionRole(roleState, "takeover_failed").reason;
      const observer = client;
      const discovery = liveDiscovery;
      takingControl = true;
      roleState = transitionRole(roleState, "retry");
      // Keep the live observer until a controller handshake actually succeeds.
      const opened = await openRole(discovery, "controller");
      takingControl = false;
      if (stopped || client !== observer) {
        if (opened.kind === "connected") opened.client.close();
        // the observer socket was replaced during the attempt: still say the click did not take control
        return stopped ? null : transitionRole(roleState, opened.kind === "busy" ? "takeover_refused" : "takeover_failed", now()).reason;
      }
      if (opened.kind !== "connected") {
        roleState = transitionRole(roleState, opened.kind === "busy" ? "takeover_refused" : "takeover_failed", now());
        return roleState.reason;
      }
      holding = true;
      adopt(opened.client, discovery, "controller");
      return null;
    },
    async releaseControl() {
      if (readOnly !== "upgradable") return;
      holding = false;
      roleState = transitionRole(roleState, "control_released");
      if (stopped || state.phase !== "connected" || state.authority !== "controller" || !client || !liveDiscovery) return;
      const controller = client;
      const discovery = liveDiscovery;
      const opened = await openRole(discovery, "observer");
      if (stopped || client !== controller || holding) {
        if (opened.kind === "connected") opened.client.close();
        return;
      }
      // without an observer slot, close the controller anyway: the reconnect opens as observer.
      if (opened.kind === "connected") adopt(opened.client, discovery, "observer");
      else controller.close();
    },
    stop() {
      stopped = true;
      generation++;
      if (timer !== null) clearTimer(timer);
      const open = client;
      client = null;
      open?.close();
    },
  };
  return connection;
}
