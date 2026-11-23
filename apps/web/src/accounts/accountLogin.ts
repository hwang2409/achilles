import type { ZetaClient } from "@fulcrum/zeta";
import type { Connection } from "../zeta";
import { readAccounts, safeAccountId, type AccountCatalog } from "../zeta/accounts";

export type LoginTarget = { provider: "claude" | "codex"; account?: string };
export const loginIdentity = ({ provider, account }: LoginTarget) => account ?? (provider === "claude" ? "anthropic:default" : "codex:default");

const failures = {
  login_timeout: "sign-in timed out.",
  login_lock_timeout: "the account was busy, so zeta could not save credentials.",
  login_save_failed: "zeta could not save credentials.",
  login_port_in_use: "the provider's callback port is busy. close any other sign-in for this provider.",
  login_callback_error: "the provider rejected sign-in or the browser callback was invalid.",
  login_failed: "zeta could not complete sign-in.",
} as const;

type Terminal =
  | { state: "succeeded" | "cancelled" | "idle" | "unknown" | "blocked" | "contention" }
  | { state: "failed"; detail: string };
type RefreshedCatalog = { client: ZetaClient; value: AccountCatalog };
type Login = { target: LoginTarget } & (
  | { state: "starting" | "pending" | "cancelling" | "settling" }
  | (Terminal & { at: Date })
);
type Popup = Pick<Window, "opener" | "closed" | "close"> & { location: Pick<Location, "replace"> };
type Attempt = {
  target: LoginTarget; popup: Popup | null; client: ZetaClient | null; timer?: ReturnType<typeof setTimeout>;
  unsubscribe?: () => void; abort: AbortController; settling?: boolean;
};
const record = (value: unknown) => value !== null && typeof value === "object" ? value as Record<string, unknown> : {};
function outcome(wire: unknown): Terminal | { state: "pending" } {
  const { state, error } = record(wire);
  if (state === "succeeded" || state === "cancelled" || state === "idle" || state === "pending") return { state };
  if (state === "failed") {
    const code = record(error).code;
    return { state, detail: typeof code === "string" && Object.hasOwn(failures, code)
      ? `${failures[code as keyof typeof failures]} (${code})` : failures.login_failed };
  }
  return { state: "unknown" };
}

function startFailure(error: unknown): Terminal {
  const { code, data } = record(error);
  if (code === -32005 && record(data).code === "login_in_progress") return { state: "contention" };
  if (code === -32602 || code === -32005 || code === -32008) return { state: "failed", detail: "zeta did not accept the sign-in request." };
  return { state: "unknown" };
}

function sendToPopup(popup: Popup, wire: unknown): boolean {
  const value = record(wire).authorization_url;
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || popup.closed) return false;
    popup.location.replace(url.href);
    return true;
  } catch { return false; }
}

export function createAccountLogin(
  connection: Pick<Connection, "client" | "state" | "takeControl" | "releaseControl">,
  open: () => Popup | null = () => window.open("about:blank", "_blank"),
  pollMs = 750,
) {
  let snapshot: Login | null = null;
  let refreshed: RefreshedCatalog | null = null;
  const listeners = new Set<() => void>();
  const publish = (next: Login) => { snapshot = next; listeners.forEach(listener => listener()); };
  let active: Attempt | null = null;
  const closePopup = (attempt: Attempt) => {
    try { attempt.popup?.close(); } catch { /* The browser may have already closed the tab. */ }
    attempt.popup = null;
  };
  const clean = (attempt: Attempt) => {
    clearTimeout(attempt.timer);
    attempt.unsubscribe?.();
    attempt.abort.abort();
    closePopup(attempt);
  };
  const options = (attempt: Attempt) => ({ signal: attempt.abort.signal, timeoutMs: 20_000 });
  const rpc = (attempt: Attempt, method: "login_status" | "login_cancel") => attempt.client!.request(method, { provider: attempt.target.provider }, options(attempt));

  async function settle(attempt: Attempt, result: Terminal, reread = true) {
    if (active !== attempt || attempt.settling) return;
    attempt.settling = true;
    clearTimeout(attempt.timer);
    attempt.unsubscribe?.();
    closePopup(attempt);
    const at = new Date();
    const controller = attempt.client;
    let catalog: AccountCatalog | null = null;
    if (controller) {
      publish({ state: "settling", target: attempt.target });
      try {
        if (reread && connection.client === controller) catalog = await readAccounts(controller, undefined, options(attempt));
      } catch { /* The receipt is independent of whether the catalog could be refreshed. */ }
      attempt.abort.abort();
      await connection.releaseControl();
    }
    if (active !== attempt) return;
    active = null;
    if (catalog && connection.client) refreshed = { client: connection.client, value: catalog };
    publish({ ...result, target: attempt.target, at });
  }

  async function cancelAttempt(attempt: Attempt, popupFailed = false) {
    clearTimeout(attempt.timer);
    publish({ state: "cancelling", target: attempt.target });
    try {
      const result = outcome(await rpc(attempt, "login_cancel"));
      await settle(attempt, result.state === "pending" ? { state: "unknown" }
        : popupFailed && result.state === "cancelled" ? { state: "blocked" } : result);
    } catch {
      // Read the same connection's result, never send a second cancel to check it.
      if (!attempt.settling && active === attempt) await poll(attempt, { popupFailed });
    }
  }

  async function poll(attempt: Attempt, checkingCancel?: { popupFailed: boolean }) {
    try {
      const result = outcome(await rpc(attempt, "login_status"));
      if (active !== attempt || attempt.settling || (!checkingCancel && snapshot?.state !== "pending")) return;
      if (result.state === "pending") {
        if (checkingCancel?.popupFailed) return await settle(attempt, { state: "unknown" }, false);
        if (checkingCancel) publish({ state: "pending", target: attempt.target });
        schedule(attempt);
      } else await settle(attempt, checkingCancel?.popupFailed && result.state === "cancelled" ? { state: "blocked" } : result, result.state !== "unknown");
    } catch {
      if (checkingCancel || snapshot?.state === "pending") await settle(attempt, { state: "unknown" }, false);
    }
  }
  const schedule = (attempt: Attempt) => { attempt.timer = setTimeout(() => void poll(attempt), pollMs); };

  async function dispatchStart(attempt: Attempt) {
    const { target } = attempt;
    let result: Terminal | { state: "pending" };
    try {
      const wire: unknown = await attempt.client!.request("login_start", target, options(attempt));
      if (active !== attempt || attempt.settling) return;
      result = outcome(wire);
      if (result.state === "pending") {
        if (!sendToPopup(attempt.popup!, wire)) return await cancelAttempt(attempt, true);
        // The detached provider tab is no longer ours to close.
        attempt.popup = null;
      }
    } catch (error) {
      if (active !== attempt || attempt.settling) return;
      result = startFailure(error);
    }
    if (result.state !== "pending") return await settle(attempt, result, result.state !== "unknown");
    publish({ state: "pending", target });
    schedule(attempt);
  }

  return {
    snapshot: () => snapshot,
    catalog: () => refreshed,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    async start({ provider, account }: LoginTarget) {
      if (active || (provider !== "claude" && provider !== "codex")) return;
      const target = account === undefined ? { provider } : { provider, account };
      // The catalog supplies named targets; copy only the validated identity to this attempt.
      const identity = loginIdentity(target);
      if (!safeAccountId(identity) || !identity.startsWith(provider === "claude" ? "anthropic:" : "codex:")) return;
      const attempt: Attempt = { target, popup: null, client: null, abort: new AbortController() };
      active = attempt;
      try {
        attempt.popup = open();
        if (!attempt.popup || attempt.popup.closed) return await settle(attempt, { state: "blocked" });
        attempt.popup.opener = null;
      } catch { return await settle(attempt, { state: "blocked" }); }
      publish({ state: "starting", target });
      const refusal = await connection.takeControl();
      if (active !== attempt) {
        if (!refusal && connection.state.phase === "connected" && connection.state.authority === "controller") await connection.releaseControl();
        return;
      }
      if (refusal) return await settle(attempt, { state: "failed", detail: refusal });
      const client = connection.client;
      if (!client || connection.state.phase !== "connected" || connection.state.authority !== "controller") return await settle(attempt, { state: "unknown" });
      attempt.client = client;
      attempt.unsubscribe = client.onClose(() => void settle(attempt, { state: "unknown" }, false));
      await dispatchStart(attempt);
    },
    async cancel() { if (active && snapshot?.state === "pending") await cancelAttempt(active); },
    stop() { if (active) clean(active); active = null; },
  };
}
