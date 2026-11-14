import type { ZetaClient } from "@fulcrum/zeta";
import { applyApprovalMode } from "./zeta/session";

const STORAGE_KEY = "achilles-pending-chats";
const stages = ["created", "registered", "approvalApplied"] as const;
type Stage = typeof stages[number];

export type PendingChat = { sessionId: string; pageId: string; mode: "ask" | "allow"; stage: Stage };
export type ChatCreationInput = { client: ZetaClient; pageId: string; credential: string; cwd: string; mode: "ask" | "allow" };
type Storage = Pick<globalThis.Storage, "getItem" | "setItem"> & Partial<Pick<globalThis.Storage, "removeItem">>;
type Fetch = typeof fetch;

function isPendingChat(value: unknown): value is PendingChat {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return typeof record.sessionId === "string" && record.sessionId.length > 0
    && typeof record.pageId === "string" && record.pageId.length > 0
    && (record.mode === "ask" || record.mode === "allow")
    && stages.includes(record.stage as Stage);
}

function readRecords(storage: Storage): PendingChat[] {
  try {
    const parsed = JSON.parse(storage.getItem(STORAGE_KEY) ?? "[]") as unknown;
    return Array.isArray(parsed) ? parsed.filter(isPendingChat) : [];
  } catch { return []; }
}

function writeRecords(storage: Storage, records: PendingChat[]) {
  if (records.length) storage.setItem(STORAGE_KEY, JSON.stringify(records));
  else storage.removeItem?.(STORAGE_KEY);
}

export function createChatCreationOwner(storage: Storage = localStorage, request: Fetch = fetch) {
  const running = new Map<string, Promise<PendingChat>>();
  const pending = (pageId: string) => readRecords(storage).find((record) => record.pageId === pageId) ?? null;
  const save = (record: PendingChat) => {
    const records = readRecords(storage).filter((item) => item.pageId !== record.pageId);
    records.push(record);
    writeRecords(storage, records);
  };
  const clear = (pageId: string) => writeRecords(storage, readRecords(storage).filter((record) => record.pageId !== pageId));

  const finish = async (input: ChatCreationInput, initial: PendingChat): Promise<PendingChat> => {
    let record = initial;
    if (record.stage === "created") {
      const response = await request(`/api/pages/${record.pageId}/chats`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ session_id: record.sessionId }),
      });
      if (!response.ok) throw new Error(`could not save chat (${response.status})`);
      record = { ...record, stage: "registered" }; save(record);
    }
    if (record.stage === "registered") {
      const approval = await applyApprovalMode(input.client, record.sessionId, record.mode);
      if (approval.pending) throw new Error("the creation approval mode is waiting for the session to become idle");
      record = { ...record, stage: "approvalApplied" }; save(record);
    }
    clear(record.pageId);
    return record;
  };

  const run = (input: ChatCreationInput, create: boolean): Promise<PendingChat> | null => {
    const active = running.get(input.pageId);
    if (active) return active;
    const existing = pending(input.pageId);
    if (!create && !existing) return null;
    const operation = (async () => {
      let record = existing;
      if (!record) {
        const binding = { cwd: input.cwd, mcp_bindings: [{ server: "achilles", headers: { Authorization: `Bearer ${input.credential}` } }] };
        const result = await input.client.request("new_session", binding) as { session?: { session_id?: string } };
        const sessionId = result.session?.session_id;
        if (!sessionId) throw new Error("zeta did not return a session id");
        record = { sessionId, pageId: input.pageId, mode: input.mode, stage: "created" }; save(record);
      }
      return finish(input, record);
    })();
    running.set(input.pageId, operation);
    void operation.finally(() => { if (running.get(input.pageId) === operation) running.delete(input.pageId); }).catch(() => {});
    return operation;
  };

  return {
    pending,
    create: (input: ChatCreationInput) => run(input, true)!,
    resume: (input: ChatCreationInput) => run(input, false),
  };
}

export type ChatCreationOwner = ReturnType<typeof createChatCreationOwner>;
