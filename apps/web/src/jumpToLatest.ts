import type { createRunStore } from "@fulcrum/core";

type Store = Pick<ReturnType<typeof createRunStore>, "subscribe" | "getState" | "getItem">;

/**
 * The one owner of "show jump to latest" for a chat. It shows the control when the transcript store gains a row or
 * its last row changes (a streaming reply) while the reader is not at the bottom, and hides it once the reader is at
 * the bottom. The signal is the store, not the scroll box's height: a virtual timeline stops growing once the
 * streaming row leaves its render window. Watch one store at a time; the returned function stops watching.
 *
 * It also re-follows a reader the timeline dropped without a scroll: content grew below but scrollTop has not moved
 * since the reader was last at the bottom (WebKit snaps a .5 px scrollTop down 1 px, which reads as a scroll up).
 * workaround for fulcrum virtual.tsx onScroll sub-pixel snap (bug_report to fulcrum inbox, 2026-11-16; see the
 * achilles PR body); remove when fulcrum fixes it.
 */
export function watchJumpToLatest(store: Store, scroll: HTMLElement, setShown: (shown: boolean) => void, follow: () => void): () => void {
  const atBottom = () => scroll.scrollHeight - scroll.clientHeight - scroll.scrollTop <= 4;
  const tail = () => {
    const { outline } = store.getState();
    const last = outline.at(-1);
    return { length: outline.length, last: last && store.getItem(last.id) };
  };
  let seen = tail();
  let bottomTop = atBottom() ? scroll.scrollTop : Number.NaN;
  setShown(false);
  const unsubscribe = store.subscribe(() => {
    const next = tail();
    if (next.length === seen.length && next.last === seen.last) return;
    seen = next;
    // a store change is read before the timeline renders it, so a following reader is still at the old bottom here
    if (atBottom()) return;
    // a real scroll moves scrollTop by many pixels; the snap moves it by at most 1
    if (Math.abs(scroll.scrollTop - bottomTop) <= 1) follow();
    else setShown(true);
  });
  const onScroll = () => {
    if (!atBottom()) return;
    bottomTop = scroll.scrollTop;
    setShown(false);
  };
  scroll.addEventListener("scroll", onScroll, { passive: true });
  return () => { unsubscribe(); scroll.removeEventListener("scroll", onScroll); };
}
