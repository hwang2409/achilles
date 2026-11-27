import type { ZetaClient } from "@fulcrum/zeta";
import { reviewText, type Result, type ReviewText } from "../surface/Confirmation";
import { readAccounts, safeAccountId, supportsRequest, type Account, type Connection } from "../zeta";

export type ChatDestination = { id: string; title: string };
export type SwitchTarget = { chat: ChatDestination; from: string | null; to: string; onCatalog?(rows: Account[]): void };
type SwitchResult = Result<{ status: "committed"; receipt: ReviewText }>;
const UNKNOWN = { status: "unknown" } as const;
const CHANGED = { status: "failed", reason: "changed", final: true } as const;
const options = { timeoutMs: 5_000 };
const provider = (id: string) => id.split(":", 1)[0];
export const currentAccount = (rows: Account[], to: string) => rows.find(row => row.current && provider(row.account) === provider(to))?.account ?? null;

export async function activeAccountChat(client: ZetaClient): Promise<ChatDestination | null> {
  const status = await client.request("status", {}, options) as { session?: { session_id?: unknown; name?: unknown } | null };
  const session = status?.session;
  if (!session || typeof session.session_id !== "string" || !session.session_id) return null;
  return { id: session.session_id, title: typeof session.name === "string" && session.name.trim() ? session.name : session.session_id };
}

export function createAccountSwitch(connection: Pick<Connection, "client" | "state" | "subscribe">) {
  const live = () => connection.state.phase === "connected" && connection.state.authority === "controller" ? connection.client : null;
  function waitForController() {
    return new Promise<ZetaClient | null>(resolve => {
      const finish = (client: ZetaClient | null) => { clearTimeout(timer); unsubscribe(); resolve(client); };
      const check = () => { const client = live(); if (client) finish(client); };
      const unsubscribe = connection.subscribe(check);
      const timer = setTimeout(() => finish(null), options.timeoutMs);
      check();
    });
  }
  return ({ chat, from, to, onCatalog }: SwitchTarget) => {
    // Bind writes and reads to the reviewed chat, not whichever chat happens to be active later.
    const read = async (client: ZetaClient) => {
      if ((await activeAccountChat(client))?.id !== chat.id) return null;
      const rows = (await readAccounts(client, chat.id, options)).accounts;
      return live() === client && (await activeAccountChat(client))?.id === chat.id ? rows : null;
    };
    const receipt = (checked = false): SwitchResult => ({ status: "committed", receipt:
      `${chat.title}: ${checked ? "current account confirmed as" : "switched to"} ${to}. the failed request was not retried.` as ReviewText });
    let catalog: Account[] | null = null;
    // a new socket has no chat until the chat tab resumes it again: wait for that before reading.
    const reattached = async (client: ZetaClient) => {
      const deadline = Date.now() + options.timeoutMs;
      while (live() === client && Date.now() < deadline) {
        if ((await activeAccountChat(client))?.id === chat.id) return client;
        await new Promise(resolve => setTimeout(resolve, 200));
      }
      return null;
    };
    const settle = async (): Promise<SwitchResult> => {
      const controller = await waitForController();
      const client = controller && await reattached(controller).catch(() => null);
      const rows = client && await read(client).catch(() => null);
      if (!rows) return UNKNOWN;
      catalog = rows;
      return currentAccount(rows, to) === to ? receipt(true) : UNKNOWN;
    };
    const withController = async (run: (client: ZetaClient) => Promise<SwitchResult>): Promise<SwitchResult> => {
      const client = live();
      if (!client) return { status: "failed", reason: "refused", final: true, message: reviewText("not changed. this tab does not control zeta.") };
      try { return await run(client); }
      finally { if (catalog) { onCatalog?.(catalog); catalog = null; } }
    };
    let sent = false;
    return {
      async execute(): Promise<SwitchResult> {
        if (sent || !safeAccountId(to) || (from && !safeAccountId(from))) return CHANGED;
        return withController(async client => {
          if (!supportsRequest(client, "account_switch")) return CHANGED;
          const rows = await read(client).catch(() => null);
          if (!rows || live() !== client || currentAccount(rows, to) !== from || !rows.some(row => row.account === to && row.available && !row.current)) return CHANGED;
          sent = true;
          try {
            const reply = await client.request("account_switch", { session_id: chat.id, account: to }, options) as { account?: unknown; replay?: unknown; account_state?: unknown } | null;
            if (reply?.account === to && reply.replay === false && reply.account_state !== "unknown") {
              const latest = await read(client).catch(() => null);
              catalog = latest;
              return receipt();
            }
          } catch (error) {
            const code = (error as { code?: unknown } | null)?.code;
            if (code === -32004) {
              sent = false;
              return { status: "failed", reason: "not-applied", message: reviewText("not changed. zeta is busy. try again when the chats finish.") };
            }
            if (code === -32003 || code === -32602 || code === -32601) return CHANGED;
            if (code === -32008) return { status: "failed", reason: "denied", final: true };
          }
          return settle();
        });
      },
      async checkResult(): Promise<SwitchResult> {
        if (!sent) return UNKNOWN;
        // A refused read does not tell us whether the earlier write applied.
        const result = await withController(settle);
        return result.status === "failed" ? UNKNOWN : result;
      },
    };
  };
}
