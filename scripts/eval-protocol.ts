export const REQUIRED_FEATURES = ["session_cwd", "session_mcp_bindings", "new_session_settings", "approval_history", "session_history_fidelity", "served_turn_end", "delivery_id", "user_message_event"] as const;

type EventHandler = (event: Record<string, unknown>) => void;
type Rpc = { id?: number; result?: any; error?: { message?: string; code?: number }; method?: string; params?: any };

class Client implements EvalProtocol {
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private socket: WebSocket;
  constructor(socket: WebSocket, private onEvent?: EventHandler) {
    this.socket = socket;
    socket.onmessage = (message) => {
      let value: Rpc;
      try { value = JSON.parse(String(message.data)); } catch { return; }
      if (value.id !== undefined) {
        const waiter = this.pending.get(value.id); if (!waiter) return;
        this.pending.delete(value.id);
        value.error ? waiter.reject(new Error(value.error.message ?? `zeta rpc error ${value.error.code ?? ""}`)) : waiter.resolve(value.result);
      } else if (value.method) this.onEvent?.(value as Record<string, unknown>);
    };
    socket.onerror = () => this.rejectAll(new Error("zeta websocket failed"));
    socket.onclose = () => this.rejectAll(new Error("zeta websocket closed"));
  }
  private rejectAll(error: Error) { for (const waiter of this.pending.values()) waiter.reject(error); this.pending.clear(); }
  request(method: string, params: Record<string, unknown> = {}): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.socket.send(JSON.stringify({ id, method, params })); });
  }
  hello(features: string[]) { return this.request("hello", { features, role: "controller" }); }
  newSession(params: Record<string, unknown>) { return this.request("new_session", params); }
  async send(sessionId: string, text: string, deliveryId = crypto.randomUUID()) { await this.request("send", { session_id: sessionId, text, delivery_id: deliveryId }); }
  async approve(sessionId: string, requestId: string) { await this.request("approve", { session_id: sessionId, request_id: requestId, scope: "once" }); }
  async resume(sessionId: string) { await this.request("resume", { session_id: sessionId }); }
  async sessionHistory(sessionId: string) {
    const rows: unknown[] = []; let offset = 0;
    for (;;) { const page = await this.request("session_history", { session_id: sessionId, offset }); rows.push(...(page?.messages ?? [])); if (page?.next_offset == null) return rows; offset = page.next_offset; }
  }
  close() { this.socket.close(); this.rejectAll(new Error("protocol closed")); }
}

export type EvalProtocol = {
  hello(features: string[]): Promise<unknown>;
  newSession(params: Record<string, unknown>): Promise<Record<string, unknown>>;
  send(sessionId: string, text: string, deliveryId?: string): Promise<void>;
  approve(sessionId: string, requestId: string): Promise<void>;
  resume(sessionId: string): Promise<void>;
  sessionHistory(sessionId: string): Promise<unknown[]>;
  close(): void;
};

export async function connectEvalProtocol(discovery: { url: string; controller_token: string }, onEvent?: EventHandler): Promise<EvalProtocol> {
  const url = new URL(discovery.url); for (const key of [...url.searchParams.keys()]) url.searchParams.delete(key);
  const socket = new WebSocket(url, ["zeta.v1", `zeta.bearer.${discovery.controller_token}`]);
  await new Promise<void>((resolve, reject) => { const timer = setTimeout(() => reject(new Error("zeta hello timeout")), 15_000); socket.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true }); socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("zeta websocket failed")); }, { once: true }); });
  const client = new Client(socket, onEvent); await client.hello([...REQUIRED_FEATURES]); return client;
}

export function reserveTurns(tasks: Array<{ agent_turns: number; judge_turns?: number }>, repeats: number) { return repeats * tasks.reduce((total, task) => total + task.agent_turns + (task.judge_turns ?? 0), 0); }
export function assertTurnBudget(reserved: number, max = 240) { if (!Number.isInteger(reserved) || reserved < 0 || reserved > max) throw new Error(`reserved model turns ${reserved} exceed command budget ${max}`); }

export function enforceTurnBudget(limit: number, abort: () => Promise<void>, onTurn?: (count: number) => void) {
  let count = 0; let stopped = false;
  return async (event: Record<string, unknown>) => { if (event.method !== "turn_start" || stopped) return; count += 1; onTurn?.(count); if (count > limit) { stopped = true; await abort(); throw new Error("task model turn limit exceeded"); } };
}
