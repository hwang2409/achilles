import { useRef, useState } from "react";

export type ShellOverlay = "palette" | "settings" | "shortcuts";
type Layer = { id: ShellOverlay; phase: "open" | "closing" };
type OverlayState = { stack: readonly Layer[]; pending?: ShellOverlay };
type OverlayEvent = { type: "request" | "dismiss" | "closed"; id: ShellOverlay };
export const emptyOverlays: OverlayState = { stack: [] };

export function reduceOverlays(state: OverlayState, { type, id }: OverlayEvent): OverlayState {
  const { stack, pending } = state;
  const index = stack.findIndex(layer => layer.id === id);
  const closeFrom = (start: number) => stack.map((layer, i): Layer => i < start ? layer : { ...layer, phase: "closing" });
  if (type === "closed") {
    if (stack[index]?.phase !== "closing") return state;
    const next = { stack: stack.filter(layer => layer.id !== id), pending };
    return pending && !next.stack.some(layer => layer.phase === "closing")
      ? reduceOverlays(next, { type: "request", id: pending }) : next;
  }
  if (type === "dismiss") {
    return { stack: index < 0 ? stack : closeFrom(index), pending: pending === id ? undefined : pending };
  }

  const top = stack.at(-1);
  if (top?.id === id && !stack.slice(0, -1).some(layer => layer.phase === "closing")) {
    if (top.phase === "open" && !pending) return state;
    // Reopen in place if the layer has not finished closing.
    return { stack: [...stack.slice(0, -1), { id, phase: "open" }] };
  }
  if (stack.some(layer => layer.phase === "closing")) return { stack, pending: id };
  // Unwind from the top so each Radix scope releases focus before its parent closes.
  if (index >= 0) return { stack: closeFrom(stack.length - 1), pending: id };
  // Running an overlay command replaces the palette, not its parent.
  if (top?.id === "palette") return { stack: closeFrom(stack.length - 1), pending: id };
  return { stack: [...stack, { id, phase: "open" }] };
}

export function useShellOverlays(restore: (opener: Element | null) => void) {
  const current = useRef(emptyOverlays);
  const openers = useRef(new Map<ShellOverlay, Element | null>());
  const [state, setState] = useState(emptyOverlays);
  // Capture-phase shortcuts and Radix callbacks can arrive before React renders.
  const dispatch = (event: OverlayEvent) => {
    const previous = current.current;
    const next = reduceOverlays(previous, event);
    if (next === previous) return;
    const closed = event.type === "closed";
    const opener = closed ? openers.current.get(event.id) ?? null : document.activeElement;
    if (closed) openers.current.delete(event.id);
    const added = next.stack.find(layer => (closed && layer.id === event.id) || !previous.stack.some(old => old.id === layer.id));
    if (added) openers.current.set(added.id, opener);
    current.current = next;
    setState(next);
    if (closed && !added && !next.stack.some(layer => layer.phase === "closing")) restore(opener);
  };
  return {
    layers: state.stack,
    open: (id: ShellOverlay) => dispatch({ type: "request", id }),
    dismiss: (id: ShellOverlay) => dispatch({ type: "dismiss", id }),
    closed: (id: ShellOverlay) => dispatch({ type: "closed", id }),
    escape(event: KeyboardEvent) {
      const top = current.current.stack.at(-1);
      const dialog = event.target instanceof Element && event.target.closest('[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]');
      if (top && dialog && dialog.getAttribute("data-shell-overlay") === top.id) {
        event.preventDefault();
        event.stopPropagation();
        dispatch({ type: "dismiss", id: top.id });
      }
    },
  };
}
