import type { ZetaClient } from "@fulcrum/zeta";
import { applyApprovalMode } from "./zeta/session";

const STORAGE_KEY = "achilles-pending-chats";
const stages = ["created", "registered", "approvalApplied", "mapped"] as const;
type Stage = typeof stages[number];

export type PendingChat = { sessionId: string; pageId: string; mode: "ask" | "allow"; stage: Stage; expectedSessionId?: string | null; mappedSessionId?: string; lastError?: string };
export type ChatCreationInput = { client: ZetaClient; pageId: string; credential: string; cwd: string; mode: "ask" | "allow"; mapExpectedSessionId?: string | null };
type Storage = Pick<globalThis.Storage, "getItem" | "setItem"> & Partial<Pick<globalThis.Storage, "removeItem">>;
type Fetch = typeof fetch;

function isPendingChat(value: unknown): value is PendingChat {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  const hasMapping = Object.hasOwn(record, "expectedSessionId")
    && (record.expectedSessionId === null || typeof record.expectedSessionId === "string");
  return typeof record.sessionId === "string" && record.sessionId.length > 0
    && typeof record.pageId === "string" && record.pageId.length > 0
    && (record.mode === "ask" || record.mode === "allow")
    && stages.includes(record.stage as Stage)
    && (!Object.hasOwn(record, "expectedSessionId") || hasMapping)
    && (!Object.hasOwn(record, "lastError") || typeof record.lastError === "string")
    && (record.stage !== "mapped" || (hasMapping && typeof record.mappedSessionId === "string" && record.mappedSessionId.length > 0));
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
  const contexts = new Map<string, ChatCreationInput>();
  const listeners = new Set<() => void>();
  const snapshots = new Map<string, { pending: PendingChat | null; error: string | null }>();
  const pending = (pageId: string) => readRecords(storage).find((record) => record.pageId === pageId) ?? null;
  const publish = (pageId: string, record: PendingChat | null) => {
    snapshots.set(pageId, { pending: record, error: record?.lastError ?? null });
    listeners.forEach((listener) => listener());
  };
  const save = (record: PendingChat) => {
    const records = readRecords(storage).filter((item) => item.pageId !== record.pageId);
    records.push(record);
    writeRecords(storage, records);
    publish(record.pageId, record);
  };
  const clear = (pageId: string) => {
    writeRecords(storage, readRecords(storage).filter((record) => record.pageId !== pageId));
    contexts.delete(pageId);
    publish(pageId, null);
  };
  const advance = (record: PendingChat, change: Partial<PendingChat>) => {
    const { lastError: _lastError, ...current } = record;
    return { ...current, ...change } as PendingChat;
  };

  const finish = async (input: ChatCreationInput, initial: PendingChat): Promise<PendingChat> => {
    let record = initial;
    try {
      if (record.stage === "created") {
        const response = await request(`/api/pages/${record.pageId}/chats`, {
          method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ session_id: record.sessionId }),
        });
        if (!response.ok) throw new Error(`could not save chat (${response.status})`);
        record = advance(record, { stage: "registered" }); save(record);
      }
      if (record.stage === "registered") {
        const approval = await applyApprovalMode(input.client, record.sessionId, record.mode);
        if (approval.pending) throw new Error("the creation approval mode is waiting for the session to become idle");
        record = advance(record, { stage: "approvalApplied" }); save(record);
      }
      if (record.stage === "approvalApplied" && Object.hasOwn(record, "expectedSessionId")) {
        const response = await request(`/api/pages/${record.pageId}/session`, {
          method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ expected_session_id: record.expectedSessionId, session_id: record.sessionId }),
        });
        if (!response.ok && response.status !== 409) throw new Error(`could not save session mapping (${response.status})`);
        const mappedSessionId = response.status === 409 ? ((await response.json()) as { session_id: string }).session_id : record.sessionId;
        record = advance(record, { stage: "mapped", mappedSessionId }); save(record);
      }
      clear(record.pageId);
      return record;
    } catch (caught) {
      const retained = pending(record.pageId);
      if (retained) save({ ...retained, lastError: caught instanceof Error ? caught.message : String(caught) });
      throw caught;
    }
  };

  const run = (input: ChatCreationInput, create: boolean): Promise<PendingChat> | null => {
    contexts.set(input.pageId, input);
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
        record = { sessionId, pageId: input.pageId, mode: input.mode, stage: "created", ...(Object.hasOwn(input, "mapExpectedSessionId") ? { expectedSessionId: input.mapExpectedSessionId } : {}) }; save(record);
      }
      return finish(input, record);
    })();
    running.set(input.pageId, operation);
    void operation.finally(() => { if (running.get(input.pageId) === operation) running.delete(input.pageId); }).catch(() => {});
    return operation;
  };

  const resume = (inputOrPageId: ChatCreationInput | string) => {
    const input = typeof inputOrPageId === "string" ? contexts.get(inputOrPageId) : inputOrPageId;
    return input ? run(input, false) : null;
  };

  return {
    status(pageId: string) {
      let snapshot = snapshots.get(pageId);
      if (!snapshot) { const record = pending(pageId); snapshot = { pending: record, error: record?.lastError ?? null }; snapshots.set(pageId, snapshot); }
      return snapshot;
    },
    subscribe(listener: () => void) { listeners.add(listener); return () => listeners.delete(listener); },
    create: (input: ChatCreationInput) => run(input, true)!,
    resume,
  };
}

export type ChatCreationOwner = ReturnType<typeof createChatCreationOwner>;
