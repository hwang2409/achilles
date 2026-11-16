import { inFlight, MAYBE_SENT, type QueuedMessage } from "./composer-machine";
import { createComposerDelivery, type ComposerDelivery, type DeliveryOptions } from "./useComposerDelivery";
/** a row that had not left for zeta when the page unloaded */
export const NOT_SENT = "not sent before the page reloaded";

type StoredRow = Omit<QueuedMessage, "id">;
const PREFIX = "achilles:unsent:";
/** #155 kept a page's first message here (page id -> text) while its create ran */
const OLD_TEXTS = "achilles-pending-create-texts";

const storage = () => { try { return globalThis.localStorage; } catch { return undefined; } };
const parse = (value: string): StoredRow[] | undefined => {
  try {
    const parsed = JSON.parse(value) as { rows?: unknown };
    if (!Array.isArray(parsed.rows)) return undefined;
    return parsed.rows.flatMap((row: { text?: unknown; failed?: unknown; tries?: unknown; held?: unknown; deliveryId?: unknown } | null): StoredRow[] => {
      if (typeof row?.text !== "string" || typeof row.failed !== "string") return [];
      // rows written before `held` kept the id as `deliveryId` (maybe sent, or not sent with an id): zeta may hold them
      const held = typeof row.held === "string" ? row.held : typeof row.deliveryId === "string" ? row.deliveryId : undefined;
      return [{ text: row.text, failed: row.failed, ...(typeof row.tries === "number" ? { tries: row.tries } : {}), ...(held ? { held } : {}) }];
    });
  } catch { return undefined; }
};
// shortcut: an entry exists only while a message is unsent, so nothing is swept; a deleted chat's rows stay (a few bytes)
const readRows = (chat: string): StoredRow[] => {
  try {
    const value = storage()?.getItem(PREFIX + chat);
    if (value == null) return [];
    const rows = parse(value);
    if (!rows) storage()?.removeItem(PREFIX + chat);
    return rows ?? [];
  } catch { return []; }
};
/** Keep `rows` as `chat`'s unsent messages for the next page load. False: the write failed, the rows are in memory only. */
const writeRows = (chat: string, rows: StoredRow[]): boolean => {
  const target = storage();
  if (!target) return false;
  try {
    if (rows.length) target.setItem(PREFIX + chat, JSON.stringify({ rows }));
    else target.removeItem(PREFIX + chat);
    return true;
  } catch { return false; }
};
/** once per page load: #155's kept first messages become unsent rows of their page's new-chat box */
const migrateOldTexts = () => {
  try {
    const raw = storage()?.getItem(OLD_TEXTS);
    if (raw == null) return;
    const texts = JSON.parse(raw) as Record<string, unknown>;
    let written = true;
    for (const [page, text] of Object.entries(texts ?? {})) {
      if (typeof text === "string" && text) written = writeRows(`new:${page}`, [...readRows(`new:${page}`), { text, failed: NOT_SENT }]) && written;
    }
    if (written) storage()?.removeItem(OLD_TEXTS);
  } catch { /* storage is off or the entry is unparsable: nothing to move */ }
};
/** what a page load that starts now must show: every row failed, so nothing goes out before the user acts. A held row
 * that is not failed now (in flight, or retried and waiting) shows as maybe sent and keeps `held`, so it has no edit and a
 * retry cannot make a second copy. */
const stored = (owner: ComposerDelivery): StoredRow[] => {
  const model = owner.getModel();
  const sending = inFlight(model);
  return model.queue.flatMap((item): StoredRow[] => {
    if (item === sending && model.send?.echoed) return []; // zeta's transcript shows it: taken
    const failed = (item === sending ? undefined : item.failed) ?? (item.held ? MAYBE_SENT : NOT_SENT);
    return [{ text: item.text, failed, ...(item !== sending && item.tries ? { tries: item.tries } : {}), ...(item.held ? { held: item.held } : {}) }];
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
  migrateOldTexts();
  const owners = new Map<string, ComposerDelivery>();
  /** owner -> the chat its rows are kept under (a new-chat owner's created chat, once known) */
  const keys = new Map<ComposerDelivery, string>();
  /** new-chat owner key -> the chat that its first send created */
  const createdChats = new Map<string, string>();
  /** owners whose last write failed: only memory holds their rows, so `settle` keeps them */
  const unsaved = new Set<ComposerDelivery>();
  const keep = (owner: ComposerDelivery) => {
    const key = keys.get(owner);
    if (!key) return;
    if (writeRows(key, stored(owner))) unsaved.delete(owner); else unsaved.add(owner);
  };

  const queues = {
    /** The page now opens `chat` in place of its new-chat composer `newChat`: the rows `newChat` holds go with it (its owner
     * moves when the chat's composer opens, or at `settle`; rows that only a page load kept move now). */
    created(newChat: string, chat: string) {
      // a chat that holds rows already (a stale create opens the mapped home chat) keeps its own; these stay in the new-chat box
      if (owners.has(chat) || readRows(chat).length) return;
      const owner = owners.get(newChat);
      if (!owner) { if (writeRows(chat, readRows(newChat))) writeRows(newChat, []); return; }
      createdChats.set(newChat, chat);
      keys.set(owner, chat);
      keep(owner);
      if (!unsaved.has(owner)) writeRows(newChat, []);
    },
    /** the texts of the unsent rows `chat` keeps for a later page load (the page shows a notice for its new-chat box's) */
    unsent: (chat: string) => readRows(chat).map((row) => row.text),
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
        if (queue.some((item) => !item.failed) || unsaved.has(owner)) continue;
        owners.delete(chat); keys.delete(owner);
      }
    },
  };
  return queues;
}

export const chatQueues = createChatQueues();
