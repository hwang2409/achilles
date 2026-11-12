import { describe, expect, test } from "bun:test";
import { loadSession } from "./session";

describe("loadSession", () => {
  test("reconciles a tail event that arrives during refresh", async () => {
    let revision = 0;
    let historyRequests = 0;
    const snapshots: unknown[][] = [];
    const client = {
      request: async (method: string) => {
        if (method === "status") return { session: { session_id: "s" }, state: "idle" };
        historyRequests += 1;
        if (historyRequests === 2) revision += 1;
        return { messages: historyRequests > 2 ? [{ role: "assistant", content: "later" }] : [], next_offset: null };
      },
      replay: async (_id: string, refresh: (signal: AbortSignal) => Promise<unknown[]>) => {
        revision = 1;
        await refresh(new AbortController().signal);
        return { store: { resync: (events: unknown[]) => snapshots.push(events) }, release() {} };
      },
      replayRevision: () => revision,
      finishReplay: (_id: string, expected: number) => expected === revision,
    };
    const lease = await loadSession(client as never, "s");
    expect(historyRequests).toBe(3);
    expect(snapshots.at(-1)).toBeDefined();
    expect(lease.store).toBeDefined();
  });
});
