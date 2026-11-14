import { describe, expect, test } from "bun:test";
import { createListOwner, initialListState, type ListPage, type ListState } from "./pageList";

type Item = { id: string };
type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void };
type Call = { key: string; before: string | null; signal: AbortSignal; limit?: number; result: Deferred<ListPage<Item, number>> };

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const items = (...ids: string[]): Item[] => ids.map((id) => ({ id }));
const page = (ids: string[], next: string | null, meta = ids.length): ListPage<Item, number> => ({ items: items(...ids), next, meta });

function harness(maxPageSize = 2) {
  const calls: Call[] = [];
  const states: Array<ListState<Item, number>> = [];
  let state = initialListState<Item, number>(0);
  const owner = createListOwner(state, (key, before, signal, limit) => {
    const call = { key, before, signal, limit, result: deferred<ListPage<Item, number>>() };
    calls.push(call);
    return call.result.promise;
  }, (item) => item.id, (next) => { state = next; states.push(next); }, Math.min(50, maxPageSize), maxPageSize);
  const succeed = (index: number, value: ListPage<Item, number>) => calls[index].result.resolve(value);
  const seed = async (key = "all") => {
    const pending = owner.reload(key);
    succeed(calls.length - 1, page(["one"], "older"));
    await pending;
  };
  return { calls, states, owner, seed, succeed, state: () => state };
}

type Scenario = (h: ReturnType<typeof harness>) => Promise<void>;

const scenarios: Array<{ name: string; run: Scenario }> = [
  {
    name: "success",
    run: async (h) => {
      await h.seed();
      const more = h.owner.more();
      h.succeed(1, page(["two"], null, 2));
      expect(await more).toEqual({ id: "two" });
      expect(h.state()).toEqual({ items: items("one", "two"), next: null, loading: false, error: false, meta: 2 });
    },
  },
  {
    name: "a stale first page after more cannot overwrite newer state",
    run: async (h) => {
      await h.seed();
      const more = h.owner.more();
      h.succeed(1, page(["two"], "oldest"));
      await more;
      const stale = h.owner.reload("all");
      const fresh = h.owner.reload("all");
      expect(h.calls[2].signal.aborted).toBe(true);
      h.succeed(3, page(["fresh"], null));
      await fresh;
      h.succeed(2, page(["stale"], null));
      await stale;
      expect(h.state().items).toEqual(items("fresh"));
    },
  },
  {
    name: "more during refresh extends that refresh instead of publishing an old cursor",
    run: async (h) => {
      const initial = h.owner.reload("all");
      h.succeed(0, page(["A", "B"], "B"));
      await initial;
      const refresh = h.owner.reload("all");
      const more = h.owner.more();
      expect(h.calls.map(({ before }) => before)).toEqual([null, null]);
      h.succeed(1, page(["X", "A"], "A"));
      await Promise.resolve();
      expect(h.calls[2].before).toBe("A");
      h.succeed(2, page(["B", "D"], "D"));
      await refresh;
      expect(await more).toEqual({ id: "D" });
      expect(h.state().items).toEqual(items("X", "A", "B", "D"));
    },
  },
  ...(["continuation first", "refresh first"] as const).map((order) => ({
    name: `more then reload keeps the requested depth: ${order}`,
    run: async (h: ReturnType<typeof harness>) => {
      const initial = h.owner.reload("all");
      h.succeed(0, page(["A", "B"], "B"));
      await initial;
      const more = h.owner.more();
      const refresh = h.owner.reload("all");
      expect(h.calls[1].signal.aborted).toBe(true);
      if (order === "continuation first") {
        h.succeed(1, page(["C", "D"], "D"));
        expect(await more).toBeNull();
      }
      h.succeed(2, page(["X", "A"], "A"));
      await Promise.resolve();
      h.succeed(3, page(["B", "D"], "D"));
      await refresh;
      if (order === "refresh first") {
        h.succeed(1, page(["C", "D"], "D"));
        expect(await more).toBeNull();
      }
      expect(h.state().items).toEqual(items("X", "A", "B", "D"));
    },
  })),
  {
    name: "two more requests during a reload extend its target twice",
    run: async (h) => {
      const initial = h.owner.reload("all");
      h.succeed(0, page(["A", "B"], "B"));
      await initial;
      const refresh = h.owner.reload("all");
      const first = h.owner.more();
      const second = h.owner.more();
      h.succeed(1, page(["X", "A"], "A"));
      await Promise.resolve();
      h.succeed(2, page(["B", "C"], "C"));
      await Promise.resolve();
      h.succeed(3, page(["D", "E"], "E"));
      await refresh;
      expect(await first).toEqual({ id: "C" });
      expect(await second).toEqual({ id: "C" });
      expect(h.state().items).toEqual(items("X", "A", "B", "C", "D", "E"));
    },
  },
  {
    name: "reload failure settles a pending more request",
    run: async (h) => {
      await h.seed();
      const refresh = h.owner.reload("all");
      const more = h.owner.more();
      h.calls[1].result.reject(new Error("offline"));
      await refresh;
      expect(await more).toBeNull();
      expect(h.state().error).toBe(true);
      expect(h.state().loading).toBe(false);
    },
  },
  {
    name: "refresh replaces the loaded depth when a row crosses the page boundary",
    run: async (h) => {
      const initial = h.owner.reload("all");
      h.succeed(0, page(["A", "B"], "B"));
      await initial;
      const more = h.owner.more();
      h.succeed(1, page(["C", "D"], "D"));
      await more;
      const refresh = h.owner.reload("all");
      expect(h.calls[2].limit).toBe(2);
      h.succeed(2, page(["C", "A"], "A"));
      await Promise.resolve();
      expect(h.calls[3].before).toBe("A");
      expect(h.calls[3].limit).toBe(2);
      h.succeed(3, page(["B", "D"], "D"));
      await refresh;
      expect(h.state().items).toEqual(items("C", "A", "B", "D"));
      expect(h.state().next).toBe("D");
    },
  },
  {
    name: "refresh keeps 120 loaded rows when the oldest row moves to the top",
    run: async () => {
      const h = harness(200);
      const ids = Array.from({ length: 120 }, (_, index) => String(index));
      const initial = h.owner.reload("all");
      h.succeed(0, page(ids.slice(0, 50), "49"));
      await initial;
      const second = h.owner.more();
      h.succeed(1, page(ids.slice(50, 100), "99"));
      await second;
      const third = h.owner.more();
      h.succeed(2, page(ids.slice(100), null));
      await third;
      const refresh = h.owner.reload("all");
      expect(h.calls[3].limit).toBe(120);
      h.succeed(3, page(["119", ...ids.slice(0, 119)], null));
      await refresh;
      expect(h.state().items).toHaveLength(120);
      expect(h.state().items?.map(({ id }) => id)).toEqual(["119", ...ids.slice(0, 119)]);
      expect(new Set(h.state().items?.map(({ id }) => id))).toEqual(new Set(ids));
    },
  },
  {
    name: "refresh shows an updated row once and removes a deleted row",
    run: async (h) => {
      const initial = h.owner.reload("all");
      h.succeed(0, page(["A", "B"], null));
      await initial;
      const refresh = h.owner.reload("all");
      h.succeed(1, page(["B"], null));
      await refresh;
      expect(h.state().items).toEqual(items("B"));
    },
  },
  {
    name: "initial failure is an error that can retry",
    run: async (h) => {
      const failed = h.owner.reload("all");
      h.calls[0].result.reject(new Error("offline"));
      await failed;
      expect(h.state()).toEqual({ items: null, next: null, loading: false, error: true, meta: 0 });
      const retry = h.owner.reload("all");
      h.succeed(1, page(["one"], null));
      await retry;
      expect(h.state().items).toEqual(items("one"));
      expect(h.state().error).toBe(false);
    },
  },
  {
    name: "failed search does not show rows from the previous search",
    run: async (h) => {
      await h.seed("old search");
      const failed = h.owner.reload("new search");
      h.calls[1].result.reject(new Error("offline"));
      await failed;
      expect(h.state().items).toBeNull();
      expect(h.state().error).toBe(true);
    },
  },
  {
    name: "more failure can retry",
    run: async (h) => {
      await h.seed();
      const failed = h.owner.more();
      h.calls[1].result.reject(new Error("offline"));
      await failed;
      expect(h.state().error).toBe(true);
      const retry = h.owner.more();
      h.succeed(2, page(["two"], null));
      await retry;
      expect(h.state().items).toEqual(items("one", "two"));
      expect(h.state().error).toBe(false);
    },
  },
  {
    name: "search change cancels an in-flight more",
    run: async (h) => {
      await h.seed("old search");
      const stale = h.owner.more();
      const replacement = h.owner.reload("new search");
      expect(h.calls[1].signal.aborted).toBe(true);
      h.succeed(2, page(["new"], null));
      await replacement;
      h.succeed(1, page(["stale"], null));
      await stale;
      expect(h.state().items).toEqual(items("new"));
    },
  },
  {
    name: "duplicate more makes one request",
    run: async (h) => {
      await h.seed();
      const accepted = h.owner.more();
      const duplicate = h.owner.more();
      expect(h.calls).toHaveLength(2);
      expect(await duplicate).toBeNull();
      h.succeed(1, page(["two"], null));
      await accepted;
      expect(h.state().items).toEqual(items("one", "two"));
    },
  },
];

describe("ordered list owner", () => {
  test.each(scenarios)("$name", async ({ run }) => {
    await run(harness());
  });
});
