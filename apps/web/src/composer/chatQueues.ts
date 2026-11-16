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

export const chatQueues = {
  /** The page now opens `chat` in place of its new-chat composer `newChat`: the queue of `newChat` (if any) goes with it. */
  created(newChat: string, chat: string) {
    if (owners.has(newChat)) createdChats.set(newChat, chat);
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
      // a send that ends while no composer shows the chat settles it at once, not at some later commit
      created.subscribe(() => { if (!created.attached()) chatQueues.settle(); });
      owner = created;
    }
    owners.set(chat, owner);
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
      if (queue.length) draftStore.set(box, [draftStore.get(box), ...queue.map((item) => item.text)].filter((text) => text.trim()).join("\n\n"));
    }
  },
};
