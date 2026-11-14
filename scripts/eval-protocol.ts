export const REQUIRED_FEATURES = ["session_cwd", "session_mcp_bindings", "new_session_settings", "approval_history", "session_history_fidelity", "served_turn_end", "delivery_id", "user_message_event"] as const;

const RPC_TIMEOUT_MS = 15_000;
const CONNECTION_CAPACITY = -32001;
const RECONNECT_DELAYS_MS = [50, 100, 200, 400, 800, 1_600, 1_850] as const;
type EventHandler = (event: Record<string, any>) => void;
type Rpc = { id?: number; result?: any; error?: { message?: string; code?: number }; method?: string; params?: any };
type ConnectOptions = { retryCapacity?: boolean; wait?: (delayMs: number, signal?: AbortSignal) => Promise<void>; signal?: AbortSignal };

class Client implements EvalProtocol {
  private nextId = 1;
  private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout>; method: string }>();
  private closed: Promise<void>;
  constructor(private socket: WebSocket, private onEvent?: EventHandler) {
    this.closed = new Promise(resolve => socket.addEventListener("close", () => resolve(), { once: true }));
    socket.onmessage = (message) => {
      let value: Rpc;
      try { value = JSON.parse(String(message.data)); } catch { return; }
      if (value.id !== undefined) {
        const waiter = this.pending.get(value.id); if (!waiter) return;
        clearTimeout(waiter.timer); this.pending.delete(value.id);
        if (value.error) {
          const error = new Error(value.error.message ?? `zeta rpc error ${value.error.code ?? ""}`) as Error & { code?: number; method?: string };
          error.code = value.error.code; error.method = waiter.method;
          waiter.reject(error);
        } else waiter.resolve(value.result);
      } else if (value.method === "event" && value.params) this.onEvent?.(value.params as Record<string, any>);
    };
    socket.onerror = () => this.rejectAll(new Error("zeta websocket failed"));
    socket.onclose = () => this.rejectAll(new Error("zeta websocket closed"));
  }
  private rejectAll(error: Error) { for (const waiter of this.pending.values()) { clearTimeout(waiter.timer); waiter.reject(error); } this.pending.clear(); }
  request(method: string, params: Record<string, unknown> = {}, timeoutMs = RPC_TIMEOUT_MS): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`zeta ${method} timed out`)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      this.socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    });
  }
  hello(features: string[]) { return this.request("hello", { protocol_version: "1.1", client_version: "1.1", features, role: "controller" }); }
  newSession(params: Record<string, unknown>) { return this.request("new_session", params); }
  async send(sessionId: string, text: string, deliveryId = crypto.randomUUID()) { await this.request("send", { session_id: sessionId, text, delivery_id: deliveryId }); }
  async approve(sessionId: string, requestId: string) { await this.request("approve", { session_id: sessionId, request_id: requestId, scope: "once" }); }
  async abort(sessionId: string) { await this.request("abort", { session_id: sessionId }); }
  async resume(sessionId: string, binding: Record<string, unknown>) { return this.request("resume", { session_id: sessionId, ...binding }); }
  async sessionHistory(sessionId: string) {
    const rows: unknown[] = []; let offset = 0;
    for (;;) { const page = await this.request("session_history", { session_id: sessionId, offset }); rows.push(...(page?.messages ?? [])); if (page?.next_offset == null) return rows; offset = page.next_offset; }
  }
  async close(signal?: AbortSignal, timeoutMs = 5_000) {
    if (this.socket.readyState === WebSocket.CLOSED) return;
    if (this.socket.readyState < WebSocket.CLOSING) this.socket.close();
    try { await withDeadline(this.closed, "zeta websocket close", timeoutMs, signal); }
    catch (error) {
      // Forced cleanup must not replace the close timeout or cancellation.
      try { this.socket.terminate(); } catch {}
      try { await withDeadline(this.closed, "zeta websocket termination", timeoutMs); } catch {}
      throw error;
    }
  }
}

export type EvalProtocol = {
  newSession(params: Record<string, unknown>): Promise<Record<string, any>>;
  send(sessionId: string, text: string, deliveryId?: string): Promise<void>;
  approve(sessionId: string, requestId: string): Promise<void>;
  abort(sessionId: string): Promise<void>;
  resume(sessionId: string, binding: Record<string, unknown>): Promise<{ session?: { session_id?: string }; session_id?: string }>;
  sessionHistory(sessionId: string): Promise<unknown[]>;
  close(signal?: AbortSignal, timeoutMs?: number): Promise<void>;
};

async function withDeadline<T>(work: Promise<T>, label: string, timeoutMs = RPC_TIMEOUT_MS, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted();
  let timer: ReturnType<typeof setTimeout> | undefined; let abort: (() => void) | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs); }),
      ...(signal ? [new Promise<never>((_, reject) => { abort = () => reject(signal.reason); signal.addEventListener("abort", abort, { once: true }); })] : []),
    ]);
  } finally { clearTimeout(timer); if (abort) signal?.removeEventListener("abort", abort); }
}

async function connectOnce(discovery: { url: string; controller_token: string }, onEvent?: EventHandler, signal?: AbortSignal): Promise<EvalProtocol> {
  signal?.throwIfAborted();
  const url = new URL(discovery.url); for (const key of [...url.searchParams.keys()]) url.searchParams.delete(key);
  const socket = new WebSocket(url, ["zeta.v1", `zeta.bearer.${discovery.controller_token}`]);
  try {
    await withDeadline(new Promise<void>((resolve, reject) => {
      const abort = () => { socket.close(); reject(signal!.reason); };
      signal?.addEventListener("abort", abort, { once: true });
      socket.addEventListener("open", () => { signal?.removeEventListener("abort", abort); resolve(); }, { once: true });
      socket.addEventListener("error", () => { signal?.removeEventListener("abort", abort); reject(new Error("zeta websocket failed")); }, { once: true });
    }), "zeta websocket open");
    signal?.throwIfAborted();
  } catch (error) { socket.close(); throw error; }
  const client = new Client(socket, onEvent);
  try {
    const hello = await Promise.race([
      client.hello([...REQUIRED_FEATURES]),
      ...(signal ? [new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }))] : []),
    ]) as { capabilities?: { features?: unknown } };
    const accepted = hello.capabilities?.features;
    signal?.throwIfAborted();
    if (!Array.isArray(accepted)) throw new Error("zeta hello omitted negotiated features");
    const missing = REQUIRED_FEATURES.filter(feature => !accepted.includes(feature));
    if (missing.length) throw new Error(`zeta lacks required features: ${missing.join(", ")}`);
    return client;
  } catch (error) { await client.close(); throw error; }
}

async function waitForDelay(wait: (delayMs: number, signal?: AbortSignal) => Promise<void>, delayMs: number, signal?: AbortSignal) {
  if (!signal) return wait(delayMs);
  signal.throwIfAborted();
  await Promise.race([
    wait(delayMs, signal),
    new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })),
  ]);
  signal.throwIfAborted();
}

export async function connectEvalProtocol(discovery: { url: string; controller_token: string }, onEvent?: EventHandler, options: ConnectOptions = {}): Promise<EvalProtocol> {
  const wait = options.wait ?? (delayMs => Bun.sleep(delayMs));
  let firstCapacityError: unknown;
  for (const delayMs of [0, ...(options.retryCapacity ? RECONNECT_DELAYS_MS : [])]) {
    if (delayMs) await waitForDelay(wait, delayMs, options.signal);
    else options.signal?.throwIfAborted();
    try { return await connectOnce(discovery, onEvent, options.signal); }
    catch (error) {
      if ((error as { code?: unknown }).code !== CONNECTION_CAPACITY) throw error;
      firstCapacityError ??= error;
    }
  }
  throw firstCapacityError;
}

export function reserveTurns(tasks: Array<{ agent_turns: number }>, repeats: number) { return repeats * tasks.reduce((total, task) => total + task.agent_turns, 0); }
export function assertTurnBudget(reserved: number, max = 240) { if (!Number.isInteger(reserved) || reserved < 0 || reserved > max) throw new Error(`reserved model turns ${reserved} exceed command budget ${max}`); }

export function enforceTurnBudget(limit: number, abort: () => Promise<void>, onTurn?: (count: number) => void) {
  let count = 0; let stopped = false;
  return async (event: Record<string, unknown>) => {
    if (event.event !== "turn_start" || stopped) return;
    count += 1; onTurn?.(count);
    if (count > limit) { stopped = true; await abort(); throw new Error("task model turn limit exceeded"); }
  };
}
