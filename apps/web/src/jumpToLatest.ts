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
 * The re-follow keys on input, not distance: after any scroll-up input from the reader (wheel, key, touch, a press on
 * the scrollbar) it never re-follows, however small the move, until the reader scrolls back down to the bottom.
 * workaround for fulcrum virtual.tsx onScroll sub-pixel snap (bug_report to fulcrum inbox, 2026-11-16; see the
 * achilles PR body); remove when fulcrum fixes it.
 */
const inputExpiryMs = 500;

export function watchJumpToLatest(store: Store, scroll: HTMLElement, setShown: (shown: boolean) => void, follow: () => void): () => void {
  // the reader moved up by their own input; a WebKit wheel scroll lands after its event, so mark it at the input
  let userScrolled = false;
  // and that input's scroll has landed: a follow write queued before the input must not count as a return to the bottom
  let movedUp = false;
  const gap = () => scroll.scrollHeight - scroll.clientHeight - scroll.scrollTop;
  const atBottom = () => gap() <= (userScrolled ? 0.5 : 4);
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
    if (!userScrolled && Math.abs(scroll.scrollTop - bottomTop) <= 1) follow();
    else setShown(true);
  });
  let lastTop = scroll.scrollTop;
  const onScroll = () => {
    // back down at the bottom (a scroll, "jump to latest", or a send): the timeline follows again
    if (userScrolled && scroll.scrollTop < lastTop) movedUp = true;
    else if (movedUp && scroll.scrollTop > lastTop && gap() <= 1) userScrolled = movedUp = false;
    lastTop = scroll.scrollTop;
    if (!atBottom()) return;
    bottomTop = scroll.scrollTop;
    setShown(false);
  };
  const upKeys = new Set(["ArrowUp", "PageUp", "Home"]);
  const input: [string, (event: Event) => boolean][] = [
    ["wheel", (event) => (event as WheelEvent).deltaY < 0],
    ["keydown", (event) => upKeys.has((event as KeyboardEvent).key) || ((event as KeyboardEvent).key === " " && (event as KeyboardEvent).shiftKey)],
    ["touchstart", () => true],
    // the scrollbar, not a click on text in a row
    ["pointerdown", (event) => event.target === scroll],
  ];
  // an input whose scroll never lands (WebKit can drop a wheel at the bottom while the timeline follows) expires
  let expiry: ReturnType<typeof setTimeout> | undefined;
  const markInput = () => {
    userScrolled = true;
    clearTimeout(expiry);
    expiry = setTimeout(() => { if (!movedUp) userScrolled = false; }, inputExpiryMs);
  };
  const listeners = input.map(([type, isUp]) => [type, (event: Event) => { if (isUp(event)) markInput(); }] as const);
  for (const [type, listener] of listeners) scroll.addEventListener(type, listener, { passive: true });
  scroll.addEventListener("scroll", onScroll, { passive: true });
  return () => {
    unsubscribe();
    clearTimeout(expiry);
    scroll.removeEventListener("scroll", onScroll);
    for (const [type, listener] of listeners) scroll.removeEventListener(type, listener);
  };
}
