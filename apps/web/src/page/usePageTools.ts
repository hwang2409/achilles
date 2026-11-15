import { useCallback, useSyncExternalStore } from "react";

export type PageTool = { name: string; operation: string; collection: string; input_schema: unknown; data_schema?: unknown; version: number };
type Snapshot = { tools: PageTool[] | null; error: string | null };
type Entry = { snapshot: Snapshot; listeners: Set<() => void> };

// One owner for GET /api/pages/{id}/tools: FormBlock and EmptyChat both need a page's tool
// list, so a page that mounts both issues one request, not two. Keyed on pageId+credential+
// refreshKey; each live key keeps its own cache entry, dropped once nothing subscribes to it.
const entries = new Map<string, Entry>();

function keyOf(pageId: string, credential: string, refreshKey: string): string {
  return `${pageId}\u0000${credential}\u0000${refreshKey}`;
}

function load(key: string, pageId: string, credential: string): void {
  void fetch(`/api/pages/${pageId}/tools`, { headers: { Authorization: `Bearer ${credential}` }, cache: "no-store" })
    .then(async (response) => {
      if (!response.ok) throw new Error(`could not load tools (${response.status})`);
      const body = await response.json() as { tools?: PageTool[] };
      return body.tools ?? [];
    })
    .then((tools) => resolve(key, { tools, error: null }))
    .catch((caught) => resolve(key, { tools: null, error: caught instanceof Error ? caught.message : String(caught) }));
}

function resolve(key: string, snapshot: Snapshot): void {
  const entry = entries.get(key);
  if (!entry) return; // the last subscriber left before the fetch settled; drop the result.
  entry.snapshot = snapshot;
  for (const listener of entry.listeners) listener();
}

function entryFor(key: string, pageId: string, credential: string): Entry {
  let entry = entries.get(key);
  if (!entry) {
    entry = { snapshot: { tools: null, error: null }, listeners: new Set() };
    entries.set(key, entry);
    load(key, pageId, credential);
  }
  return entry;
}

// tools is null while loading; error carries a fetch/HTTP failure for callers that want to show it.
export function usePageTools(pageId: string, credential: string, refreshKey: string): Snapshot {
  const key = keyOf(pageId, credential, refreshKey);
  // subscribe/getSnapshot must keep a stable identity across re-renders for the same key:
  // useSyncExternalStore resubscribes whenever the subscribe function identity changes, and an
  // inline closure here would resubscribe (and thus delete+recreate the cache entry) on every
  // unrelated re-render, causing a refetch loop.
  const subscribe = useCallback((listener: () => void) => {
    const entry = entryFor(key, pageId, credential);
    entry.listeners.add(listener);
    return () => {
      entry.listeners.delete(listener);
      if (entry.listeners.size === 0) entries.delete(key);
    };
  }, [key, pageId, credential]);
  const getSnapshot = useCallback(() => entryFor(key, pageId, credential).snapshot, [key, pageId, credential]);
  return useSyncExternalStore(subscribe, getSnapshot);
}
