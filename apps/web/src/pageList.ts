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
  let state = initial;
  let generation = 0;
  let activeKey: K | undefined;
  let continuation = false;
  const controllers = new Set<AbortController>();

  const update = (next: ListState<T, M>) => {
    state = next;
    publish(state);
  };
  const reload = async (key: K) => {
    const keyChanged = activeKey === undefined || !Object.is(activeKey, key);
    const owned = ++generation;
    activeKey = key;
    for (const active of controllers) active.abort();
    controllers.clear();
    continuation = false;
    const controller = new AbortController();
    controllers.add(controller);
    const loadedDepth = keyChanged ? 0 : Math.max(firstPageSize, state.items?.length ?? 0);
    update(keyChanged ? { ...state, next: null, loading: true, error: false } : { ...state, loading: true, error: false });
    try {
      const items: T[] = [];
      let before: string | null = null;
      let result: ListPage<T, M>;
      do {
        const targetDepth = Math.max(loadedDepth, state.items?.length ?? 0);
        const limit = targetDepth ? Math.min(maxPageSize, targetDepth - items.length) : undefined;
        result = await fetchPage(key, before, controller.signal, limit);
        if (owned !== generation) return;
        items.push(...result.items);
        before = result.next;
      } while (before && items.length < Math.max(loadedDepth, state.items?.length ?? 0));
      update({ items, next: result.next, loading: false, error: false, meta: result.meta });
    } catch (error) {
      if (owned !== generation) return;
      const failed = !aborted(error);
      update({ ...state, items: failed && keyChanged ? null : state.items, next: failed && keyChanged ? null : state.next, loading: false, error: failed ? true : state.error });
    } finally {
      controllers.delete(controller);
    }
  };
  const more = async () => {
    if (activeKey === undefined || !state.next || continuation) return null;
    const owned = generation;
    const key = activeKey;
    const before = state.next;
    continuation = true;
    const controller = new AbortController();
    controllers.add(controller);
    update({ ...state, loading: true });
    try {
      const result = await fetchPage(key, before, controller.signal);
      if (owned !== generation) return null;
      const existing = new Set((state.items ?? []).map(itemKey));
      const accepted = result.items.filter((item) => !existing.has(itemKey(item)));
      update({ items: [...(state.items ?? []), ...accepted], next: result.items.length ? result.next : null, loading: false, error: false, meta: result.meta });
      return accepted[0] ?? null;
    } catch (error) {
      if (owned !== generation) return null;
      update({ ...state, loading: false, error: aborted(error) ? state.error : true });
      return null;
    } finally {
      if (owned === generation) {
        continuation = false;
        controllers.delete(controller);
      }
    }
  };
  const cancel = () => {
    generation += 1;
    continuation = false;
    for (const active of controllers) active.abort();
    controllers.clear();
  };

  return { reload, more, cancel };
}

export type ListOwner<K, T, M> = ReturnType<typeof createListOwner<K, T, M>>;
