import "../test-dom";
import { afterEach, expect, test } from "bun:test";
import { createElement } from "react";
import { ZetaError, type ZetaClient } from "@fulcrum/zeta";

// after test-dom: React must see the registered DOM.
const { act, cleanup, fireEvent, render, waitFor } = await import("@testing-library/react");
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

/** One zeta: `held` methods never answer until the socket that asked closes; `release()` answers a held show. */
function fakeZeta() {
  const held = new Set<string>();
  const shows: (() => void)[] = [];
  const connect = () => {
    const rejects = new Set<(error: unknown) => void>();
    const client = {
      features: ["state_read_v1"],
      closed: false,
      request: (method: string, params: { cursor?: string | null }) => new Promise((resolve, reject) => {
        if (client.closed) return reject(new ZetaError("closed", 1006));
        rejects.add(reject);
        const answer = () => { rejects.delete(reject); resolve(answers[method]!(params)); };
        if (method === "project_show" && held.has(method)) shows.push(answer);
        else if (!held.has(method)) answer();
      }),
      close() { client.closed = true; rejects.forEach((reject) => reject(new ZetaError("closed", 1006))); rejects.clear(); },
    };
    return client;
  };
  return { held, connect, release: () => shows.splice(0).forEach((answer) => answer()) };
}

/** The page as SurfaceRouter wires it: a borrow swaps in a controller client, closes the observer, reads, and swaps back. */
function mount(zeta: ReturnType<typeof fakeZeta>, path: string) {
  history.replaceState(null, "", path);
  let client = zeta.connect();
  let observer = true;
  let borrows = 0;
  const element = () => createElement(ProjectsModule, { client: client as unknown as ZetaClient, control: { observer, dropped: new Set(), withControl } });
  const view = render(element());
  const swap = (next: typeof client, role: boolean) => { const old = client; client = next; observer = role; act(() => view.rerender(element())); old.close(); };
  async function withControl<T>(read: (reader: ZetaClient) => Promise<T>) {
    borrows++;
    swap(zeta.connect(), false);
    try { return { value: await read(client as unknown as ZetaClient) }; } finally { swap(zeta.connect(), true); }
  }
  return { view, borrows: () => borrows };
}

test.each([
  ["lookup interrupted by a borrow -> the name resolves after the borrow", async (zeta: ReturnType<typeof fakeZeta>) => {
    zeta.held.add("state_projects");
    const { view } = mount(zeta, "/projects/p_target/memory");
    const reveal = await view.findByRole("button", { name: "take control and show decision text" });
    expect(view.getByRole("heading", { level: 1 }).textContent).toBe("projects / …");
    zeta.held.delete("state_projects");
    await act(async () => { fireEvent.click(reveal); });
    await waitFor(() => expect(view.getByRole("heading", { level: 1 }).textContent).toBe("projects / target"));
    expect(view.getByText("/fixture/target")).toBeTruthy();
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
    const { view, borrows } = mount(zeta, "/projects/p_target/memory");
    const first = await view.findByRole("button", { name: "take control and show brief text" });
    await act(async () => { fireEvent.click(first); });
    const other = view.getByRole("button", { name: "reading…" });
    expect(other.getAttribute("aria-disabled")).toBe("true");
    expect(view.getByText(/zeta lets only the tab in control read full text/)).toBeTruthy();
    await act(async () => { fireEvent.click(other); });
    expect(borrows()).toBe(1);
    await act(async () => zeta.release());
    expect(await view.findByRole("button", { name: "take control and show decision text" })).toBeTruthy();
    expect(view.getByRole("region", { name: "brief text" }).textContent).toContain("brief text body");
  }],
] as const)("%s", async (_name, run) => { await run(fakeZeta()); });
