import { createContext, useContext, useEffect, useId, useRef, useState } from "react";
import type { ZetaClient } from "@fulcrum/zeta";
import type { RunStore } from "@fulcrum/react";
import { supportsRequest } from "../zeta/connection";
import { WRITE_SURFACE } from "../writeSurfaces";
import "./branches.css";

/** One leaf of the chat's conversation tree (zeta `session_tree`): `id` is the head entry, `label` its last user message. */
export type Branch = { id: string; label: string; current: boolean };

export const BRANCH_NOTE = "new branch continues after this message · files are not changed";
const CHANNEL = "achilles:branches";

const parseTree = (value: unknown): Branch[] => {
  const rows = (value as { branches?: unknown } | null)?.branches;
  if (!Array.isArray(rows)) throw new Error("session_tree returned no branches");
  return rows.map((row) => {
    const { id, label, current } = (row ?? {}) as Record<string, unknown>;
    if (typeof id !== "string" || typeof current !== "boolean") throw new Error("session_tree returned an invalid branch");
    return { id, label: typeof label === "string" ? label : "", current };
  });
};

/** "branch N of M" for the current branch; null while the chat has one branch. Order is zeta's (head entry order). */
export const branchPosition = (branches: readonly Branch[]) => {
  const index = branches.findIndex((branch) => branch.current);
  return branches.length > 1 && index >= 0 ? `branch ${index + 1} of ${branches.length}` : null;
};


type UserEvent = { message_id?: string; delivery_id?: string };
const userEvent = (store: RunStore, id: string): UserEvent | undefined => {
  const item = store.getItem(id);
  return item?.type === "user" && item.event.type === "user_message" ? item.event : undefined;
};

/**
 * The open chat's branches: read on open, after each turn, and when another tab of this browser moves the chat to
 * another branch (then this tab reloads the transcript too). `fork` and `select` change the branch, reload this tab's
 * transcript from zeta, and tell the other tabs.
 */
export function useBranches(client: ZetaClient | null, sessionId: string | null, store: RunStore | null, turns: string, running: boolean) {
  const [branches, setBranches] = useState<Branch[]>([]);
  const [note, setNote] = useState<{ text: string; failed?: true } | null>(null);
  const [pending, setPending] = useState(false);
  const [followed, setFollowed] = useState(0);
  const supported = Boolean(client && supportsRequest(client, "fork_message") && supportsRequest(client, "switch_branch") && supportsRequest(client, "session_tree"));
  useEffect(() => { setNote(null); setBranches([]); }, [client, sessionId]);
  useEffect(() => {
    if (!supported || !client || !sessionId) return;
    let live = true;
    client.request("session_tree", { session_id: sessionId }).then((tree) => { if (live) setBranches(parseTree(tree)); }).catch(() => {});
    return () => { live = false; };
  }, [supported, client, sessionId, turns, followed]);
  // zeta sends no event to the other clients of a chat when its branch changes, so the tab that changed it tells the
  // other tabs of this browser on this channel (a post never reaches its own sender). shortcut: another browser or
  // device sees the change only after a reload; upgrade when zeta publishes a branch-change event.
  const channel = useRef<BroadcastChannel | null>(null);
  useEffect(() => {
    if (!supported || !client || !sessionId || typeof BroadcastChannel === "undefined") return;
    const listening = channel.current = new BroadcastChannel(CHANNEL);
    listening.addEventListener("message", (event: MessageEvent) => {
      if (event.data !== sessionId) return;
      setNote(null);
      void client.retrySession(sessionId).catch(() => {});
      setFollowed((value) => value + 1);
    });
    return () => { listening.close(); if (channel.current === listening) channel.current = null; };
  }, [supported, client, sessionId]);
  // a send after the fork starts the new branch's next turn: the note has done its job
  useEffect(() => { if (running) setNote((shown) => shown?.failed ? shown : null); }, [running]);

  const change = async (method: "fork_message" | "switch_branch", params: Record<string, string>) => {
    const tree = parseTree(await client!.request(method, { session_id: sessionId, ...params }));
    await client!.retrySession(sessionId!);
    channel.current?.postMessage(sessionId);
    setBranches(tree);
  };
  const run = async (work: () => Promise<string | null>, failed: string) => {
    if (pending) return false;
    setPending(true);
    try {
      const text = await work();
      setNote(text ? { text } : null);
      return true;
    } catch (caught) {
      setNote({ text: `${failed}: ${(caught as { message?: unknown })?.message ?? "zeta refused it"}`, failed: true });
      return false;
    } finally { setPending(false); }
  };
  const fork = (rowId: string) => run(async () => {
    let event = store && userEvent(store, rowId);
    // a message sent from this tab has no entry id until the transcript is read from zeta again
    if (event && !event.message_id && event.delivery_id && store) {
      const delivery = event.delivery_id;
      await client!.retrySession(sessionId!);
      event = store.getOutline().map(({ id }) => userEvent(store, id)).find((row) => row?.delivery_id === delivery);
    }
    if (!event?.message_id) throw new Error("this message is not saved yet");
    await change("fork_message", { message_id: event.message_id });
    return BRANCH_NOTE;
  }, "could not branch");
  const select = (headId: string) => run(async () => { await change("switch_branch", { head_id: headId }); return null; }, "could not switch branch");
  return { supported, branches, note, pending, fork, select };
}

type BranchAction = { fork: (rowId: string) => Promise<boolean>; disabledReason: string | null };
export const BranchActionContext = createContext<BranchAction | null>(null);

/** "branch from here" under a user message: shown on hover and on keyboard focus (touch shows it always). */
export function BranchFromHere({ rowId, onForked }: { rowId: string; onForked: () => void }) {
  const action = useContext(BranchActionContext);
  if (!action) return null;
  const off = action.disabledReason;
  return <button type="button" className="branch-from" data-write-surface={WRITE_SURFACE.chatBranchFrom}
    aria-disabled={off ? true : undefined} title={off ?? "start a new branch after this message. files are not changed."}
    onClick={async () => { if (!off && await action.fork(rowId)) onForked(); }}>branch from here</button>;
}

/** The header chip "branch N of M": opens the branch list; a branch switches the transcript to it. */
export function BranchSwitcher({ branches, disabledReason, pending, onSelect }: { branches: readonly Branch[]; disabledReason: string | null; pending: boolean; onSelect: (id: string) => Promise<boolean> }) {
  const [open, setOpen] = useState(false);
  const chip = useRef<HTMLButtonElement>(null);
  const list = useId();
  const position = branchPosition(branches);
  if (!position) return null;
  const close = () => { setOpen(false); chip.current?.focus(); };
  return <div className="branch-switcher" onKeyDown={(event) => { if (event.key === "Escape" && open) { event.stopPropagation(); close(); } }}
    onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false); }}>
    <button ref={chip} type="button" className="branch-chip" aria-expanded={open} aria-controls={list} onClick={() => setOpen(!open)}>{position}</button>
    {open && <div id={list} className="branch-list" role="group" aria-label="branches">
      {branches.map((branch, index) => <button key={branch.id} type="button" data-write-surface={WRITE_SURFACE.chatBranchSwitch}
        aria-current={branch.current ? "true" : undefined} aria-disabled={branch.current || disabledReason || pending ? true : undefined}
        onClick={async () => { if (branch.current || disabledReason || pending) return; if (await onSelect(branch.id)) close(); }}>
        <span className="branch-number">branch {index + 1}</span><span className="branch-label">{branch.label || "no message yet"}</span>
      </button>)}
      <p className="branch-hint">{disabledReason ?? "switching changes the conversation only. files are not changed."}</p>
    </div>}
  </div>;
}
