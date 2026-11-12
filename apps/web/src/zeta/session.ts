import { fromZetaHistory } from "@fulcrum/zeta";
import type { ZetaClient } from "@fulcrum/zeta";

export async function openHomeSession(client: ZetaClient, storedId: string | null) {
  let id = storedId;
  if (id) {
    try { await client.request("resume", { session_id: id }); }
    catch (error) {
      const rpc = error as { data?: { code?: unknown } };
      if (rpc.data?.code !== "session_not_found") throw error;
      id = null;
    }
  }
  if (!id) {
    const created = await client.request("new_session", {}) as { session?: { session_id?: string } };
    id = created.session?.session_id ?? null;
    if (!id) throw new Error("zeta did not return a session id");
  }
  return id;
}

export async function loadSession(client: ZetaClient, id: string) {
  return client.replay(id, async () => {
    const page = await client.request("session_history", { session_id: id, offset: 0 }) as { messages?: unknown[] };
    return fromZetaHistory(page.messages ?? []);
  });
}
