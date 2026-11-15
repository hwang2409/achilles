import { describe, expect, test } from "bun:test";
import { createRunStore, type RunEvent } from "@fulcrum/core";
import { watchJumpToLatest } from "./jumpToLatest";

// A virtual timeline's scroll box: its height stays fixed while the streaming row is outside the render window.
function scrollBox(fromBottom: number) {
  const box = Object.assign(new EventTarget(), { scrollHeight: 4000, clientHeight: 800, scrollTop: 3200 - fromBottom });
  const scrollTo = (distance: number) => { box.scrollTop = 3200 - distance; box.dispatchEvent(new Event("scroll")); };
  return { box: box as unknown as HTMLElement, scrollTo };
}

const commit = (id: string, text: string): RunEvent => ({ type: "message_commit", message_id: id, message: { role: "assistant", content: [{ type: "text", text }] } });
const delta = (id: string, text: string): RunEvent => ({ type: "message_delta", message_id: id, delta: text });

type Case = { name: string; fromBottom: number; act(store: ReturnType<typeof createRunStore>, scrollTo: (distance: number) => void, rewatch: () => void): void; shown: boolean };
const cases: Case[] = [
  { name: "new item while scrolled up", fromBottom: 2000, act: (store) => store.dispatch(commit("m2", "new row")), shown: true },
  { name: "content appended to the last item off-window", fromBottom: 2000, act: (store) => store.dispatch(delta("m1", " more")), shown: true },
  { name: "new item at the bottom", fromBottom: 0, act: (store) => { store.dispatch(commit("m2", "new row")); store.dispatch(delta("m2", " more")); }, shown: false },
  { name: "user scrolls to the bottom", fromBottom: 2000, act: (store, scrollTo) => { store.dispatch(delta("m1", " more")); scrollTo(0); }, shown: false },
  { name: "user scrolls but stays above the bottom", fromBottom: 2000, act: (store, scrollTo) => { store.dispatch(delta("m1", " more")); scrollTo(1000); }, shown: true },
  { name: "chat switch resets it", fromBottom: 2000, act: (store, _scrollTo, rewatch) => { store.dispatch(delta("m1", " more")); rewatch(); }, shown: false },
];

describe("watchJumpToLatest", () => {
  for (const { name, fromBottom, act, shown } of cases) {
    test(name, () => {
      const store = createRunStore((job) => job());
      store.dispatch(delta("m1", "streaming reply"));
      const { box, scrollTo } = scrollBox(fromBottom);
      let visible = false; // App starts hidden
      let stop = watchJumpToLatest(store, box, (value) => { visible = value; });
      try {
        act(store, scrollTo, () => {
          expect(visible, "shown before the switch").toBe(true);
          stop();
          const other = createRunStore((job) => job());
          stop = watchJumpToLatest(other, scrollBox(fromBottom).box, (value) => { visible = value; });
          store.dispatch(delta("m1", " after the switch")); // the old chat's stream no longer reaches the control
        });
        expect(visible, name).toBe(shown);
      } finally {
        stop();
      }
    });
  }
});
