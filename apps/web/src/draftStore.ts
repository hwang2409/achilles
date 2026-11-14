type Listener = () => void;

const drafts = new Map<string, string>();
const listeners = new Map<string, Set<Listener>>();

const notify = (sessionId: string) => {
  for (const listener of listeners.get(sessionId) ?? []) listener();
};

export const draftStore = {
  get(sessionId: string) {
    return drafts.get(sessionId) ?? "";
  },
  set(sessionId: string, text: string) {
    if (drafts.get(sessionId) === text || (!drafts.has(sessionId) && text === "")) return;
    if (text) drafts.set(sessionId, text);
    else drafts.delete(sessionId);
    notify(sessionId);
  },
  clear(sessionId: string) {
    if (!drafts.delete(sessionId)) return;
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
