import { afterEach, describe, expect, test } from "bun:test";
import { createNotifier, NOTIFIED_KEY, type Note } from "./notify";
import type { Chat } from "./surface/AgentNavAdapter";

const row = (state: Chat["last_state"], version: number, id = "s1"): Chat => ({
  session_id: id, purpose: "chat", page_id: "home", page_route: "/", page_title: "home", title: "fixture chat", message_sent: true,
  created_at: "2026-01-01", updated_at: "2026-01-01", last_state: state, state_version: version,
});

function tab(storage: Storage, show = { on: true }) {
  const notes: Note[] = [];
  return { notes, show, notifier: createNotifier({ show: (note) => notes.push(note), shouldShow: () => show.on, storage }) };
}

afterEach(() => localStorage.clear());

describe("createNotifier", () => {
  test("one note per approval transition, with the approval intent; never for what a first load already sees", () => {
    const { notes, notifier } = tab(localStorage);
    notifier.update([row("approval", 1, "waiting"), row("running", 1)]);
    expect(notes).toEqual([]);
    notifier.update([row("approval", 1, "waiting"), row("approval", 2)]);
    // a list reload (a reconnect) with the same rows repeats nothing
    notifier.update([row("approval", 1, "waiting"), row("approval", 2)]);
    expect(notes).toEqual([{ key: "s1:2", tag: "s1", title: "fixture chat needs you", href: "/?chat=s1#approval" }]);
  });

  test("a run that ends idle says finished; an approval answered and run again notifies again", () => {
    const { notes, notifier } = tab(localStorage);
    for (const [state, version] of [["running", 1], ["approval", 2], ["running", 3], ["idle", 4], ["running", 5], ["approval", 6]] as const) notifier.update([row(state, version)]);
    expect(notes.map((note) => [note.key, note.title, note.href])).toEqual([
      ["s1:2", "fixture chat needs you", "/?chat=s1#approval"],
      ["s1:4", "fixture chat finished", "/?chat=s1"],
      ["s1:6", "fixture chat needs you", "/?chat=s1#approval"],
    ]);
  });

  test("a transition while the tab may not show (visible, not the leader, or off) is spent, not shown later", () => {
    const { notes, show, notifier } = tab(localStorage, { on: false });
    notifier.update([row("running", 1)]);
    notifier.update([row("approval", 2)]);
    show.on = true;
    notifier.update([row("approval", 2)]);
    expect(notes).toEqual([]);
  });

  test("two tabs (a new leader, or a reload) never show the same transition twice", () => {
    const first = tab(localStorage);
    const second = tab(localStorage);
    for (const { notifier } of [first, second]) notifier.update([row("running", 1)]);
    for (const { notifier } of [first, second]) notifier.update([row("approval", 2)]);
    expect([first.notes.length, second.notes.length]).toEqual([1, 0]);
    expect(JSON.parse(localStorage.getItem(NOTIFIED_KEY)!)).toEqual(["s1:2"]);
  });
});
