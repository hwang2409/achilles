import { inFlight, type QueuedMessage } from "./composer-machine";
import { createComposerDelivery, type ComposerDelivery, type DeliveryOptions } from "./useComposerDelivery";

/** a row that was in flight when the page unloaded and had left for zeta: the chat's transcript says if zeta took it */
export const MAYBE_SENT = "may not have been sent — check before retrying";
/** a row that had not left for zeta when the page unloaded */
export const NOT_SENT = "not sent before the page reloaded";

type StoredRow = Omit<QueuedMessage, "id">;
type StoredRows = { rows: StoredRow[]; updatedAt: number };
const PREFIX = "achilles:unsent:";
// shortcut: the oldest chats past this bound lose their unsent rows; raise it if anyone keeps more chats unsent
const MAX_CHATS = 20;
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

const storage = () => { try { return globalThis.localStorage; } catch { return undefined; } };
const parse = (value: string | null): StoredRows | undefined => {
  try {
    const parsed = JSON.parse(value ?? "null") as Partial<StoredRows>;
    if (!Array.isArray(parsed.rows) || typeof parsed.updatedAt !== "number" || parsed.updatedAt < Date.now() - MAX_AGE_MS) return undefined;
    return { updatedAt: parsed.updatedAt, rows: parsed.rows.filter((row): row is StoredRow => typeof row?.text === "string" && typeof row.failed === "string") };
  } catch { return undefined; }
};
const readRows = (chat: string): StoredRow[] => { try { return parse(storage()?.getItem(PREFIX + chat) ?? null)?.rows ?? []; } catch { return []; } };
/** Keep `rows` as `chat`'s unsent messages for the next page load. A failed write keeps the rows in memory only. */
const writeRows = (chat: string, rows: StoredRow[]) => {
  const target = storage();
  if (!target) return;
  try {
    if (!rows.length) { target.removeItem(PREFIX + chat); return; }
    target.setItem(PREFIX + chat, JSON.stringify({ rows, updatedAt: Date.now() }));
    const stored: [string, number][] = [];
    for (let index = 0; index < target.length; index += 1) {
      const key = target.key(index);
      if (!key?.startsWith(PREFIX)) continue;
      const value = parse(target.getItem(key));
      if (value) stored.push([key, value.updatedAt]); else target.removeItem(key);
    }
    stored.sort((a, b) => b[1] - a[1]);
    for (const [key] of stored.slice(MAX_CHATS)) target.removeItem(key);
  } catch { /* keep the rows in memory */ }
};
/** what a page load that starts now must show: every row failed, so nothing goes out before the user acts */
const stored = (owner: ComposerDelivery): StoredRow[] => {
  const model = owner.getModel();
  const sending = inFlight(model);
  return model.queue.flatMap((item): StoredRow[] => {
    if (item !== sending) return [{ text: item.text, failed: item.failed ?? NOT_SENT, ...(item.tries ? { tries: item.tries } : {}) }];
    if (model.send?.echoed) return []; // zeta's transcript shows it: taken
    return [{ text: item.text, failed: model.send?.deliveryId ? MAYBE_SENT : NOT_SENT, ...(model.send?.deliveryId ? { deliveryId: model.send.deliveryId } : {}) }];
  });
};

/**
 * The one owner of each chat's submitted messages: the rows (sending, queued, failed, with tries) and the
 * send in flight. It lives here, keyed by chat id (a page's new-chat composer is `new:<page>`), not in a composer:
 * a remount or a chat switch shows the same rows, so a failed message stays failed and nothing is sent twice.
 * Every change is kept in localStorage per chat, so a page load shows the unsent rows again, all failed (retry, edit, x).
 * A composer only renders its chat's owner and passes user intents to it. An owner starts sends only while a composer
 * of its chat is attached.
 */
export function createChatQueues() {
  const owners = new Map<string, ComposerDelivery>();
  /** owner -> the chat its rows are kept under (a new-chat owner's created chat, once known) */
  const keys = new Map<ComposerDelivery, string>();
  /** new-chat owner key -> the chat that its first send created */
  const createdChats = new Map<string, string>();
  const keep = (owner: ComposerDelivery) => { const key = keys.get(owner); if (key) writeRows(key, stored(owner)); };

  const queues = {
    /** The page now opens `chat` in place of its new-chat composer `newChat`: the rows `newChat` holds go with it (its owner
     * moves when the chat's composer opens, or at `settle`; rows that only a page load kept move now). */
    created(newChat: string, chat: string) {
      // a chat that holds rows already (a stale create opens the mapped home chat) keeps its own; these stay in the new-chat box
      if (owners.has(chat) || readRows(chat).length) return;
      const owner = owners.get(newChat);
      writeRows(chat, owner ? stored(owner) : readRows(newChat));
      writeRows(newChat, []);
      if (!owner) return;
      createdChats.set(newChat, chat);
      keys.set(owner, chat);
    },
    /** The owner of `chat`. `fromNewChat`: the page's new-chat composer, offered to an unsent chat. Its owner (with
     * the first send still in flight) moves only to the chat that its own send created, never to another unsent chat.
     * Called during render: a render React throws away still moves it, and the next render finds it under `chat`. */
    open(chat: string, options: DeliveryOptions, fromNewChat?: string): ComposerDelivery {
      let owner = owners.get(chat);
      if (!owner && fromNewChat && createdChats.get(fromNewChat) === chat) {
        owner = owners.get(fromNewChat);
        owners.delete(fromNewChat);
        createdChats.delete(fromNewChat);
      }
      if (!owner) {
        const created = createComposerDelivery(options, readRows(chat));
        keys.set(created, chat);
        let kept: unknown[] = [];
        created.subscribe(() => {
          const { queue, send } = created.getModel();
          if (queue !== kept[0] || send !== kept[1]) { kept = [queue, send]; keep(created); } // not on every keystroke
          // a send that ends while no composer shows the chat settles it at once, not at some later commit
          if (!created.attached()) queues.settle();
        });
        owner = created;
      }
      owners.set(chat, owner);
      owner.update(options);
      return owner;
    },
    /** Runs after each commit, and when a send of a chat with no composer ends. A new-chat owner whose created chat did not
     * take it (no composer showed that chat) moves there now. Owners with no composer and nothing in memory that storage
     * does not hold (no send in flight, no row that would still go out) are dropped: a later `open` reads their rows back. */
    settle() {
      for (const [chat, owner] of [...owners]) {
        const { queue, sending } = owner.getModel();
        if (owner.attached() || sending) continue;
        const target = createdChats.get(chat);
        createdChats.delete(chat);
        if (target && !owners.has(target)) { owners.delete(chat); owners.set(target, owner); continue; }
        if (target) { // that chat has an owner of its own: these rows stay in the new-chat box
          keys.set(owner, chat); keep(owner); keep(owners.get(target)!);
          continue;
        }
        if (queue.some((item) => !item.failed)) continue;
        owners.delete(chat); keys.delete(owner);
      }
    },
  };
  return queues;
}

export const chatQueues = createChatQueues();
