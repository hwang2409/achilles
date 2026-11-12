// adapted from gamma@6cd69671 src/approvals.ts
export type ApprovalMethod = "approve" | "deny";
export type ApprovalStore = {
  getState(): { outline: readonly { id: string }[] };
  getItem(id: string): unknown;
};
type WritableApprovalStore = ApprovalStore & {
  dispatch(event: { type: "approval_end"; request_id: string; data: { decision: "allow" | "deny" } }): void;
};
export type ApprovalClient = {
  request(method: ApprovalMethod, params: Record<string, unknown>, options: { timeoutMs: number }): Promise<unknown>;
};

type ApprovalItem = { type: "approval"; ended: boolean; request: { type: "approval_request"; request_id: string; tool_call?: { id: string; name?: string } } };

export function pendingApprovals(store: ApprovalStore): ApprovalItem[] {
  return store.getState().outline.flatMap(({ id }) => {
    const item = store.getItem(id) as ApprovalItem | undefined;
    return item?.type === "approval" && item.request.type === "approval_request" && !item.ended ? [item] : [];
  });
}

export function createApprovalDecider(client: ApprovalClient, store: WritableApprovalStore) {
  return async (method: ApprovalMethod, requestId: string, always = false) => {
    try {
      const result = await client.request(method, { request_id: requestId, ...(always ? { scope: "always_tool" } : {}) }, { timeoutMs: 15_000 });
      store.dispatch({ type: "approval_end", request_id: requestId, data: { decision: method === "approve" ? "allow" : "deny" } });
      return result;
    } catch (error) {
      if ((error as { code?: unknown }).code === -32006) throw new Error("this approval expired while you were disconnected");
      throw error;
    }
  };
}
