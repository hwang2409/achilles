import type { createRunStore } from "@fulcrum/core";

type Store = Pick<ReturnType<typeof createRunStore>, "subscribe" | "getState" | "getItem">;

/**
 * The one owner of "show jump to latest" for a chat. It shows the control when the transcript store gains a row or
 * its last row changes (a streaming reply) while the reader is not at the bottom, and hides it once the reader is at
 * the bottom. The signal is the store, not the scroll box's height: a virtual timeline stops growing once the
 * streaming row leaves its render window. Watch one store at a time; the returned function stops watching.
 */
export function watchJumpToLatest(store: Store, scroll: HTMLElement, setShown: (shown: boolean) => void): () => void {
  const atBottom = () => scroll.scrollHeight - scroll.clientHeight - scroll.scrollTop <= 4;
  const tail = () => {
    const { outline } = store.getState();
    const last = outline.at(-1);
    return { length: outline.length, last: last && store.getItem(last.id) };
  };
  let seen = tail();
  setShown(false);
  const unsubscribe = store.subscribe(() => {
    const next = tail();
    if (next.length === seen.length && next.last === seen.last) return;
    seen = next;
    // a store change is read before the timeline renders it, so a following reader is still at the old bottom here
    if (!atBottom()) setShown(true);
  });
  const onScroll = () => { if (atBottom()) setShown(false); };
  scroll.addEventListener("scroll", onScroll, { passive: true });
  return () => { unsubscribe(); scroll.removeEventListener("scroll", onScroll); };
}
