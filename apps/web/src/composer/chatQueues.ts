import { draftStore } from "../draftStore";
import { createComposerDelivery, type ComposerDelivery, type DeliveryOptions } from "./useComposerDelivery";

/**
 * The one owner of each chat's submitted messages: the rows (sending, queued, failed, with tries) and the
 * send in flight. It lives here, keyed by chat id, not in a composer: a remount or a chat switch shows the
 * same rows, so a failed message stays failed and nothing is sent twice. A composer only renders its chat's
 * owner and passes user intents to it. An owner starts sends only while a composer of its chat is attached.
 * shortcut: memory only, so a page reload drops queued messages; persist like drafts if that matters.
 */
const owners = new Map<string, ComposerDelivery>();
/** new-chat owner key -> the chat that its first send created */
const createdChats = new Map<string, string>();
/** new-chat box -> its text right after `settle` put unsent messages back there (a create that ends later takes it along) */
const returned = new Map<string, string>();
const appendDraft = (chat: string, texts: string[]) => draftStore.set(chat, [draftStore.get(chat), ...texts].filter((text) => text.trim()).join("\n\n"));
/** chat -> the note its box shows once its composer opens (unsent text moved there) */
const notes = new Map<string, string>();
export const MOVED_NOTE = "written in a new chat; not sent yet";
export const KEPT_NOTE = "not sent yet";
/** unsent text went into the stored draft of `box`, from the new-chat box `from`: an open composer of `box` shows it now */
const noteBox = (box: string, from: string) => {
  const note = box === from ? KEPT_NOTE : MOVED_NOTE;
  const owner = owners.get(box);
  if (!owner) { notes.set(box, note); return; }
  owner.edit(draftStore.get(box));
  owner.note(note);
};

export const chatQueues = {
  /** The page now opens `chat` in place of its new-chat composer `newChat`: what `newChat` holds goes with it, its queue
   * (moved when the chat's composer opens, or by `settle`), or the box text that an earlier `settle` left, while unchanged. */
  created(newChat: string, chat: string) {
    if (owners.has(newChat)) { createdChats.set(newChat, chat); return; }
    const text = returned.get(newChat);
    returned.delete(newChat);
    if (text && draftStore.get(newChat) === text) { appendDraft(chat, [text]); draftStore.set(newChat, ""); noteBox(chat, newChat); }
  },
  /** A page load finishes, or drops, a first-message create that an earlier load of the page started: that load's send died
   * with it, so the message goes into the box of the chat the page opens now (`chat`, or the new-chat box `newChat` itself),
   * unsent, with the new-chat box text. */
  restore(newChat: string, chat: string, text: string) {
    const box = draftStore.get(newChat);
    // the old page may have put the message back into the new-chat box as it unloaded
    const texts = box.includes(text) ? [box] : [text, box];
    if (chat === newChat) draftStore.set(chat, texts.filter((item) => item.trim()).join("\n\n"));
    else { appendDraft(chat, texts); draftStore.set(newChat, ""); }
    noteBox(chat, newChat);
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
      const created = createComposerDelivery(options);
      const note = notes.get(chat);
      if (note) created.note(note);
      // a send that ends while no composer shows the chat settles it at once, not at some later commit
      created.subscribe(() => { if (!created.attached()) chatQueues.settle(); });
      owner = created;
    }
    owners.set(chat, owner);
    notes.delete(chat);
    returned.delete(chat); // its box is on screen again
    owner.update(options);
    return owner;
  },
  /** Runs after each commit, and when a send of a chat with no composer ends. Drops owners with no composer and nothing to send. A page's new-chat owner whose
   * chat did not take it (it was not on screen when the chat was created) puts its unsent texts back into
   * the box of the chat the page opens now (the created chat, else the new-chat box), unsent, once its send in flight has ended. */
  settle() {
    for (const [chat, owner] of owners) {
      const { queue, sending } = owner.getModel();
      if (owner.attached() || sending) continue;
      if (queue.length && !chat.startsWith("new:")) continue;
      const box = createdChats.get(chat) ?? chat;
      owners.delete(chat);
      createdChats.delete(chat);
      if (!queue.length) continue;
      appendDraft(box, queue.map((item) => item.text));
      noteBox(box, chat);
      if (box === chat) returned.set(chat, draftStore.get(chat));
    }
  },
};
