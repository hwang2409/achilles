import { useRef, useState } from "react";

export type ShellOverlay = "palette" | "settings" | "shortcuts";
type Layer = { kind: ShellOverlay; opener: Element | null; closing?: { next?: ShellOverlay } };

export function useShellOverlays(restore: (opener: Element | null) => void) {
  const stack = useRef<Layer[]>([]);
  const [layers, setLayers] = useState(stack.current);
  const update = (next: Layer[]) => { stack.current = next; setLayers(next); };
  const dismiss = (kind: ShellOverlay, next?: ShellOverlay) => {
    const layer = stack.current.at(-1);
    if (!layer || layer.kind !== kind || (layer.closing && !next)) return;
    update([...stack.current.slice(0, -1), { ...layer, closing: { next } }]);
  };
  return {
    layers,
    open(kind: ShellOverlay) {
      const top = stack.current.at(-1);
      if (top?.closing || top?.kind === "palette") {
        dismiss(top.kind, kind === top.kind ? undefined : kind);
      } else if (!stack.current.some(layer => layer.kind === kind)) {
        update([...stack.current, { kind, opener: document.activeElement }]);
      }
    },
    dismiss,
    escape(event: KeyboardEvent) {
      const top = stack.current.at(-1);
      const dialog = event.target instanceof Element && event.target.closest('[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]');
      if (top && dialog && dialog.getAttribute("data-shell-overlay") === top.kind) {
        // The focused shell layer owns Escape even while Radix is removing another layer.
        event.preventDefault();
        event.stopPropagation();
        dismiss(top.kind);
      }
    },
    closed(kind: ShellOverlay) {
      const layer = stack.current.at(-1);
      if (layer?.kind !== kind || !layer.closing) return;
      const parents = stack.current.slice(0, -1);
      const next = layer.closing.next;
      if (next && !parents.some(parent => parent.kind === next)) {
        update([...parents, { kind: next, opener: layer.opener }]);
      } else {
        update(parents);
        restore(layer.opener);
      }
    },
  };
}
