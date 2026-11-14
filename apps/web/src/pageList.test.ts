import { describe, expect, test } from "bun:test";
import { createPageListOwner, initialPageListState, type PageLink, type PageListState } from "./pageList";

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void };
type TestResponse = { ok: boolean; status: number; json: () => Promise<unknown> };
type Call = { before: string | null; signal: AbortSignal; response: Deferred<TestResponse>; body: Deferred<unknown> };

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const page = (id: string): PageLink => ({ id, route: `/${id}`, title: id });
const result = (ids: string[], next: string | null) => ({ pages: ids.map(page), next });
const abortError = () => new DOMException("aborted", "AbortError");

function harness() {
  const calls: Call[] = [];
  const states: PageListState[] = [];
  let state = initialPageListState;
  const fetchPage = (before: string | null, signal: AbortSignal) => {
    const call = { before, signal, response: deferred<TestResponse>(), body: deferred<unknown>() };
    calls.push(call);
    return call.response.promise;
  };
  const owner = createPageListOwner(fetchPage, (next) => { state = next; states.push(next); });
  const open = (call: Call) => call.response.resolve({ ok: true, status: 200, json: () => call.body.promise });
  const succeed = (call: Call, value: ReturnType<typeof result>) => { open(call); call.body.resolve(value); };
  return { calls, states, owner, open, succeed, state: () => state };
}

async function seed(h: ReturnType<typeof harness>) {
  const loading = h.owner.reload();
  h.succeed(h.calls[0], result(["one"], "older"));
  await loading;
}

describe("page list owner", () => {
  test("loads the first page", async () => {
    const h = harness();
    const loading = h.owner.reload();
    expect(h.state()).toEqual({ ...initialPageListState, loading: true });
    h.succeed(h.calls[0], result(["one", "two"], "older"));
    await loading;
    expect(h.state()).toEqual({ pages: [page("one"), page("two")], next: "older", loading: false, error: false });
  });

  test("keeps the error through a retry and clears it only on success", async () => {
    const h = harness();
    const failed = h.owner.reload();
    h.calls[0].response.reject(new Error("offline"));
    await failed;
    expect(h.state().error).toBe(true);

    const retried = h.owner.reload();
    expect(h.state()).toEqual({ pages: null, next: null, loading: true, error: true });
    h.succeed(h.calls[1], result(["recovered"], null));
    await retried;
    expect(h.state()).toEqual({ pages: [page("recovered")], next: null, loading: false, error: false });
  });

  test.each([
    { phase: "before the retry response", openResponse: false },
    { phase: "while retry json is pending", openResponse: true },
  ])("show more is a no-op $phase", async ({ openResponse }) => {
    const h = harness();
    await seed(h);
    const continuation = h.owner.more();
    h.calls[1].response.reject(new Error("continuation failed"));
    await continuation;

    const retried = h.owner.reload();
    if (openResponse) h.open(h.calls[2]);
    expect(await h.owner.more()).toBeNull();
    expect(h.calls).toHaveLength(3);
    if (!openResponse) h.open(h.calls[2]);
    h.calls[2].body.resolve(result(["fresh"], "fresh-next"));
    await retried;
    expect(h.state().pages).toEqual([page("fresh")]);
  });

  test.each(["continuation first", "refresh first"])("create refresh drops an older continuation: %s", async (order) => {
    const h = harness();
    await seed(h);
    const continuation = h.owner.more();
    const refresh = h.owner.reload();
    expect(h.calls.map((call) => call.before)).toEqual([null, "older", null]);

    if (order === "continuation first") {
      h.succeed(h.calls[1], result(["stale"], null));
      await continuation;
      h.succeed(h.calls[2], result(["fresh"], "fresh-next"));
      await refresh;
    } else {
      h.succeed(h.calls[2], result(["fresh"], "fresh-next"));
      await refresh;
      h.succeed(h.calls[1], result(["stale"], null));
      await continuation;
    }
    expect(h.state()).toEqual({ pages: [page("fresh")], next: "fresh-next", loading: false, error: false });
  });

  test("duplicate show-more clicks make one request and focus only the accepted result", async () => {
    const h = harness();
    await seed(h);
    const first = h.owner.more();
    const duplicate = h.owner.more();
    expect(h.calls).toHaveLength(2);
    expect(await duplicate).toBeNull();
    h.succeed(h.calls[1], result(["two"], null));
    expect(await first).toEqual(page("two"));
    expect(h.state().pages).toEqual([page("one"), page("two")]);
  });

  test.each([
    { operation: "reload", stage: "fetch" },
    { operation: "reload", stage: "json" },
    { operation: "more", stage: "fetch" },
    { operation: "more", stage: "json" },
  ])("a rejected $operation $stage await publishes an error", async ({ operation, stage }) => {
    const h = harness();
    if (operation === "more") await seed(h);
    const pending = operation === "more" ? h.owner.more() : h.owner.reload();
    const call = h.calls.at(-1)!;
    if (stage === "json") h.open(call);
    (stage === "fetch" ? call.response : call.body).reject(new Error(`${stage} failed`));
    await pending;
    expect(h.state().error).toBe(true);
    expect(h.state().loading).toBe(false);
  });

  test.each([
    { operation: "reload", stage: "fetch" },
    { operation: "reload", stage: "json" },
    { operation: "more", stage: "fetch" },
    { operation: "more", stage: "json" },
  ])("an aborted $operation $stage await cannot overwrite its replacement", async ({ operation, stage }) => {
    const h = harness();
    if (operation === "more") await seed(h);
    const stale = operation === "more" ? h.owner.more() : h.owner.reload();
    const staleCall = h.calls.at(-1)!;
    if (stage === "json") h.open(staleCall);
    const replacement = h.owner.reload();
    const replacementCall = h.calls.at(-1)!;
    expect(staleCall.signal.aborted).toBe(true);
    (stage === "fetch" ? staleCall.response : staleCall.body).reject(abortError());
    await stale;
    h.succeed(replacementCall, result(["fresh"], null));
    await replacement;
    expect(h.state()).toEqual({ pages: [page("fresh")], next: null, loading: false, error: false });
  });

  test("a new owner restarts cleanly after the old owner is unmounted", async () => {
    const old = harness();
    const abandoned = old.owner.reload();
    old.owner.cancel();
    old.succeed(old.calls[0], result(["stale"], null));
    await abandoned;
    expect(old.states).toEqual([{ ...initialPageListState, loading: true }]);

    const restarted = harness();
    const loading = restarted.owner.reload();
    restarted.succeed(restarted.calls[0], result(["fresh"], null));
    await loading;
    expect(restarted.state().pages).toEqual([page("fresh")]);
  });
});
