import { describe, expect, test } from "bun:test";
import { createRunStore, type RunEvent } from "@fulcrum/core";
import { watchJumpToLatest } from "./jumpToLatest";

// A virtual timeline's scroll box: its height stays fixed while the streaming row is outside the render window.
function scrollBox(fromBottom: number) {
  const box = Object.assign(new EventTarget(), { scrollHeight: 4000, clientHeight: 800, scrollTop: 3200 - fromBottom });
  const scrollTo = (distance: number) => { box.scrollTop = box.scrollHeight - 800 - distance; box.dispatchEvent(new Event("scroll")); };
  const grow = (pixels: number) => { box.scrollHeight += pixels; }; // rendered content below, scrollTop unchanged
  const wheel = (deltaY: number) => { box.dispatchEvent(Object.assign(new Event("wheel"), { deltaY })); };
  return { box: box as unknown as HTMLElement, scrollTo, grow, wheel };
}

const commit = (id: string, text: string): RunEvent => ({ type: "message_commit", message_id: id, message: { role: "assistant", content: [{ type: "text", text }] } });
const delta = (id: string, text: string): RunEvent => ({ type: "message_delta", message_id: id, delta: text });

type Box = { scrollTo(distance: number): void; grow(pixels: number): void; wheel(deltaY: number): void };
type Case = { name: string; fromBottom: number; act(store: ReturnType<typeof createRunStore>, box: Box, rewatch: () => void): void; shown: boolean; follows?: number };
const cases: Case[] = [
  { name: "new item while scrolled up", fromBottom: 2000, act: (store) => store.dispatch(commit("m2", "new row")), shown: true },
  { name: "content appended to the last item off-window", fromBottom: 2000, act: (store) => store.dispatch(delta("m1", " more")), shown: true },
  { name: "new item at the bottom", fromBottom: 0, act: (store) => { store.dispatch(commit("m2", "new row")); store.dispatch(delta("m2", " more")); }, shown: false },
  { name: "user scrolls to the bottom", fromBottom: 2000, act: (store, { scrollTo }) => { store.dispatch(delta("m1", " more")); scrollTo(0); }, shown: false },
  { name: "user scrolls but stays above the bottom", fromBottom: 2000, act: (store, { scrollTo }) => { store.dispatch(delta("m1", " more")); scrollTo(1000); }, shown: true },
  // WebKit snaps a .5 px follow write down 1 px; fulcrum then stops following, and the reply grows below a still reader
  { name: "follow dropped by a 1 px snap at the bottom", fromBottom: 0, act: (store, { scrollTo, grow }) => { scrollTo(1); grow(68); store.dispatch(delta("m1", " more")); }, shown: false, follows: 1 },
  { name: "user scrolls up from the bottom", fromBottom: 0, act: (store, { scrollTo, grow }) => { scrollTo(300); grow(68); store.dispatch(delta("m1", " more")); }, shown: true, follows: 0 },
  // one small wheel notch up is the reader's move, even inside the at-bottom slack
  { name: "a 3 px wheel up stops following", fromBottom: 0, act: (store, { scrollTo, grow, wheel }) => { wheel(-3); scrollTo(3); store.dispatch(delta("m1", " more")); grow(68); store.dispatch(delta("m1", " more")); }, shown: true, follows: 0 },
  // WebKit applies a wheel scroll after its event; a delta in between still sees the old bottom scrollTop
  { name: "a 40 px wheel up before its late scroll", fromBottom: 0, act: (store, { scrollTo, grow, wheel }) => { wheel(-40); grow(68); store.dispatch(delta("m1", " more")); scrollTo(108); }, shown: true, follows: 0 },
  { name: "back at the bottom after a wheel up, the snap re-follows again", fromBottom: 0, act: (store, { scrollTo, grow, wheel }) => { wheel(-3); scrollTo(3); scrollTo(0); scrollTo(1); grow(68); store.dispatch(delta("m1", " more")); }, shown: false, follows: 1 },
  { name: "chat switch resets it", fromBottom: 2000, act: (store, _box, rewatch) => { store.dispatch(delta("m1", " more")); rewatch(); }, shown: false },
];

describe("watchJumpToLatest", () => {
  for (const { name, fromBottom, act, shown, follows = 0 } of cases) {
    test(name, () => {
      const store = createRunStore((job) => job());
      store.dispatch(delta("m1", "streaming reply"));
      const { box, scrollTo, grow, wheel } = scrollBox(fromBottom);
      let visible = false; // App starts hidden
      let followed = 0;
      const follow = () => { followed += 1; };
      let stop = watchJumpToLatest(store, box, (value) => { visible = value; }, follow);
      try {
        act(store, { scrollTo, grow, wheel }, () => {
          expect(visible, "shown before the switch").toBe(true);
          stop();
          const other = createRunStore((job) => job());
          stop = watchJumpToLatest(other, scrollBox(fromBottom).box, (value) => { visible = value; }, follow);
          store.dispatch(delta("m1", " after the switch")); // the old chat's stream no longer reaches the control
        });
        expect(visible, name).toBe(shown);
        expect(followed, `${name}: follow requests`).toBe(follows);
      } finally {
        stop();
      }
    });
  }
});
