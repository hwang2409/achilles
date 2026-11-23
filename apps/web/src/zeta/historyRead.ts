import type { ZetaClient } from "@fulcrum/zeta";

export const HISTORY_READ_FEATURE = "session_history_read_v1";
export const rpcCode = (error: unknown) => (error as { code?: unknown } | null)?.code;

type Options = {
  signal?: AbortSignal;
  // Build demand can expire while a response or backoff is pending.
  current?: () => boolean;
  wanted?: () => boolean;
};

type Params = { session_id: string; limit: number; cursor?: string };
const owners = new WeakMap<ZetaClient, { tail?: Promise<void> }>();

/** Coordinates the serve's one cross-session history slot. No work starts without a caller. */
export function readOtherHistory(client: ZetaClient, params: Params, options: Options = {}): Promise<unknown> {
  const { signal, current = () => true, wanted = () => true } = options;
  let owner = owners.get(client);
  if (!owner) owners.set(client, owner = {});
  const read = async () => {
    for (let attempt = 1; ; attempt++) {
      signal?.throwIfAborted();
      if (!current()) throw new DOMException("superseded", "AbortError");
      try {
        // A caller leaving does not free the slot while the server is still reading.
        return await client.request("session_history_read", params, { timeoutMs: 12000 });
      } catch (error) {
        if (rpcCode(error) !== -32004 || !current()) throw error;
        const retry = (error as { data?: { retry_after_ms?: unknown } }).data?.retry_after_ms;
        const delay = typeof retry === "number" && Number.isFinite(retry) ? Math.max(2000, retry) : 2000;
        await new Promise<void>((resolve) => setTimeout(resolve, delay));
        signal?.throwIfAborted();
        if (attempt === 3) throw error;
        if (!current() || !wanted()) throw new DOMException("no longer wanted", "AbortError");
      }
    }
  };
  const result = owner.tail ? owner.tail.then(read) : read();
  const tail = result.then(() => {}, () => {});
  const slot = owner;
  slot.tail = tail;
  void tail.then(() => { if (slot.tail === tail) delete slot.tail; });
  return result;
}
