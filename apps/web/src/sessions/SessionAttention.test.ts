import "../test-dom";
import { afterEach, expect, test } from "bun:test";
import { createElement } from "react";
import type { ZetaClient } from "@fulcrum/zeta";
import { createSessionsReader, type SessionRow } from "./reads";

// after test-dom: React must see the registered DOM.
const { cleanup, render, screen, within } = await import("@testing-library/react");
const { SessionAttention } = await import("./SessionsModule");

afterEach(cleanup);

const row = { id: "a", title: "synthetic", project: null, inUse: false, status: "idle" } as SessionRow;
const item = (id: string, kind: string) => ({ attention_id: id, project_id: null, session_id: "a", kind, requires_action: kind === "decision" || kind === "deferred",
  status: "open", title: `synthetic ${kind}`, created_ns: 1_800_000_000_000_000_000, updated_ns: 1 });
const lists: Record<string, unknown[]> = { action: [item("d1", "decision"), item("d2", "deferred")], fyi: [item("n1", "answer")] };
const mount = (answer: (list: string) => unknown, advertised = true) => {
  const client = { features: ["state_read_v1"], request: async (_method: string, params: { list: string }) => answer(params.list) } as unknown as ZetaClient;
  return render(createElement(SessionAttention, { row, reader: createSessionsReader(client, () => advertised) }));
};

test("decisions and notes show as two groups with their counts", async () => {
  mount((list) => ({ items: lists[list], next_cursor: null, as_of_ns: 1 }));
  const decisions = await screen.findByRole("region", { name: "decisions · 2" });
  expect(within(decisions).getAllByRole("listitem").map((li) => li.textContent?.replace(/\d.*$/, ""))).toEqual(["decisionsynthetic decision", "deferredsynthetic deferred"]);
  expect(within(screen.getByRole("region", { name: "notes · 1" })).getByRole("listitem").textContent).toStartWith("answersynthetic answer");
});

test.each([
  ["empty", () => ({ items: [], next_cursor: null, as_of_ns: 1 }), true, "no open decisions"],
  ["error", () => Promise.reject({ code: -32005 }), true, "zeta could not read this data right now"],
  ["older zeta", () => null, false, "the attention list needs a newer zeta"],
] as const)("%s", async (_name, answer, advertised, text) => {
  mount(answer, advertised);
  await screen.findByText(text);
});
