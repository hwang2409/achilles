type Listener = () => void;
type StoredDraft = { text: string; updatedAt: number };

type DraftStore = {
  get(sessionId: string): string;
  set(sessionId: string, text: string): void;
  confirm(sessionId: string, sent: string): void;
  subscribe(sessionId: string, listener: Listener): () => void;
  subscribeConfirm(sessionId: string, listener: Listener): () => void;
  subscribeRemote(sessionId: string, listener: Listener): () => void;
};

const PREFIX = "achilles:draft:";
const MAX_DRAFTS = 20;
const MAX_DRAFT_BYTES = 64 * 1024;
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

const storage = () => {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
};

const parse = (value: string | null): StoredDraft | undefined => {
  try {
    const parsed = JSON.parse(value ?? "null") as Partial<StoredDraft>;
    if (typeof parsed.text === "string" && parsed.text && typeof parsed.updatedAt === "number") return parsed as StoredDraft;
  } catch {
    // A corrupt browser entry must not stop the composer.
  }
  return undefined;
};

export function createDraftStore(): DraftStore {
  const drafts = new Map<string, StoredDraft>();
  const dirty = new Set<string>();
  const listeners = new Map<string, Set<Listener>>();
  const confirmListeners = new Map<string, Set<Listener>>();
  const remoteListeners = new Map<string, Set<Listener>>();
  let loaded = false;

  const notify = (sessionId: string) => {
    for (const listener of listeners.get(sessionId) ?? []) listener();
  };
  const notifyConfirm = (sessionId: string) => {
    for (const listener of confirmListeners.get(sessionId) ?? []) listener();
  };
  const notifyRemote = (sessionId: string) => {
    for (const listener of remoteListeners.get(sessionId) ?? []) listener();
  };

  const load = () => {
    if (loaded) return;
    loaded = true;
    const target = storage();
    if (!target) return;
    const oldest = Date.now() - MAX_AGE_MS;
    const entries: [string, StoredDraft][] = [];
    try {
      for (let index = 0; index < target.length; index += 1) {
        const key = target.key(index);
        if (!key?.startsWith(PREFIX)) continue;
        const sessionId = key.slice(PREFIX.length);
        const value = parse(target.getItem(key));
        if (!value || value.updatedAt < oldest) {
          target.removeItem(key);
          continue;
        }
        entries.push([sessionId, value]);
      }
      entries.sort((a, b) => b[1].updatedAt - a[1].updatedAt);
      for (const [sessionId, value] of entries.slice(0, MAX_DRAFTS)) drafts.set(sessionId, value);
      for (const [sessionId] of entries.slice(MAX_DRAFTS)) target.removeItem(PREFIX + sessionId);
    } catch {
      // A disabled or unavailable browser store must not stop the composer.
    }
  };

  const onStorage = (event: StorageEvent) => {
    if (event.storageArea && event.storageArea !== storage()) return;
    if (!event.key?.startsWith(PREFIX)) return;
    const sessionId = event.key.slice(PREFIX.length);
    if (dirty.has(sessionId)) return;
    const value = parse(event.newValue);
    if (value) drafts.set(sessionId, value);
    else drafts.delete(sessionId);
    notifyRemote(sessionId);
  };
  globalThis.addEventListener?.("storage", onStorage);

  const clear = (sessionId: string) => {
    load();
    dirty.delete(sessionId);
    drafts.delete(sessionId);
    try { storage()?.removeItem(PREFIX + sessionId); } catch { /* keep the in-memory clear */ }
    notify(sessionId);
  };

  const store: DraftStore = {
    get(sessionId) {
      load();
      return drafts.get(sessionId)?.text ?? "";
    },
    set(sessionId, text) {
      load();
      if (drafts.get(sessionId)?.text === text && (text || !dirty.has(sessionId))) return;
      dirty.add(sessionId);
      const target = storage();
      if (text && new TextEncoder().encode(text).byteLength <= MAX_DRAFT_BYTES) {
        const value = { text, updatedAt: Date.now() };
        drafts.set(sessionId, value);
        try {
          target?.setItem(PREFIX + sessionId, JSON.stringify(value));
          if (target) {
            const entries: [string, StoredDraft][] = [];
            for (let index = 0; index < target.length; index += 1) {
              const key = target.key(index);
              if (!key?.startsWith(PREFIX)) continue;
              const stored = parse(target.getItem(key));
              if (stored) entries.push([key.slice(PREFIX.length), stored]);
            }
            entries.sort((a, b) => b[1].updatedAt - a[1].updatedAt);
            for (const [oldSessionId] of entries.slice(MAX_DRAFTS)) {
              target.removeItem(PREFIX + oldSessionId);
              if (oldSessionId !== sessionId) drafts.delete(oldSessionId);
            }
          }
        } catch { /* keep the in-memory draft */ }
      } else {
        if (text) drafts.set(sessionId, { text, updatedAt: Date.now() });
        else drafts.delete(sessionId);
        try { target?.removeItem(PREFIX + sessionId); } catch { /* keep the in-memory draft */ }
      }
      notify(sessionId);
    },
    confirm(sessionId, sent) {
      const current = store.get(sessionId);
      const remaining = current.startsWith(sent) ? current.slice(sent.length) : current;
      if (remaining) store.set(sessionId, remaining);
      else clear(sessionId);
      notifyConfirm(sessionId);
    },
    subscribe(sessionId, listener) {
      const sessionListeners = listeners.get(sessionId) ?? new Set<Listener>();
      sessionListeners.add(listener);
      listeners.set(sessionId, sessionListeners);
      return () => {
        sessionListeners.delete(listener);
        if (!sessionListeners.size) listeners.delete(sessionId);
      };
    },
    subscribeConfirm(sessionId, listener) {
      const sessionListeners = confirmListeners.get(sessionId) ?? new Set<Listener>();
      sessionListeners.add(listener);
      confirmListeners.set(sessionId, sessionListeners);
      return () => {
        sessionListeners.delete(listener);
        if (!sessionListeners.size) confirmListeners.delete(sessionId);
      };
    },
    subscribeRemote(sessionId, listener) {
      const sessionListeners = remoteListeners.get(sessionId) ?? new Set<Listener>();
      sessionListeners.add(listener);
      remoteListeners.set(sessionId, sessionListeners);
      return () => {
        sessionListeners.delete(listener);
        if (!sessionListeners.size) remoteListeners.delete(sessionId);
      };
    },
  };
  return store;
}

export const draftStore = createDraftStore();
