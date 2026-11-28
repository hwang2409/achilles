import { useEffect, useState } from "react";
import { getSettings, useSettings } from "./settings";
import { approvalIntent } from "./surface/routes";
import { chatHref, titleOf, type Chat } from "./surface/AgentNavAdapter";

/**
 * Browser notifications for chat rows (opt-in in settings). A row that turns "approval" says "<title> needs you"; a row
 * that goes from running to idle says "<title> finished". Only while this tab is hidden, and only in the leader tab.
 * The row's state_version names each transition, so a reconnect, a list reload, or a new leader never repeats one.
 */
export type Note = { key: string; tag: string; title: string; href: string };
export type Notifier = { update(chats: readonly Chat[]): void };

export const NOTIFIED_KEY = "achilles:notified";
const KEEP = 200;

export function createNotifier({ show, shouldShow, storage }: {
  show(note: Note): void;
  // read at each transition: the setting is on, this tab leads, and it is hidden
  shouldShow(): boolean;
  // shared by the tabs of this browser (localStorage): the transitions already shown
  storage: Pick<Storage, "getItem" | "setItem">;
}): Notifier {
  const last = new Map<string, Chat["last_state"]>();
  const shown = () => { try { const value: unknown = JSON.parse(storage.getItem(NOTIFIED_KEY) ?? "[]"); return Array.isArray(value) ? value.filter((key): key is string => typeof key === "string") : []; } catch { return []; } };
  return {
    update(chats) {
      for (const chat of chats) {
        const before = last.get(chat.session_id);
        last.set(chat.session_id, chat.last_state);
        // a chat seen for the first time is no transition: a page load never notifies for what was already waiting
        if (before === undefined || before === chat.last_state) continue;
        const kind = chat.last_state === "approval" ? "needs you" : before === "running" && chat.last_state === "idle" ? "finished" : null;
        if (!kind || !shouldShow()) continue;
        const key = `${chat.session_id}:${chat.state_version}`;
        const keys = shown();
        if (keys.includes(key)) continue;
        try { storage.setItem(NOTIFIED_KEY, JSON.stringify([...keys, key].slice(-KEEP))); } catch { /* storage off: this tab still shows it once */ }
        show({ key, tag: chat.session_id, title: `${titleOf(chat)} ${kind}`, href: chatHref(chat) + (kind === "needs you" ? approvalIntent : "") });
      }
    },
  };
}

/**
 * One leader among this browser's tabs: a Web Lock that every tab waits for. A tab the user shows takes it (steal), so
 * the leader is the tab seen last, and a visible achilles tab means no notification. A closed leader hands it on.
 */
export function leadTabs(locks: LockManager, doc: Document): { leader(): boolean; stop(): void } {
  let leader = false;
  let stopped = false;
  let queued: AbortController | null = null;
  let release = () => {};
  const request = (steal: boolean) => {
    queued?.abort();
    const own = queued = new AbortController();
    const hold = () => { if (own !== queued) return; leader = true; return new Promise<void>((resolve) => { release = resolve; }); };
    void (steal ? locks.request("achilles:notify", { steal: true }, hold) : locks.request("achilles:notify", { signal: own.signal }, hold))
      .catch(() => {})
      // the lock was stolen or released: wait in line again
      .finally(() => { if (own === queued) { leader = false; if (!stopped) request(false); } });
  };
  const shown = () => { if (doc.visibilityState === "visible" && !leader) request(true); };
  request(doc.visibilityState === "visible");
  doc.addEventListener("visibilitychange", shown);
  return {
    leader: () => leader,
    stop: () => { stopped = true; doc.removeEventListener("visibilitychange", shown); queued?.abort(); queued = null; leader = false; release(); },
  };
}

export const notificationsSupported = () => typeof Notification !== "undefined" && typeof navigator !== "undefined" && Boolean(navigator.locks);

/** Turning notifications on asks the browser once; true when it may show them. */
export async function allowNotifications(): Promise<boolean> {
  if (!notificationsSupported()) return false;
  if (Notification.permission === "default") await Notification.requestPermission();
  return Notification.permission === "granted";
}

/** Notifies for the chat rows this tab lists, while the setting is on. */
export function useChatNotifications(chats: readonly Chat[]) {
  const on = useSettings().notify && notificationsSupported();
  const [notifier, setNotifier] = useState<Notifier | null>(null);
  useEffect(() => {
    if (!on) return;
    const lead = leadTabs(navigator.locks, document);
    setNotifier(createNotifier({
      shouldShow: () => getSettings().notify && Notification.permission === "granted" && lead.leader() && document.visibilityState === "hidden",
      storage: localStorage,
      show: ({ tag, title, href }) => {
        const note = new Notification(title, { tag });
        note.onclick = () => { window.focus(); note.close(); location.assign(href); };
      },
    }));
    return () => { lead.stop(); setNotifier(null); };
  }, [on]);
  useEffect(() => { notifier?.update(chats); }, [notifier, chats]);
}
