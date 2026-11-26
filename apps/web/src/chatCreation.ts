import type { ZetaClient } from "@fulcrum/zeta";
import type { Chat } from "./surface/AgentNavAdapter";
import { chatQueues } from "./composer/chatQueues";
import { applyApprovalMode, ChatBusyError, isResidentLimit, pageBinding, runningSession, TooManyChatsError } from "./zeta/session";

const STORAGE_KEY = "achilles-pending-chats";
const MODE_STORAGE_KEY = "achilles-pending-create-modes";
const stages = ["created", "registered", "approvalApplied", "mapped", "attached", "modeApplied"] as const;
type Stage = typeof stages[number];

export type PendingChat = { sessionId: string; pageId: string; mode: "ask" | "allow"; purpose?: Chat["purpose"]; stage: Stage; expectedSessionId?: string | null; mappedSessionId?: string; lastError?: string };
export type ChatCreationInput = { client: ZetaClient; pageId: string; credential: string; cwd: string; mode: "ask" | "allow"; purpose?: Chat["purpose"]; mapExpectedSessionId?: string | null };
type Storage = Pick<globalThis.Storage, "getItem" | "setItem"> & Partial<Pick<globalThis.Storage, "removeItem">>;
type AttachedChat = { sessionId: string };
/**
 * One create of a page's first chat. `current`: the selection that asked is still shown; the owner checks it before
 * every step (new_session, register, settings, mapping, attach, create mode) and stops a stale create for good.
 * `create: false` only finishes the page's pending create. The page's new-chat queue (`new:<page>`) moves to the chat
 * that the page opens afterwards: the created chat, or the chat a stale create already mapped as home.
 */
export type CreateRequest<T extends AttachedChat> = {
  input: ChatCreationInput;
  current: () => boolean;
  attach: (sessionId: string) => Promise<T>;
  applyCreateMode?: (attached: T, enabled: boolean) => Promise<T>;
  publishReady?: (attached: T) => Promise<void> | void;
  create?: boolean;
};
/** The page no longer shows what started this create (another chat opened): it stopped before touching zeta again and forgot its record. */
export class StaleCreation extends Error { constructor() { super("another chat opened before this chat was created, so the message was not sent"); } }
type Fetch = typeof fetch;

function isPendingChat(value: unknown): value is PendingChat {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  const hasMapping = Object.hasOwn(record, "expectedSessionId")
    && (record.expectedSessionId === null || typeof record.expectedSessionId === "string");
  return typeof record.sessionId === "string" && record.sessionId.length > 0
    && typeof record.pageId === "string" && record.pageId.length > 0
    && (record.mode === "ask" || record.mode === "allow")
    && (!Object.hasOwn(record, "purpose") || record.purpose === "chat" || record.purpose === "page_build")
    && stages.includes(record.stage as Stage)
    && (!Object.hasOwn(record, "expectedSessionId") || hasMapping)
    && (!Object.hasOwn(record, "lastError") || typeof record.lastError === "string")
    && (!(record.stage === "mapped" || (Object.hasOwn(record, "expectedSessionId") && (["attached", "modeApplied"] as Stage[]).includes(record.stage as Stage))) || (hasMapping && typeof record.mappedSessionId === "string" && record.mappedSessionId.length > 0));
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

function readModes(storage: Storage): Record<string, boolean> {
  try {
    const parsed = JSON.parse(storage.getItem(MODE_STORAGE_KEY) ?? "{}") as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, boolean] => typeof entry[1] === "boolean"));
  } catch { return {}; }
}

function writeModes(storage: Storage, modes: Record<string, boolean>) {
  if (Object.keys(modes).length) storage.setItem(MODE_STORAGE_KEY, JSON.stringify(modes));
  else storage.removeItem?.(MODE_STORAGE_KEY);
}

export function createChatCreationOwner(storage: Storage = localStorage, request: Fetch = fetch) {
  const running = new Map<string, Promise<AttachedChat>>();
  const listeners = new Set<() => void>();
  const snapshots = new Map<string, { pending: PendingChat | null; error: string | null; createMode: boolean | undefined }>();
  const volatile = new Map<string, PendingChat>();
  const keyOf = (pageId: string, purpose: Chat["purpose"] = "chat") => `${purpose}:${pageId}`;
  const recordKey = (record: PendingChat) => keyOf(record.pageId, record.purpose);
  const pending = (key: string) => volatile.get(key) ?? readRecords(storage).find((record) => recordKey(record) === key) ?? null;
  const makeSnapshot = (pageId: string, purpose: Chat["purpose"] | undefined, record: PendingChat | null) =>
    ({ pending: record, error: record?.lastError ?? null, createMode: purpose === "page_build" ? undefined : readModes(storage)[pageId] });
  const publish = (pageId: string, purpose: Chat["purpose"] | undefined, record: PendingChat | null) => {
    snapshots.set(keyOf(pageId, purpose), makeSnapshot(pageId, purpose, record));
    listeners.forEach((listener) => listener());
  };
  const save = (record: PendingChat) => {
    const key = recordKey(record);
    volatile.set(key, record);
    const records = readRecords(storage).filter((item) => recordKey(item) !== key);
    records.push(record);
    writeRecords(storage, records);
    publish(record.pageId, record.purpose, record);
  };
  const clearDurable = (key: string) => {
    writeRecords(storage, readRecords(storage).filter((record) => recordKey(record) !== key));
  };
  const complete = (pageId: string, purpose?: Chat["purpose"]) => {
    volatile.delete(keyOf(pageId, purpose));
    publish(pageId, purpose, null);
  };
  const advance = (record: PendingChat, change: Partial<PendingChat>) => {
    const { lastError: _lastError, ...current } = record;
    return { ...current, ...change } as PendingChat;
  };

  const forget = (pageId: string, purpose?: Chat["purpose"]) => { clearDurable(keyOf(pageId, purpose)); complete(pageId, purpose); };

  const ensure = <T extends AttachedChat>({ input, current, attach, applyCreateMode, publishReady = () => {}, create = true }: CreateRequest<T>): Promise<T> | null => {
    const key = keyOf(input.pageId, input.purpose);
    const ordinary = input.purpose !== "page_build";
    const active = running.get(key);
    if (active) return active as Promise<T>;
    const existing = pending(key);
    if (!create && !existing) return null;
    // an attachment that is already stale starts nothing and keeps the page's pending record
    if (!current()) return Promise.reject(new StaleCreation());
    // zeta serves one attached session, so a create whose page moved on must not touch zeta or the page again
    const live = () => {
      if (current()) return;
      // the home mapping names this create's own chat, so the page opens it now: its new-chat rows go there. a chat
      // another tab mapped (409) was not written for: they stay in the new-chat box
      const stale = pending(key);
      if (stale?.mappedSessionId && stale.mappedSessionId === stale.sessionId) chatQueues.created(`new:${input.pageId}`, stale.sessionId);
      forget(input.pageId, input.purpose);
      throw new StaleCreation();
    };
    const step = <R>(run: () => Promise<R>) => { live(); return run(); };
    const operation = (async () => {
      let record = existing;
      if (!record) {
        // zeta refuses new_session while any turn runs, and the client repeats a refused one 3 times (fulcrum retryBusy):
        // read status first, so a click during a turn sends no new_session and its refusal is never repeated
        const busy = await step(() => runningSession(input.client));
        if (busy) throw new ChatBusyError(busy);
        const result = await step(() => input.client.request("new_session", pageBinding(input.credential, input.cwd)).catch((caught) => { throw isResidentLimit(caught) ? new TooManyChatsError() : caught; })) as { session?: { session_id?: string } };
        const sessionId = result.session?.session_id;
        if (!sessionId) throw new Error("zeta did not return a session id");
        live();
        record = { sessionId, pageId: input.pageId, mode: input.mode, purpose: input.purpose, stage: "created", ...(Object.hasOwn(input, "mapExpectedSessionId") ? { expectedSessionId: input.mapExpectedSessionId } : {}) }; save(record);
      }
      if (record.stage === "created") {
        const { sessionId, purpose } = record;
        const response = await step(() => request(`/api/pages/${input.pageId}/chats`, {
          method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ session_id: sessionId, purpose }),
        }));
        if (!response.ok) throw new Error(`could not save chat (${response.status})`);
        record = advance(record, { stage: "registered" }); save(record);
      }
      if (record.stage === "registered") {
        const { sessionId, mode } = record;
        const approval = await step(() => applyApprovalMode(input.client, sessionId, mode));
        if (approval.pending) throw new Error("the creation approval mode is waiting for the session to become idle");
        record = advance(record, { stage: "approvalApplied" }); save(record);
      }
      if (record.stage === "approvalApplied" && Object.hasOwn(record, "expectedSessionId")) {
        const { sessionId, expectedSessionId } = record;
        const response = await step(() => request(`/api/pages/${input.pageId}/session`, {
          method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ expected_session_id: expectedSessionId, session_id: sessionId }),
        }));
        if (!response.ok && response.status !== 409) throw new Error(`could not save session mapping (${response.status})`);
        const mappedSessionId = response.status === 409 ? ((await response.json()) as { session_id: string }).session_id : sessionId;
        record = advance(record, { stage: "mapped", mappedSessionId }); save(record);
      }
      const target = record.mappedSessionId ?? record.sessionId;
      let attached = await step(() => attach(target));
      record = advance(record, { stage: "attached" }); save(record);
      const createMode = ordinary ? readModes(storage)[input.pageId] : undefined;
      if (createMode !== undefined && applyCreateMode) {
        const shown = attached;
        attached = await step(() => applyCreateMode(shown, createMode));
        record = advance(record, { stage: "modeApplied" }); save(record);
      }
      if (createMode !== undefined) {
        const modes = readModes(storage); delete modes[input.pageId]; writeModes(storage, modes);
      }
      clearDurable(key);
      // before the chat renders, so its composer takes the new-chat queue; only into this create's own chat (not a 409 one)
      if (ordinary && attached.sessionId === record.sessionId) chatQueues.created(`new:${input.pageId}`, attached.sessionId);
      await publishReady(attached);
      complete(input.pageId, input.purpose);
      return attached;
    })().catch((caught) => {
      if (caught instanceof StaleCreation) throw caught;
      live(); // a failure after the page moved on (a stale attach included) stops this create for good
      const retained = pending(key);
      if (retained) save({ ...retained, lastError: caught instanceof Error ? caught.message : String(caught) });
      throw caught;
    });
    running.set(key, operation);
    void operation.finally(() => { if (running.get(key) === operation) running.delete(key); }).catch(() => {});
    return operation;
  };

  return {
    status(pageId: string, purpose?: Chat["purpose"]) {
      const key = keyOf(pageId, purpose);
      let snapshot = snapshots.get(key);
      if (!snapshot) { snapshot = makeSnapshot(pageId, purpose, pending(key)); snapshots.set(key, snapshot); }
      return snapshot;
    },
    subscribe(listener: () => void) { listeners.add(listener); return () => listeners.delete(listener); },
    setCreateMode(pageId: string, enabled: boolean) {
      writeModes(storage, { ...readModes(storage), [pageId]: enabled });
      publish(pageId, undefined, pending(keyOf(pageId)));
    },
    ensure,
    /** Drop the page's failed create, so the page opens on its empty state with the new-chat draft. */
    discard(pageId: string) { if (!running.has(keyOf(pageId))) forget(pageId); },
  };
}

export type ChatCreationOwner = ReturnType<typeof createChatCreationOwner>;
