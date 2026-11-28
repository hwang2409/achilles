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
  return { notes, show, notifier: createNotifier({ show: (note) => notes.push(note), shouldShow: () => show.on }) };
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
  afterEach(() => { cleanup(); history.replaceState(null, "", "/"); });
  function Chat({ approval }: { approval: boolean }) {
    useApprovalIntent(approval);
    return createElement("div", null,
      createElement("textarea", { "aria-label": "composer" }),
      approval && createElement("div", { "data-part": "approval-actions" }, createElement("button", null, "approve")));
  }

  // the tab already shows ?chat=s1, waiting on an approval; the note's click is a same-document navigation that only
  // changes the hash
  async function clickFromSameTab() {
    history.replaceState(null, "", "/?chat=s1");
    const ui = render(createElement(Chat, { approval: true }));
    await frame();
    const composer = ui.getByLabelText("composer");
    composer.focus();
    await act(() => new Promise<void>((resolve) => { addEventListener("hashchange", () => resolve(), { once: true }); location.hash = "#approval"; }));
    await frame();
    return { ui, composer };
  }

  test("a click from the tab that already shows the waiting chat focuses approve and consumes the intent", async () => {
    await clickFromSameTab();
    expect(document.activeElement?.textContent).toBe("approve");
    expect(location.search + location.hash).toBe("?chat=s1");
  });

  test("after that click, a later approval of the chat keeps focus where the user put it", async () => {
    const { ui, composer } = await clickFromSameTab();
    composer.focus();
    ui.rerender(createElement(Chat, { approval: false }));
    ui.rerender(createElement(Chat, { approval: true }));
    await frame();
    expect(document.activeElement?.getAttribute("aria-label") ?? document.activeElement?.textContent).toBe("composer");
  });
});
