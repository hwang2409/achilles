import { useEffect, useState } from "react";

export const SIDEBAR_WIDTH = { min: 256, initial: 280, max: 480 };
const STORAGE_KEY = "achilles-sidebar-width";
const clamp = (px: number) => Math.round(Math.min(SIDEBAR_WIDTH.max, Math.max(SIDEBAR_WIDTH.min, px)));

/** The desktop sidebar width in px, clamped and kept in localStorage across reloads. */
export function useSidebarWidth() {
  const [width, setWidth] = useState(() => {
    const stored = Number(localStorage.getItem(STORAGE_KEY));
    return stored ? clamp(stored) : SIDEBAR_WIDTH.initial;
  });
  useEffect(() => { localStorage.setItem(STORAGE_KEY, String(width)); }, [width]);
  return [width, (px: number) => setWidth(clamp(px))] as const;
}

/** The drag handle on the sidebar's right edge: drag or arrow keys resize, double-click resets. */
export function SidebarResizer({ width, onResize }: { width: number; onResize: (px: number) => void }) {
  const edge = (element: Element) => element.parentElement!.getBoundingClientRect().left;
  return <div className="sidebar-resizer" role="separator" aria-orientation="vertical" aria-label="resize sidebar" aria-controls="surface-sidebar"
    aria-valuenow={width} aria-valuemin={SIDEBAR_WIDTH.min} aria-valuemax={SIDEBAR_WIDTH.max} tabIndex={0}
    onPointerDown={(event) => { if (event.button) return; event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); }}
    onPointerMove={(event) => { if (event.currentTarget.hasPointerCapture(event.pointerId)) onResize(event.clientX - edge(event.currentTarget)); }}
    onDoubleClick={() => onResize(SIDEBAR_WIDTH.initial)}
    onKeyDown={(event) => {
      const step = event.key === "ArrowLeft" ? -16 : event.key === "ArrowRight" ? 16 : 0;
      if (!step) return;
      event.preventDefault();
      onResize(width + step);
    }} />;
}
