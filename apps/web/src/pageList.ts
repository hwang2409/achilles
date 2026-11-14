export type PageLink = { id: string; route: string; title: string };
export type PageListState = {
  pages: PageLink[] | null;
  next: string | null;
  loading: boolean;
  error: boolean;
};

type PageResult = { pages: PageLink[]; next: string | null };
type PageResponse = { ok: boolean; status: number; json: () => Promise<unknown> };
type FetchPage = (before: string | null, signal: AbortSignal) => Promise<PageResponse>;

export const initialPageListState: PageListState = { pages: null, next: null, loading: false, error: false };

const aborted = (error: unknown) => error instanceof DOMException && error.name === "AbortError";

export function createPageListOwner(fetchPage: FetchPage, publish: (state: PageListState) => void) {
  let state = initialPageListState;
  let generation = 0;
  let continuation = false;
  let controller: AbortController | null = null;

  const update = (next: PageListState) => {
    state = next;
    publish(state);
  };
  const request = async (before: string | null, signal: AbortSignal) => {
    const response = await fetchPage(before, signal);
    if (!response.ok) throw new Error(`could not load pages (${response.status})`);
    return await response.json() as PageResult;
  };
  const reload = async () => {
    const owned = ++generation;
    controller?.abort();
    continuation = false;
    controller = new AbortController();
    update({ ...state, loading: true });
    try {
      const result = await request(null, controller.signal);
      if (owned !== generation) return;
      update({ pages: result.pages, next: result.next, loading: false, error: false });
    } catch (error) {
      if (owned !== generation) return;
      update({ ...state, loading: false, error: aborted(error) ? state.error : true });
    } finally {
      if (owned === generation) controller = null;
    }
  };
  const more = async () => {
    if (state.loading || state.error || !state.next || continuation) return null;
    const owned = generation;
    const before = state.next;
    continuation = true;
    controller = new AbortController();
    update({ ...state, loading: true });
    try {
      const result = await request(before, controller.signal);
      if (owned !== generation) return null;
      update({ pages: [...(state.pages ?? []), ...result.pages], next: result.next, loading: false, error: false });
      return result.pages[0] ?? null;
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

export type PageListOwner = ReturnType<typeof createPageListOwner>;
