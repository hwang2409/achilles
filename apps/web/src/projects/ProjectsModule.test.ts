import "../test-dom";
import { afterEach, expect, test } from "bun:test";
import { createElement } from "react";
import { ZetaError, type ZetaClient } from "@fulcrum/zeta";

// after test-dom: React must see the registered DOM.
const { act, cleanup, fireEvent, render, waitFor, within } = await import("@testing-library/react");
import type { MemoryActions } from "./MemoryActions";
const { ProjectsModule } = await import("./ProjectsModule");

afterEach(cleanup);

// Synthetic home: the selected project is on page 2 of the project list, so its name needs a lookup.
const project = (id: string, name: string) => ({ project_id: id, name, path: `/fixture/${name}`, session_count: 0, memory_count: 1, inbox: { new: 0, claimed: 0, done: 0 } });
const memory = (id: string, kind: string) => ({ memory_id: id, kind, automatic: false, summary: `synthetic ${id}` });
const page = (items: unknown[], next_cursor: string | null = null) => ({ items, next_cursor, as_of_ns: 1 });
const answers: Record<string, (params: { cursor?: string | null }) => unknown> = {
  state_projects: ({ cursor }) => cursor ? page([project("p_target", "target")]) : page(Array.from({ length: 50 }, (_, n) => project(`p_${n}`, `bulk-${n}`)), "p2"),
  state_memory: ({ cursor }) => cursor ? page([memory("m_more", "decision")]) : page([memory("m_brief", "brief"), ...Array.from({ length: 49 }, (_, n) => memory(`m_${n}`, "decision"))], "m2"),
  project_show: () => ({ memory: { digest: "d", kinds: ["brief", "decisions"].map((key) => ({ key, rendered: `${key} text body`, rendered_truncated: false })) } }),
};

/** One zeta: `held` methods never answer until the socket that asked closes; `release()` answers a held show.
 * `busy` requests ("method cursor") fail once with -32005 on a live socket. `asked` counts requests over every socket. */
function fakeZeta(responses = answers) {
  const held = new Set<string>();
  const busy = new Set<string>();
  const asked: string[] = [];
  const shows: (() => void)[] = [];
  const connect = () => {
    const rejects = new Set<(error: unknown) => void>();
    const client = {
      features: ["state_read_v1", "project_writes_v1"],
      closed: false,
      request: (method: string, params: { cursor?: string | null }) => new Promise((resolve, reject) => {
        if (client.closed) return reject(new ZetaError("closed", 1006));
        asked.push(method);
        if (busy.delete(`${method} ${params.cursor ?? null}`)) return reject(Object.assign(new Error("busy"), { code: -32005 }));
        rejects.add(reject);
        const answer = () => { rejects.delete(reject); resolve(responses[method]!(params)); };
        if (method === "project_show" && held.has(method)) shows.push(answer);
        else if (!held.has(method)) answer();
      }),
      close() { client.closed = true; rejects.forEach((reject) => reject(new ZetaError("closed", 1006))); rejects.clear(); },
    };
    return client;
  };
  return { held, busy, asked: (method: string) => asked.filter((name) => name === method).length, connect, release: () => shows.splice(0).forEach((answer) => answer()) };
}

/** The page as SurfaceRouter wires it: a borrow swaps in a controller client, closes the observer, reads, and swaps back. */
function mount(zeta: ReturnType<typeof fakeZeta>, path: string) {
  history.replaceState(null, "", path);
  let client = zeta.connect();
  let observer = true;
  const element = () => createElement(ProjectsModule, { client: client as unknown as ZetaClient, control: { observer, dropped: new Set(), withControl } });
  const view = render(element());
  const swap = (next: typeof client, role: boolean) => { const old = client; client = next; observer = role; act(() => view.rerender(element())); old.close(); };
  async function withControl<T>(read: (reader: ZetaClient) => Promise<T>) {
    swap(zeta.connect(), false);
    try { return { value: await read(client as unknown as ZetaClient) }; } finally { swap(zeta.connect(), true); }
  }
  return { view };
}

test.each([
  ["lookup interrupted by a borrow -> the name resolves after the borrow", async (zeta: ReturnType<typeof fakeZeta>) => {
    zeta.held.add("state_projects");
    const { view } = mount(zeta, "/projects/p_target/memory");
    const reveal = await view.findByRole("button", { name: "take control and show decision text" });
    expect(view.getByRole("heading", { level: 1 }).textContent).toBe("Projects / …");
    zeta.held.delete("state_projects");
    await act(async () => { fireEvent.click(reveal); });
    await waitFor(() => expect(view.getByRole("heading", { level: 1 }).textContent).toBe("Projects / target"));
    expect(view.getByText("/fixture/target")).toBeTruthy();
  }],
  ["lookup fails on a live socket -> nothing stored, the name resolves on the next client", async (zeta: ReturnType<typeof fakeZeta>) => {
    zeta.busy.add("state_projects p2");
    const { view } = mount(zeta, "/projects/p_target/memory");
    const reveal = await view.findByRole("button", { name: "take control and show decision text" });
    await waitFor(() => expect(zeta.asked("state_projects")).toBe(3)); // list page 1, lookup page 1, lookup page 2 (busy)
    expect(view.getByRole("heading", { level: 1 }).textContent).toBe("Projects / …");
    await act(async () => { fireEvent.click(reveal); });
    await waitFor(() => expect(view.getByRole("heading", { level: 1 }).textContent).toBe("Projects / target"));
  }],
  ["load more interrupted by a borrow -> the next page loads after the borrow", async (zeta: ReturnType<typeof fakeZeta>) => {
    const { view } = mount(zeta, "/projects/p_target/memory");
    zeta.held.add("state_memory");
    fireEvent.click(await view.findByRole("button", { name: "load more" }));
    zeta.held.delete("state_memory");
    await act(async () => { fireEvent.click(view.getByRole("button", { name: "take control and show decision text" })); });
    await waitFor(() => expect(view.getByText("synthetic m_more")).toBeTruthy());
    expect(view.queryByText(/could not load more/)).toBeNull();
  }],
  ["overlapping reveals -> one borrow at a time, observer labels kept", async (zeta: ReturnType<typeof fakeZeta>) => {
    zeta.held.add("project_show");
    const { view } = mount(zeta, "/projects/p_target/memory");
    const first = await view.findByRole("button", { name: "take control and show brief text" });
    const other = view.getByRole("button", { name: "take control and show decision text" });
    await act(async () => { fireEvent.click(first); });
    await act(async () => { fireEvent.click(other); });
    // the hazard: a second read while the first borrow holds the controller socket.
    expect(zeta.asked("project_show")).toBe(1);
    expect(other.textContent).toBe("reading…");
    expect(other.getAttribute("aria-disabled")).toBe("true");
    expect(view.getByText(/Zeta lets only the tab in control read full text/)).toBeTruthy();
    await act(async () => zeta.release());
    expect(await view.findByRole("button", { name: "take control and show decision text" })).toBeTruthy();
    expect(view.getByRole("region", { name: "brief text" }).textContent).toContain("brief text body");
  }],
] as const)("%s", async (_name, run) => { await run(fakeZeta()); });

test("an open memory entry follows refresh and closes when removed", async () => {
  const row = { ...memory("m_review", "decision"), automatic: true, accepted: false };
  let rows = [row];
  const zeta = fakeZeta({ ...answers, state_memory: () => page(rows) });
  const client = zeta.connect() as unknown as ZetaClient;
  history.replaceState(null, "", "/projects/p_target/memory");
  const control = { observer: true, dropped: new Set<string>(), withControl: async () => ({ refused: "not used" }) };
  const actions: MemoryActions = { refresh: 0, working: false, feedback: null, dialog: null, start: async () => {}, dismiss: () => {} };
  const element = (refresh: number) => createElement(ProjectsModule, { client, control, actions: { ...actions, refresh } });
  const view = render(element(0));
  fireEvent.click(await view.findByRole("button", { name: row.summary }));
  const panel = () => within(view.getByRole("complementary", { name: "Decisions" }));
  expect(panel().getByRole("button", { name: "review accept" })).toBeTruthy();
  expect(panel().getByText(row.summary)).toBeTruthy();

  const accepted = { ...row, accepted: true, summary: "refreshed summary" };
  rows = [accepted];
  view.rerender(element(1));
  await view.findByRole("button", { name: accepted.summary });
  expect(!!panel().queryByRole("button", { name: "review accept" })).toBe(false);
  expect(!!panel().queryByText(row.summary)).toBe(false);
  expect(panel().getByText(accepted.summary)).toBeTruthy();
  expect(panel().getByText("Accepted")).toBeTruthy();

  rows = [];
  view.rerender(element(2));
  await view.findByText("no memory");
  expect(!!view.queryByRole("complementary", { name: "Decisions" })).toBe(false);

  rows = [accepted];
  view.rerender(element(3));
  await view.findByRole("button", { name: accepted.summary });
  expect(!!view.queryByRole("complementary", { name: "Decisions" })).toBe(false);
});
