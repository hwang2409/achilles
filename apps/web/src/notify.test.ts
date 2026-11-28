import "./test-dom";
import { afterEach, describe, expect, test } from "bun:test";
import { createElement } from "react";
import { createNotifier, useApprovalIntent, type Note } from "./notify";
const { act, cleanup, render } = await import("@testing-library/react");
import type { Chat } from "./surface/AgentNavAdapter";

const row = (state: Chat["last_state"], version: number, id = "s1"): Chat => ({
  session_id: id, purpose: "chat", page_id: "home", page_route: "/", page_title: "home", title: "fixture chat", message_sent: true,
  created_at: "2026-01-01", updated_at: "2026-01-01", last_state: state, state_version: version,
});

function tab(show = { on: true }) {
  const notes: Note[] = [];
  const hidden: string[] = [];
  return { notes, hidden, show, notifier: createNotifier({ show: (note) => notes.push(note), hide: (tag) => hidden.push(tag), shouldShow: () => show.on }) };
}

describe("createNotifier", () => {
  test("one note per approval transition, with the approval intent; never for what a first load already sees", () => {
    const { notes, notifier } = tab();
    notifier.update([row("approval", 1, "waiting"), row("running", 1)]);
    expect(notes).toEqual([]);
    notifier.update([row("approval", 1, "waiting"), row("approval", 2)]);
    // a list reload (a reconnect) with the same rows repeats nothing
    notifier.update([row("approval", 1, "waiting"), row("approval", 2)]);
    expect(notes).toEqual([{ tag: "s1", title: "fixture chat needs you", href: "/?chat=s1#approval" }]);
  });

  test("a run that ends idle says finished; an approval answered and run again notifies again", () => {
    const { notes, notifier } = tab();
    for (const [state, version] of [["running", 1], ["approval", 2], ["running", 3], ["idle", 4], ["running", 5], ["approval", 6]] as const) notifier.update([row(state, version)]);
    expect(notes.map((note) => [note.title, note.href])).toEqual([
      ["fixture chat needs you", "/?chat=s1#approval"],
      ["fixture chat finished", "/?chat=s1"],
      ["fixture chat needs you", "/?chat=s1#approval"],
    ]);
  });

  test("a chat that stops waiting closes its note, so it is not clicked later; other transitions close nothing", () => {
    const { hidden, notifier } = tab();
    for (const [state, version] of [["running", 1], ["approval", 2], ["running", 3], ["idle", 4], ["approval", 5], ["idle", 6]] as const) notifier.update([row(state, version)]);
    expect(hidden).toEqual(["s1", "s1"]);
  });

  test("a transition while the tab may not show (visible, not the leader, or off) is spent, not shown later", () => {
    const { notes, show, notifier } = tab({ on: false });
    notifier.update([row("running", 1)]);
    notifier.update([row("approval", 2)]);
    show.on = true;
    notifier.update([row("approval", 2)]);
    expect(notes).toEqual([]);
  });
});

describe("useApprovalIntent", () => {
  const frame = () => act(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  const now = performance.now;
  const raf = { request: requestAnimationFrame, cancel: cancelAnimationFrame };
  afterEach(() => {
    cleanup();
    history.replaceState(null, "", "/");
    performance.now = now;
    Object.assign(globalThis, { requestAnimationFrame: raf.request, cancelAnimationFrame: raf.cancel });
  });
  // approval: null while the chat loads, false when loaded and not waiting, true when waiting; card: the approval card has
  // rendered (it can come a frame after the approval state)
  type Shown = { chatId?: string | null; approval: boolean | null; card?: boolean };
  function Chat({ chatId = "s1", approval, card = approval === true }: Shown) {
    useApprovalIntent({ chatId: approval === null ? null : chatId, approval });
    return createElement("div", null,
      createElement("textarea", { "aria-label": "composer" }),
      card && createElement("div", { "data-part": "approval-actions" }, createElement("button", null, "approve")));
  }
  const focused = () => document.activeElement?.getAttribute("aria-label") ?? document.activeElement?.textContent;
  const later = (ms: number) => { performance.now = () => now.call(performance) + ms; };

  // a note's click or the "needs you" link: a page load of /?chat=s1#approval, the composer focused first
  function open(shown: Shown) {
    history.replaceState(null, "", "/?chat=s1#approval");
    const ui = render(createElement(Chat, shown));
    ui.getByLabelText("composer").focus();
    const show = (next: Shown) => ui.rerender(createElement(Chat, next));
    return { ui, show };
  }
  // the tab already shows ?chat=s1; the click is a same-document navigation that only changes the hash
  async function clickFromSameTab(shown: Shown) {
    history.replaceState(null, "", "/?chat=s1");
    const ui = render(createElement(Chat, shown));
    await frame();
    ui.getByLabelText("composer").focus();
    await act(() => new Promise<void>((resolve) => { addEventListener("hashchange", () => resolve(), { once: true }); location.hash = "#approval"; }));
    return { ui, show: (next: Shown) => ui.rerender(createElement(Chat, next)) };
  }

  // each row ends with the URL free of the intent; `focus` is where focus is at the end
  test.each([
    {
      name: "a click while the chat waits and its card is there: approve takes focus",
      focus: "approve",
      async run() { open({ approval: true }); await frame(); },
    },
    {
      name: "the card renders late: the hash leaves the URL at once, approve takes focus when the card comes",
      focus: "approve",
      async run() {
        const { show } = open({ approval: true, card: false });
        await frame();
        expect(location.search + location.hash).toBe("?chat=s1");
        show({ approval: true, card: true });
        await frame();
      },
    },
    {
      name: "the chat loads, then waits: approve takes focus",
      focus: "approve",
      async run() {
        const { show } = open({ approval: null });
        await frame();
        await frame();
        show({ approval: true });
        await frame();
      },
    },
    {
      name: "the chat loads and does not wait: the intent ends, and a later approval keeps focus where it is",
      focus: "composer",
      async run() {
        const { show } = open({ approval: null });
        await frame();
        show({ approval: false });
        await frame();
        expect(location.search + location.hash).toBe("?chat=s1");
        show({ approval: true });
        await frame();
      },
    },
    {
      name: "the approval ends before its card renders: a later approval keeps focus",
      focus: "composer",
      async run() {
        const { show } = open({ approval: true, card: false });
        await frame();
        show({ approval: false });
        await frame();
        show({ approval: true });
        await frame();
      },
    },
    {
      name: "the approval ends and another starts before the next frame and before the card: the second keeps focus",
      focus: "composer",
      async run() {
        const { show } = open({ approval: true, card: false });
        await frame();
        show({ approval: false });
        show({ approval: true });
        await frame();
      },
    },
    {
      name: "the user switches to another waiting chat within the wait: its approve does not take focus",
      focus: "composer",
      async run() {
        const { show } = open({ approval: true, card: false });
        await frame();
        show({ chatId: "s2", approval: true });
        await frame();
        show({ chatId: "s1", approval: true });
        await frame();
      },
    },
    {
      name: "the wait counts from the click: an approval that shows after it keeps focus",
      focus: "composer",
      async run() {
        const { show } = open({ approval: null });
        await frame();
        later(1500);
        show({ approval: true, card: false });
        await frame();
        later(2500);
        await frame();
        show({ approval: true });
        await frame();
      },
    },
    {
      name: "the card never renders: the wait ends without a focus move, and a later card does not take it",
      focus: "composer",
      async run() {
        const { show } = open({ approval: true, card: false });
        await frame();
        later(2500);
        await frame();
        show({ approval: true, card: true });
        await frame();
      },
    },
    {
      name: "a click from the tab that already shows the waiting chat focuses approve",
      focus: "approve",
      async run() { await clickFromSameTab({ approval: true }); await frame(); },
    },
    {
      name: "after that click, a later approval of the chat keeps focus where the user put it",
      focus: "composer",
      async run() {
        const { ui, show } = await clickFromSameTab({ approval: true });
        await frame();
        ui.getByLabelText("composer").focus();
        show({ approval: false });
        show({ approval: true });
        await frame();
      },
    },
    {
      name: "after that click, the chat reattaches (a loading render) and still waits: approve does not take focus again",
      focus: "composer",
      async run() {
        const { ui, show } = await clickFromSameTab({ approval: true });
        await frame();
        ui.getByLabelText("composer").focus();
        show({ approval: null });
        show({ approval: true });
        await frame();
      },
    },
    {
      name: "unmounted while it waits for the card: no frame is left",
      focus: undefined,
      async run() {
        const pending = new Set<number>();
        Object.assign(globalThis, {
          requestAnimationFrame: (callback: FrameRequestCallback) => { const id = raf.request((time) => { pending.delete(id); callback(time); }); pending.add(id); return id; },
          cancelAnimationFrame: (id: number) => { pending.delete(id); raf.cancel(id); },
        });
        const { ui } = open({ approval: true, card: false });
        await frame();
        expect(pending.size).toBe(1);
        ui.unmount();
        expect(pending.size).toBe(0);
      },
    },
  ])("$name", async ({ run, focus }) => {
    await run();
    if (focus) expect(focused()).toBe(focus);
    expect(location.search + location.hash).toBe("?chat=s1");
  });
});
