export type ListPage<T, M> = { items: T[]; next: string | null; meta: M };
export type ListState<T, M> = {
  items: T[] | null;
  next: string | null;
  loading: boolean;
  error: boolean;
  meta: M;
};

type FetchPage<K, T, M> = (key: K, before: string | null, signal: AbortSignal) => Promise<ListPage<T, M>>;

const aborted = (error: unknown) => error instanceof DOMException && error.name === "AbortError";

export function initialListState<T, M>(meta: M): ListState<T, M> {
  return { items: null, next: null, loading: false, error: false, meta };
}

export function createListOwner<K, T, M>(
  initial: ListState<T, M>,
  fetchPage: FetchPage<K, T, M>,
  itemKey: (item: T) => string,
  publish: (state: ListState<T, M>) => void,
) {
  let state = initial;
  let generation = 0;
  let activeKey: K | undefined;
  let older: T[] = [];
  let continuation = false;
  let controller: AbortController | null = null;

  const update = (next: ListState<T, M>) => {
    state = next;
    publish(state);
  };
  const reload = async (key: K) => {
    const keyChanged = activeKey === undefined || !Object.is(activeKey, key);
    const owned = ++generation;
    activeKey = key;
    controller?.abort();
    continuation = false;
    controller = new AbortController();
    if (keyChanged) {
      older = [];
      update({ ...state, next: null, loading: true, error: false });
    } else {
      update({ ...state, loading: true });
    }
    try {
      const result = await fetchPage(key, null, controller.signal);
      if (owned !== generation) return;
      const firstKeys = new Set(result.items.map(itemKey));
      older = older.filter((item) => !firstKeys.has(itemKey(item)));
      update({ items: [...result.items, ...older], next: older.length ? state.next : result.next, loading: false, error: false, meta: result.meta });
    } catch (error) {
      if (owned !== generation) return;
      update({ ...state, loading: false, error: aborted(error) ? state.error : true });
    } finally {
      if (owned === generation) controller = null;
    }
  };
  const more = async () => {
    if (activeKey === undefined || state.loading || !state.next || continuation) return null;
    const owned = generation;
    const key = activeKey;
    const before = state.next;
    continuation = true;
    controller = new AbortController();
    update({ ...state, loading: true });
    try {
      const result = await fetchPage(key, before, controller.signal);
      if (owned !== generation) return null;
      const existing = new Set((state.items ?? []).map(itemKey));
      const accepted = result.items.filter((item) => !existing.has(itemKey(item)));
      older = [...older, ...accepted];
      update({ items: [...(state.items ?? []), ...accepted], next: result.items.length ? result.next : null, loading: false, error: false, meta: result.meta });
      return accepted[0] ?? null;
    } catch (error) {
      if (owned !== generation) return null;
      update({ ...state, loading: false, error: aborted(error) ? state.error : true });
      return null;
    } finally {
      if (owned === generation) {
        continuation = false;
        controller = null;
      }
    }
  };
  const cancel = () => {
    generation += 1;
    continuation = false;
    controller?.abort();
    controller = null;
  };

  return { reload, more, cancel };
}

export type ListOwner<K, T, M> = ReturnType<typeof createListOwner<K, T, M>>;
