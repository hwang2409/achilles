export type ListPage<T, M> = { items: T[]; next: string | null; meta: M };
export type ListState<T, M> = {
  items: T[] | null;
  next: string | null;
  loading: boolean;
  error: boolean;
  meta: M;
};

type FetchPage<K, T, M> = (key: K, before: string | null, signal: AbortSignal, limit?: number) => Promise<ListPage<T, M>>;

const aborted = (error: unknown) => error instanceof DOMException && error.name === "AbortError";

export function initialListState<T, M>(meta: M): ListState<T, M> {
  return { items: null, next: null, loading: false, error: false, meta };
}

export function createListOwner<K, T, M>(
  initial: ListState<T, M>,
  fetchPage: FetchPage<K, T, M>,
  itemKey: (item: T) => string,
  publish: (state: ListState<T, M>) => void,
  firstPageSize: number,
  maxPageSize: number,
) {
  type MoreWaiter = { index: number; after?: string; resolve: (item: T | null) => void };
  type Operation = {
    kind: "refresh" | "more";
    generation: number;
    controller: AbortController;
    targetDepth: number;
    waiters: MoreWaiter[];
    finish: () => void;
  };

  let state = initial;
  let generation = 0;
  let activeKey: K | undefined;
  let operation: Operation | null = null;

  const update = (next: ListState<T, M>) => {
    state = next;
    publish(state);
  };
  const owns = (candidate: Operation) => operation === candidate && candidate.generation === generation;
  const waiterItem = (waiter: MoreWaiter, items: T[] | null) => {
    if (!items) return null;
    const anchor = waiter.after === undefined ? -1 : items.findIndex((item) => itemKey(item) === waiter.after);
    return items[anchor >= 0 ? anchor + 1 : waiter.index] ?? null;
  };
  const settle = (candidate: Operation, items: T[] | null = null) => {
    for (const waiter of candidate.waiters) waiter.resolve(waiterItem(waiter, items));
    candidate.finish();
    if (operation === candidate) operation = null;
  };
  const stop = () => {
    if (!operation) return;
    operation.controller.abort();
    settle(operation);
  };
  const unique = (existing: T[], incoming: T[]) => {
    const keys = new Set(existing.map(itemKey));
    return incoming.filter((item) => !keys.has(itemKey(item)));
  };
  const runRefresh = async (candidate: Operation, key: K, keyChanged: boolean) => {
    const items: T[] = [];
    let before: string | null = null;
    let result: ListPage<T, M> | null = null;
    try {
      do {
        const limit = candidate.targetDepth ? Math.min(maxPageSize, candidate.targetDepth - items.length) : undefined;
        result = await fetchPage(key, before, candidate.controller.signal, limit);
        if (!owns(candidate)) return;
        items.push(...result.items);
        before = result.next;
      } while (before && items.length < candidate.targetDepth);
      update({ items, next: result.next, loading: false, error: false, meta: result.meta });
      settle(candidate, items);
    } catch (error) {
      if (!owns(candidate)) return;
      const failed = !aborted(error);
      update({ ...state, items: failed && keyChanged ? null : state.items, next: failed && keyChanged ? null : state.next, loading: false, error: failed ? true : state.error });
      settle(candidate);
    }
  };
  const runMore = async (candidate: Operation, key: K, before: string) => {
    try {
      const result = await fetchPage(key, before, candidate.controller.signal);
      if (!owns(candidate)) return;
      const accepted = unique(state.items ?? [], result.items);
      const items = [...(state.items ?? []), ...accepted];
      update({ items, next: result.items.length ? result.next : null, loading: false, error: false, meta: result.meta });
      settle(candidate, items);
    } catch (error) {
      if (!owns(candidate)) return;
      update({ ...state, loading: false, error: aborted(error) ? state.error : true });
      settle(candidate);
    }
  };
  const makeOperation = (kind: Operation["kind"], targetDepth: number) => {
    let finish!: () => void;
    const done = new Promise<void>((resolve) => { finish = resolve; });
    const candidate: Operation = { kind, generation, controller: new AbortController(), targetDepth, waiters: [], finish };
    operation = candidate;
    return { candidate, done };
  };
  const replacementDepth = (currentDepth: number, active: Operation | null) =>
    active?.kind === "refresh" ? active.targetDepth : currentDepth + (active?.kind === "more" ? firstPageSize : 0);
  const reload = (key: K) => {
    const keyChanged = activeKey === undefined || !Object.is(activeKey, key);
    const currentDepth = state.items?.length ?? 0;
    const requestedDepth = replacementDepth(currentDepth, operation);
    stop();
    generation += 1;
    activeKey = key;
    const loadedDepth = keyChanged ? 0 : Math.max(firstPageSize, currentDepth, requestedDepth);
    const { candidate, done } = makeOperation("refresh", loadedDepth);
    update(keyChanged ? { ...state, next: null, loading: true, error: false } : { ...state, loading: true, error: false });
    void runRefresh(candidate, key, keyChanged);
    return done;
  };
  const more = () => {
    if (activeKey === undefined || !state.next) return Promise.resolve(null);
    if (operation?.kind === "refresh") {
      const candidate = operation;
      const index = candidate.targetDepth;
      candidate.targetDepth += firstPageSize;
      const after = state.items?.at(-1);
      return new Promise<T | null>((resolve) => candidate.waiters.push({ index, after: after && itemKey(after), resolve }));
    }
    if (operation) return Promise.resolve(null);
    const key = activeKey;
    const before = state.next;
    const index = state.items?.length ?? 0;
    const { candidate } = makeOperation("more", index + firstPageSize);
    update({ ...state, loading: true });
    return new Promise<T | null>((resolve) => {
      const after = state.items?.at(-1);
      candidate.waiters.push({ index, after: after && itemKey(after), resolve });
      void runMore(candidate, key, before);
    });
  };
  const cancel = () => {
    stop();
    generation += 1;
  };

  return { reload, more, cancel };
}

export type ListOwner<K, T, M> = ReturnType<typeof createListOwner<K, T, M>>;
