import { draftStore } from "../draftStore";
import type { ParkedQueue } from "./useComposerDelivery";

/**
 * Queued messages of chats whose composer is not mounted. Each chat keeps its own;
 * nothing here sends. The chat's next composer takes them and sends them in order.
 * shortcut: memory only, so a page reload drops parked messages; persist like drafts if that matters.
 */
const parked = new Map<string, ParkedQueue>();

export const chatQueues = {
  park(chat: string, queue: ParkedQueue) {
    const earlier = parked.get(chat);
    parked.set(chat, earlier ? { texts: [...earlier.texts, ...queue.texts], after: earlier.after.then(() => queue.after) } : queue);
  },
  /** Takes the queues of `chats` in order, joined behind one wait. */
  take(chats: string[]): ParkedQueue | undefined {
    const found = chats.flatMap((chat) => { const queue = parked.get(chat); parked.delete(chat); return queue ? [queue] : []; });
    if (!found.length) return undefined;
    return { texts: found.flatMap((queue) => queue.texts), after: Promise.all(found.map((queue) => queue.after)).then((outcomes) => outcomes.find((outcome) => outcome.failed) ?? {}) };
  },
  /** A new chat's queue moves only to the chat its first message created, in the same commit.
   * What is left goes back into that new chat's box, unsent. */
  settleNewChats() {
    for (const [chat, queue] of parked) {
      if (!chat.startsWith("new:")) continue;
      parked.delete(chat);
      draftStore.set(chat, [draftStore.get(chat), ...queue.texts].filter((text) => text.trim()).join("\n\n"));
    }
  },
};
