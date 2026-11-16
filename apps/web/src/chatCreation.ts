import type { ZetaClient } from "@fulcrum/zeta";
import { chatQueues } from "./composer/chatQueues";
import { applyApprovalMode, pageBinding } from "./zeta/session";

const STORAGE_KEY = "achilles-pending-chats";
const MODE_STORAGE_KEY = "achilles-pending-create-modes";
/** page -> the first message whose create is running: a page load that ends the old page's send puts it in a box again */
const TEXT_STORAGE_KEY = "achilles-pending-create-texts";
const stages = ["created", "registered", "approvalApplied", "mapped", "attached", "modeApplied"] as const;
type Stage = typeof stages[number];

export type PendingChat = { sessionId: string; pageId: string; mode: "ask" | "allow"; stage: Stage; expectedSessionId?: string | null; mappedSessionId?: string; lastError?: string };
export type ChatCreationInput = { client: ZetaClient; pageId: string; credential: string; cwd: string; mode: "ask" | "allow"; mapExpectedSessionId?: string | null };
type Storage = Pick<globalThis.Storage, "getItem" | "setItem"> & Partial<Pick<globalThis.Storage, "removeItem">>;
type AttachedChat = { sessionId: string };
/**
 * One create of a page's first chat. `current`: the selection that asked is still shown; the owner checks it before
 * every step (new_session, register, settings, mapping, attach, create mode) and stops a stale create for good.
 * `create: false` only finishes the page's pending create. The page's new-chat queue (`new:<page>`) moves to the chat
 * that the page opens afterwards: the created chat, or the chat a stale create already mapped as home.
 * `text`: the first message. It stays in storage until zeta takes it (`sent`); a later page load that finishes or drops
 * the create, or opens the created chat before zeta took it (the old page's send died), puts it, unsent, into the box of
 * the chat the page opens.
 */
export type CreateRequest<T extends AttachedChat> = {
  input: ChatCreationInput;
  current: () => boolean;
  attach: (sessionId: string) => Promise<T>;
  applyCreateMode?: (attached: T, enabled: boolean) => Promise<T>;
  publishReady?: (attached: T) => Promise<void> | void;
  create?: boolean;
  text?: string;
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

function readMap<T extends "boolean" | "string">(storage: Storage, key: string, type: T): Record<string, T extends "boolean" ? boolean : string> {
  try {
    const parsed = JSON.parse(storage.getItem(key) ?? "{}") as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter((entry) => typeof entry[1] === type));
  } catch { return {}; }
}

function writeMap(storage: Storage, key: string, map: Record<string, unknown>) {
  if (Object.keys(map).length) storage.setItem(key, JSON.stringify(map));
  else storage.removeItem?.(key);
}

const readModes = (storage: Storage) => readMap(storage, MODE_STORAGE_KEY, "boolean");
const writeModes = (storage: Storage, modes: Record<string, boolean>) => writeMap(storage, MODE_STORAGE_KEY, modes);

export function createChatCreationOwner(storage: Storage = localStorage, request: Fetch = fetch) {
  const running = new Map<string, Promise<AttachedChat>>();
  const listeners = new Set<() => void>();
  const snapshots = new Map<string, { pending: PendingChat | null; error: string | null; createMode: boolean | undefined }>();
  const volatile = new Map<string, PendingChat>();
  const pending = (pageId: string) => volatile.get(pageId) ?? readRecords(storage).find((record) => record.pageId === pageId) ?? null;
  const publish = (pageId: string, record: PendingChat | null) => {
    snapshots.set(pageId, { pending: record, error: record?.lastError ?? null, createMode: readModes(storage)[pageId] });
    listeners.forEach((listener) => listener());
  };
  const save = (record: PendingChat) => {
    volatile.set(record.pageId, record);
    const records = readRecords(storage).filter((item) => item.pageId !== record.pageId);
    records.push(record);
    writeRecords(storage, records);
    publish(record.pageId, record);
  };
  const clearDurable = (pageId: string) => {
    writeRecords(storage, readRecords(storage).filter((record) => record.pageId !== pageId));
  };
  const complete = (pageId: string) => {
    volatile.delete(pageId);
    publish(pageId, null);
  };
  const advance = (record: PendingChat, change: Partial<PendingChat>) => {
    const { lastError: _lastError, ...current } = record;
    return { ...current, ...change } as PendingChat;
  };

  const forget = (pageId: string) => { clearDurable(pageId); complete(pageId); };
  const dropText = (pageId: string) => {
    const texts = readMap(storage, TEXT_STORAGE_KEY, "string");
    if (!Object.hasOwn(texts, pageId)) return;
    delete texts[pageId]; writeMap(storage, TEXT_STORAGE_KEY, texts);
  };
  /** pages whose kept first message this page load sent into its create: it still holds that message (a queue row or a starter send) */
  const started = new Set<string>();
  /** The page opens `chat` (or its new-chat box): the kept first message of an earlier page load goes there. One that this
   * page load holds stays kept until `sent` when `keep`, else this create will not send it and its holder puts it back. */
  const handOff = (pageId: string, chat: string, keep: boolean) => {
    const text = readMap(storage, TEXT_STORAGE_KEY, "string")[pageId];
    if (text === undefined) return;
    if (!started.has(pageId)) chatQueues.restore(`new:${pageId}`, chat, text);
    else if (keep) return;
    started.delete(pageId); dropText(pageId);
  };

  const ensure = <T extends AttachedChat>({ input, current, attach, applyCreateMode, publishReady = () => {}, create = true, text }: CreateRequest<T>): Promise<T> | null => {
    const active = running.get(input.pageId);
    if (active) return active as Promise<T>;
    const existing = pending(input.pageId);
    if (!create && !existing) return null;
    // an attachment that is already stale starts nothing and keeps the page's pending record
    if (!current()) return Promise.reject(new StaleCreation());
    // zeta serves one attached session, so a create whose page moved on must not touch zeta or the page again
    const live = () => {
      if (current()) return;
      // the home mapping already names this chat, so the page opens it now: its unsent first message goes there
      const opens = pending(input.pageId)?.mappedSessionId;
      if (opens) chatQueues.created(`new:${input.pageId}`, opens);
      handOff(input.pageId, opens ?? `new:${input.pageId}`, false);
      forget(input.pageId);
      throw new StaleCreation();
    };
    const step = <R>(run: () => Promise<R>) => { live(); return run(); };
    const operation = (async () => {
      let record = existing;
      if (!record) {
        if (text) { writeMap(storage, TEXT_STORAGE_KEY, { ...readMap(storage, TEXT_STORAGE_KEY, "string"), [input.pageId]: text }); started.add(input.pageId); }
        const result = await step(() => input.client.request("new_session", pageBinding(input.credential, input.cwd))) as { session?: { session_id?: string } };
        const sessionId = result.session?.session_id;
        if (!sessionId) throw new Error("zeta did not return a session id");
        live();
        record = { sessionId, pageId: input.pageId, mode: input.mode, stage: "created", ...(Object.hasOwn(input, "mapExpectedSessionId") ? { expectedSessionId: input.mapExpectedSessionId } : {}) }; save(record);
      }
      if (record.stage === "created") {
        const { sessionId } = record;
        const response = await step(() => request(`/api/pages/${input.pageId}/chats`, {
          method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ session_id: sessionId }),
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
      const createMode = readModes(storage)[input.pageId];
      if (createMode !== undefined && applyCreateMode) {
        const shown = attached;
        attached = await step(() => applyCreateMode(shown, createMode));
        record = advance(record, { stage: "modeApplied" }); save(record);
      }
      if (createMode !== undefined) {
        const modes = readModes(storage); delete modes[input.pageId]; writeModes(storage, modes);
      }
      clearDurable(input.pageId);
      chatQueues.created(`new:${input.pageId}`, attached.sessionId); // before the chat renders, so its composer takes the new-chat queue
      handOff(input.pageId, attached.sessionId, true);
      await publishReady(attached);
      complete(input.pageId);
      return attached;
    })().catch((caught) => {
      if (caught instanceof StaleCreation) throw caught;
      live(); // a failure after the page moved on (a stale attach included) stops this create for good
      const retained = pending(input.pageId);
      if (retained) save({ ...retained, lastError: caught instanceof Error ? caught.message : String(caught) });
      throw caught;
    });
    running.set(input.pageId, operation);
    void operation.finally(() => { if (running.get(input.pageId) === operation) running.delete(input.pageId); }).catch(() => {});
    return operation;
  };

  return {
    status(pageId: string) {
      let snapshot = snapshots.get(pageId);
      if (!snapshot) { const record = pending(pageId); snapshot = { pending: record, error: record?.lastError ?? null, createMode: readModes(storage)[pageId] }; snapshots.set(pageId, snapshot); }
      return snapshot;
    },
    subscribe(listener: () => void) { listeners.add(listener); return () => listeners.delete(listener); },
    setCreateMode(pageId: string, enabled: boolean) {
      writeModes(storage, { ...readModes(storage), [pageId]: enabled });
      publish(pageId, pending(pageId));
    },
    ensure,
    /** Drop the page's failed create, so the page opens on its empty state with the new-chat draft. */
    discard(pageId: string) { if (!running.has(pageId)) { handOff(pageId, `new:${pageId}`, false); forget(pageId); } },
    /** The page opens `chat` (default: its new-chat box) with no create pending. A first message kept by an earlier page
     * load (it loaded again during new_session, or after the create but before zeta took the send) goes into that box,
     * unsent; `delivered`: the chat's transcript already has a user message, so zeta took it and it is dropped. */
    restoreUnsent(pageId: string, chat = `new:${pageId}`, delivered = false) {
      if (running.has(pageId) || pending(pageId)) return;
      if (delivered) dropText(pageId); else handOff(pageId, chat, true);
    },
    /** zeta took a message of this page's chat: a kept first message is sent */
    sent(pageId: string) { started.delete(pageId); dropText(pageId); },
  };
}

export type ChatCreationOwner = ReturnType<typeof createChatCreationOwner>;
