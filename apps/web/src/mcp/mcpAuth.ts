import type { ZetaClient } from "@fulcrum/zeta";
import type { McpOutcome } from "./mcpOwner";
import type { McpRow } from "./mcpReads";

export const authMethods = { start: "mcp_auth_start", cancel: "mcp_auth_cancel", logout: "mcp_auth_logout", status: "mcp_auth_status" } as const;
export type AuthAction = Exclude<keyof typeof authMethods, "status">;
type Target = Pick<McpRow, "name" | "scope">;
export type AuthAttempt = Target & { action: AuthAction };
type State = "idle" | "pending" | "succeeded" | "failed" | "cancelled";
type Report = Target & { state: State | "unknown" | "unauthorized" };
export type AuthOutcome = McpOutcome | { status: "auth"; state: State | "unauthorized" } | { status: "popup-blocked" };
type Popup = Pick<Window, "opener" | "closed" | "close"> & { location: Pick<Location, "replace"> };
const UNKNOWN = { status: "unknown" } as const;
const PAUSES = [1_000, 2_000, 5_000] as const;
const clock = {
  set: (run: () => void, ms: number) => setTimeout(run, ms),
  clear: (timer: ReturnType<typeof setTimeout>) => clearTimeout(timer),
};

function stateOf(data: { state?: unknown } | undefined): State | null {
  switch (data?.state) {
    case "idle": case "pending": case "succeeded": case "failed": case "cancelled": return data.state;
    default: return null;
  }
}

function openPopup(open: () => Popup | null) {
  try {
    const popup = open();
    if (popup) popup.opener = null;
    return popup;
  } catch { return null; }
}

function launch(popup: Popup, url: unknown) {
  if (typeof url !== "string" || !/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}\/launch\/[A-Za-z0-9_-]+$/.test(url)) return false;
  try {
    if (popup.closed) return false;
    popup.location.replace(url);
    return true;
  } catch { return false; }
}

export function createMcpAuth({ withControl, supports, failure, liveObserver, open = () => window.open("about:blank", "_blank"), timers = clock }: {
  withControl: (signal: AbortSignal, send: (client: ZetaClient) => Promise<AuthOutcome>) => Promise<AuthOutcome>;
  liveObserver: () => ZetaClient | null;
  supports: (client: ZetaClient, method: string) => boolean;
  failure: (error: unknown) => McpOutcome | null;
  open?: () => Popup | null;
  timers?: typeof clock;
}) {
  let report: (Report & { tracking: boolean }) | null = null;
  let tracking = false;
  let seenPending = false;
  let writing = false;
  let observer: ZetaClient | null = null;
  let visible = false;
  let epoch = 0;
  let step = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let reading: Promise<State | null> | null = null;
  const listeners = new Set<() => void>();
  const results = new WeakMap<AuthAttempt, AuthOutcome>();
  const publish = (next: Report | null) => {
    if (next?.state === report?.state && next?.name === report?.name && next?.scope === report?.scope && (next === null || tracking === report?.tracking)) return;
    report = next ? { ...next, tracking } : null;
    listeners.forEach((listener) => listener());
  };

  function stopTimer() {
    if (timer !== undefined) timers.clear(timer);
    timer = undefined;
  }
  function resetReads() {
    stopTimer();
    epoch++;
    step = 0;
  }
  const canPoll = () => visible && observer && !writing && tracking;
  function schedule(immediate = false) {
    if (!canPoll() || timer !== undefined) return;
    timer = timers.set(() => {
      timer = undefined;
      void checkNow();
    }, immediate ? 0 : PAUSES[Math.min(step++, PAUSES.length - 1)]!);
  }
  function projectRead(target: Target, state: State | null) {
    if (!state) { publish({ ...target, state: "unknown" }); return; }
    if (state === "pending") seenPending = true;
    else tracking = false;
    // Status has no attempt ID. Without a pending receipt a terminal state can be from an older start.
    publish({ ...target, state: seenPending || state === "idle" ? state : "unknown" });
  }
  async function read(client: ZetaClient, target: Target, started: number) {
    let state: State | null = null;
    try {
      const wire = await client.request(authMethods.status, { name: target.name }, { timeoutMs: 5_000 });
      state = stateOf((wire as { data?: { state?: unknown } } | null)?.data);
    } catch { /* A read cannot establish whether the provider saved a credential. */ }
    if (started !== epoch || client !== liveObserver()) return null;
    projectRead(target, state);
    return state;
  }
  function checkNow(): Promise<State | null> {
    const client = liveObserver();
    if (!client || !report || writing || !tracking || !supports(client, authMethods.status)) return Promise.resolve(null);
    if (reading) return reading;
    stopTimer();
    const started = epoch;
    reading = read(client, { name: report.name, scope: report.scope }, started).finally(() => {
      reading = null;
      schedule(started !== epoch);
    });
    return reading;
  }
  function observe(client: ZetaClient | null, shown: boolean, connected: boolean) {
    if (!connected && !tracking && !writing) publish(null);
    if (observer === client && visible === shown) return;
    observer = client;
    visible = shown;
    resetReads();
    if (!reading) schedule(true);
  }

  async function send(client: ZetaClient, attempt: AuthAttempt, popup: Popup | null): Promise<AuthOutcome> {
    const { action, name, scope } = attempt;
    const method = authMethods[action];
    if (!supports(client, method)) return { status: "unsupported" };
    try {
      const wire = await client.request(method, action === "cancel" ? { name } : { name, scope }, { timeoutMs: 20_000 });
      const data = (wire as { data?: { state?: unknown; authorization_url?: unknown } } | null)?.data;
      if (action === "logout") return data?.state === "unauthorized" ? { status: "auth", state: "unauthorized" } : UNKNOWN;
      const state = stateOf(data);
      if (!state) return UNKNOWN;
      if (state === "pending" && popup && !launch(popup, data?.authorization_url)) return { status: "popup-blocked" };
      return { status: "auth", state };
    } catch (error) { return failure(error) ?? UNKNOWN; }
  }

  function apply({ action, name, scope }: AuthAttempt, outcome: AuthOutcome) {
    const target = { name, scope };
    if (outcome.status === "auth") {
      seenPending = outcome.state === "pending";
      tracking = seenPending;
      publish({ ...target, state: outcome.state });
    } else if (outcome.status === "unknown" || outcome.status === "popup-blocked") {
      if (action === "logout" && report?.name !== name) return;
      if (action === "start") seenPending = outcome.status === "popup-blocked";
      tracking = action !== "logout";
      publish({ ...target, state: "unknown" });
    }
  }

  async function settle({ action, name, scope }: AuthAttempt): Promise<AuthOutcome> {
    if (action === "logout" || report?.name !== name || report.scope !== scope) return UNKNOWN;
    const state = await checkNow();
    const known = state ?? report?.state;
    if (!seenPending || !known || known === "idle" || known === "unknown" || known === "unauthorized") return UNKNOWN;
    if (action === "cancel" && known === "pending") return UNKNOWN;
    return { status: "auth", state: known };
  }

  function allowed({ action, name, scope }: AuthAttempt) {
    const same = report?.name === name && report.scope === scope;
    if (action === "start") return !tracking;
    if (action === "cancel") return tracking && same;
    return !tracking || report?.name !== name || same;
  }

  async function execute(attempt: AuthAttempt, signal: AbortSignal): Promise<AuthOutcome> {
    if (!allowed(attempt)) return { status: "busy" };
    const popup = attempt.action === "start" ? openPopup(open) : null;
    if (attempt.action === "start" && !popup) return { status: "popup-blocked" };
    writing = true;
    let outcome: AuthOutcome = UNKNOWN;
    try {
      resetReads();
      outcome = await withControl(signal, (client) => send(client, attempt, popup));
    } finally {
      if (outcome.status !== "auth" || outcome.state !== "pending") {
        try { popup?.close(); } catch { /* The popup may already be gone. */ }
      }
      writing = false;
      apply(attempt, outcome);
      if (!reading) schedule(true);
    }
    return outcome.status === "unknown" ? settle(attempt) : outcome;
  }

  return {
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    snapshot: () => report,
    observe,
    checkNow,
    async run(attempt: AuthAttempt, check: boolean, signal: AbortSignal) {
      const prior = results.get(attempt);
      const outcome = check && prior?.status === "unknown" ? await settle(attempt) : prior ?? (check ? UNKNOWN : await execute(attempt, signal));
      results.set(attempt, outcome);
      return outcome;
    },
  };
}
