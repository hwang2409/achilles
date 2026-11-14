type Listener = () => void;
type StoredDraft = { text: string; updatedAt: number };

const STORAGE_KEY = "achilles:composer-drafts";
const MAX_DRAFTS = 20;
const MAX_STORAGE_CHARS = 512 * 1024;
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const drafts = new Map<string, StoredDraft>();
const listeners = new Map<string, Set<Listener>>();
let loaded = false;

const storage = () => {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
};

const load = () => {
  if (loaded) return;
  loaded = true;
  try {
    const saved = JSON.parse(storage()?.getItem(STORAGE_KEY) ?? "{}") as Record<string, unknown>;
    const oldest = Date.now() - MAX_AGE_MS;
    for (const [sessionId, value] of Object.entries(saved)) {
      if (!value || typeof value !== "object") continue;
      const { text, updatedAt } = value as Partial<StoredDraft>;
      if (typeof text === "string" && text && typeof updatedAt === "number" && updatedAt >= oldest)
        drafts.set(sessionId, { text, updatedAt });
    }
    persist();
  } catch {
    // A bad or unavailable browser store must not stop the composer.
  }
};

function persist() {
  const target = storage();
  if (!target) return;
  const oldest = Date.now() - MAX_AGE_MS;
  const entries = [...drafts.entries()]
    .filter(([, value]) => value.updatedAt >= oldest)
    .sort((a, b) => b[1].updatedAt - a[1].updatedAt)
    .slice(0, MAX_DRAFTS);
  const kept: Record<string, StoredDraft> = {};
  for (const [sessionId, value] of entries) {
    const candidate = { ...kept, [sessionId]: value };
    if (JSON.stringify(candidate).length > MAX_STORAGE_CHARS) continue;
    kept[sessionId] = value;
  }
  try {
    if (Object.keys(kept).length) target.setItem(STORAGE_KEY, JSON.stringify(kept));
    else target.removeItem(STORAGE_KEY);
  } catch {
    // Keep the in-memory draft when storage is full or unavailable.
  }
}

const notify = (sessionId: string) => {
  for (const listener of listeners.get(sessionId) ?? []) listener();
};

export const draftStore = {
  get(sessionId: string) {
    load();
    return drafts.get(sessionId)?.text ?? "";
  },
  set(sessionId: string, text: string) {
    load();
    if (drafts.get(sessionId)?.text === text || (!drafts.has(sessionId) && text === "")) return;
    if (text) drafts.set(sessionId, { text, updatedAt: Date.now() });
    else drafts.delete(sessionId);
    persist();
    notify(sessionId);
  },
  clear(sessionId: string) {
    load();
    if (!drafts.delete(sessionId)) return;
    persist();
    notify(sessionId);
  },
  subscribe(sessionId: string, listener: Listener) {
    const sessionListeners = listeners.get(sessionId) ?? new Set<Listener>();
    sessionListeners.add(listener);
    listeners.set(sessionId, sessionListeners);
    return () => {
      sessionListeners.delete(listener);
      if (!sessionListeners.size) listeners.delete(sessionId);
    };
  },
};
