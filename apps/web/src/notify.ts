import { useEffect, useState } from "react";
import { getSettings, useSettings } from "./settings";
import { approvalIntent } from "./surface/routes";
import { chatHref, titleOf, type Chat } from "./surface/AgentNavAdapter";

/**
 * Browser notifications for chat rows (opt-in in settings). A row that turns "approval" says "<title> needs you"; a row
 * that goes from running to idle says "<title> finished". Only while this tab is hidden, and only in the leader tab.
 * Each tab compares a row with the state it last saw, so a list reload (a reconnect, focus, another tab's write) repeats
 * nothing; the tag (the chat) makes the browser replace, not add, a note shown twice in a leader handover.
 */
export type Note = { tag: string; title: string; href: string };
export type Notifier = { update(chats: readonly Chat[]): void };

export function createNotifier({ show, hide, shouldShow }: {
  show(note: Note): void;
  // the chat no longer waits: its "needs you" note goes, so it is not clicked later
  hide(tag: string): void;
  // read at each transition: the setting is on, this tab leads, and it is hidden
  shouldShow(): boolean;
}): Notifier {
  const last = new Map<string, Chat["last_state"]>();
  return {
    update(chats) {
      for (const chat of chats) {
        const before = last.get(chat.session_id);
        last.set(chat.session_id, chat.last_state);
        // a chat seen for the first time is no transition: a page load never notifies for what was already waiting
        if (before === undefined || before === chat.last_state) continue;
        if (before === "approval") hide(chat.session_id);
        const kind = chat.last_state === "approval" ? "needs you" : before === "running" && chat.last_state === "idle" ? "finished" : null;
        if (!kind || !shouldShow()) continue;
        show({ tag: chat.session_id, title: `${titleOf(chat)} ${kind}`, href: chatHref(chat) + (kind === "needs you" ? approvalIntent : "") });
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
    const shown = new Map<string, Notification>();
    setNotifier(createNotifier({
      hide: (tag) => { shown.get(tag)?.close(); shown.delete(tag); },
      shouldShow: () => getSettings().notify && Notification.permission === "granted" && lead.leader() && document.visibilityState === "hidden",
      show: ({ tag, title, href }) => {
        const note = new Notification(title, { tag });
        shown.set(tag, note);
        note.onclick = () => { window.focus(); note.close(); location.assign(href); };
      },
    }));
    return () => { lead.stop(); setNotifier(null); };
  }, [on]);
  useEffect(() => { notifier?.update(chats); }, [notifier, chats]);
}

const approvalIntentWaitMs = 2000;
type Intent = { chatId: string; armedAt: number };

/**
 * The approval intent (a note's click, the "needs you" link: `?chat=<id>#approval`) is a value this hook owns. It is
 * taken once from the URL, on mount or on a hash change (a click from the tab that already shows the chat), and the hash
 * leaves the URL at once, so nothing reads it again. `approval` is the shown chat's state: null while it loads, false when
 * loaded and not waiting, true when waiting. The intent ends at the first of: another chat shows (no focus), the chat is
 * loaded and not waiting (no focus), the first enabled action of its approval takes focus (tried on each frame, as
 * fulcrum's "jump to approval", since the card can render late), or `approvalIntentWaitMs` after it was taken.
 */
export function useApprovalIntent({ chatId, approval }: { chatId: string | null; approval: boolean | null }) {
  const [intent, setIntent] = useState<Intent | null>(null);
  useEffect(() => {
    const take = () => {
      if (location.hash !== approvalIntent) return;
      const chat = new URLSearchParams(location.search).get("chat");
      history.replaceState(history.state, "", location.pathname + location.search);
      setIntent(chat ? { chatId: chat, armedAt: performance.now() } : null);
    };
    take();
    addEventListener("hashchange", take);
    return () => removeEventListener("hashchange", take);
  }, []);
  useEffect(() => {
    if (!intent) return;
    if (approval === false || (approval === true && chatId !== intent.chatId)) { setIntent(null); return; }
    let frame = requestAnimationFrame(function tryFocus() {
      if (performance.now() - intent.armedAt > approvalIntentWaitMs) return setIntent(null);
      const action = approval && document.querySelector<HTMLElement>("[data-part=approval-actions] button:not([aria-disabled=true])");
      if (action) { action.focus(); setIntent(null); } else frame = requestAnimationFrame(tryFocus);
    });
    return () => cancelAnimationFrame(frame);
  }, [intent, chatId, approval]);
}
