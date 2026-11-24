import { expect, test } from "bun:test";
import { emptyOverlays, reduceOverlays, type ShellOverlay } from "./shellOverlays";

test("shell overlay requests survive closing layers without duplicating or dismissing lower layers", () => {
  const ids = ["palette", "settings", "shortcuts"] as const;
  const events = (["request", "dismiss", "closed"] as const).flatMap(type => ids.map(id => ({ type, id })));
  type State = ReturnType<typeof reduceOverlays>;

  function verify(state: State, depth: number, requested?: ShellOverlay) {
    expect(new Set(state.stack.map(layer => layer.id)).size).toBe(state.stack.length);
    // Radix close callbacks can arrive in either order when several layers close.
    function settle(next: State) {
      const closing = next.stack.filter(layer => layer.phase === "closing");
      if (!closing.length) {
        expect(next.pending).toBeUndefined();
        if (requested) expect(next.stack.at(-1)).toEqual({ id: requested, phase: "open" });
      }
      for (const { id } of closing) settle(reduceOverlays(next, { type: "closed", id }));
    }
    settle(state);
    if (!depth) return;
    for (const event of events) {
      const next = reduceOverlays(state, event);
      let latest = requested;
      if (event.type === "request") latest = event.id;
      if (event.type === "dismiss") {
        const index = state.stack.findIndex(layer => layer.id === event.id);
        expect(next.stack.slice(0, index < 0 ? state.stack.length : index)).toEqual(state.stack.slice(0, index < 0 ? state.stack.length : index));
        if (index >= 0) expect(next.stack.slice(index)).toEqual(state.stack.slice(index).map(({ id }) => ({ id, phase: "closing" })));
        if (event.id === latest || (index >= 0 && state.stack.slice(index).some(layer => layer.id === latest) && state.pending !== latest)) latest = undefined;
      }
      verify(next, depth - 1, latest);
    }
  }

  verify(emptyOverlays, 4);
});
