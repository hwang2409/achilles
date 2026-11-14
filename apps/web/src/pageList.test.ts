import { describe, expect, test } from "bun:test";
import { createListOwner, initialListState, type ListPage, type ListState } from "./pageList";

type Item = { id: string };
type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void };
type Call = { key: string; before: string | null; signal: AbortSignal; result: Deferred<ListPage<Item, number>> };

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const items = (...ids: string[]): Item[] => ids.map((id) => ({ id }));
const page = (ids: string[], next: string | null, meta = ids.length): ListPage<Item, number> => ({ items: items(...ids), next, meta });

function harness() {
  const calls: Call[] = [];
  const states: Array<ListState<Item, number>> = [];
  let state = initialListState<Item, number>(0);
  const owner = createListOwner(state, (key, before, signal) => {
    const call = { key, before, signal, result: deferred<ListPage<Item, number>>() };
    calls.push(call);
    return call.result.promise;
  }, (item) => item.id, (next) => { state = next; states.push(next); });
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
      h.succeed(3, page(["fresh"], "fresh-next"));
      await fresh;
      h.succeed(2, page(["stale"], null));
      await stale;
      expect(h.state().items).toEqual(items("fresh", "two"));
    },
  },
  {
    name: "refresh after more keeps loaded older rows",
    run: async (h) => {
      await h.seed();
      const more = h.owner.more();
      h.succeed(1, page(["two"], "oldest"));
      await more;
      const refresh = h.owner.reload("all");
      h.succeed(2, page(["fresh"], "fresh-next"));
      await refresh;
      expect(h.state().items).toEqual(items("fresh", "two"));
      expect(h.state().next).toBe("oldest");
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
