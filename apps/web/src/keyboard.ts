export function isEditableTarget(event: KeyboardEvent) {
  const target = event.target;
  return target instanceof Element && Boolean(target.closest('input, textarea, select, [contenteditable], [role="textbox"], .cm-editor'));
}

export const isMac = navigator.platform.includes("Mac");
export const modKey = (key: string) => isMac ? `⌘${key}` : `ctrl+${key}`;

export const focusable = "button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary, iframe, audio[controls], video[controls], [contenteditable]:not([contenteditable='false']), [tabindex]:not([tabindex='-1'])";
const nativelyFocusable = "button, a[href], input, select, textarea, summary, iframe, audio[controls], video[controls], [contenteditable]:not([contenteditable='false'])";
// in Tab order now, wherever it is drawn: the drawer slides in, so on-screen checks drop every control mid-slide.
const tabbable = (element: HTMLElement) => element.tabIndex >= 0 && !element.matches(":disabled") && !element.closest("[inert]") && element.checkVisibility({ visibilityProperty: true });
export const firstFocusable = (parent: HTMLElement | null) => parent?.querySelector<HTMLElement>(focusable) ?? null;
export const restorableFocus = (...candidates: Array<Element | null>) => candidates.find((element): element is HTMLElement => {
  if (!(element instanceof HTMLElement) || element === document.body || element === document.documentElement || !element.isConnected || element.matches("[disabled], :disabled") || element.closest("[inert], [aria-hidden='true']")) return false;
  const rect = element.getBoundingClientRect();
  const style = getComputedStyle(element);
  return (element.tabIndex >= 0 || element.matches(nativelyFocusable)) && style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth;
}) ?? null;

export const restoreFocus = (...candidates: Array<Element | null>) => {
  restorableFocus(...candidates)?.focus();
};

const composerField = () => document.querySelector('#message-composer textarea[aria-label="message"], #message-composer [role="textbox"]');
// a control that unmounts or disables once used hands keyboard focus (Enter/Space: click detail 0) to the composer, not to <body>.
// a mouse click or tap leaves focus alone: focusing the textarea on a tap opens the soft keyboard over the transcript
export const keyboardFocusToComposer = (event: { detail: number; currentTarget: EventTarget }) => {
  if (event.detail === 0 && document.activeElement === event.currentTarget) restoreFocus(composerField());
};

// keeps Tab inside `container`: from the last tabbable control to the first, and back with Shift+Tab
export function wrapTab(event: Pick<KeyboardEvent, "key" | "shiftKey" | "preventDefault">, container: HTMLElement) {
  if (event.key !== "Tab") return;
  const controls = Array.from(container.querySelectorAll<HTMLElement>(focusable)).filter(tabbable);
  if (!controls.length) return;
  const next = event.shiftKey ? controls.at(-1) : controls[0];
  const current = event.shiftKey ? controls[0] : controls.at(-1);
  if (document.activeElement !== current && container.contains(document.activeElement)) return;
  event.preventDefault();
  next?.focus();
}
