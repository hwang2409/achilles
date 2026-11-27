import { useEffect, useRef, useState } from "react";
import type { ZetaClient } from "@fulcrum/zeta";
import { Confirmation, reviewText as t } from "../surface/Confirmation";
import { WRITE_SURFACE } from "../writeSurfaces";
import { supportsFeature } from "../zeta/connection";
import { controlFeature, displayControl as display, isTerminal, newerControls, stateWord, readControlParent, runDisplayId, type ChildControls, type ControlParent } from "./childControls";
import type { AgentRun } from "./reads";

// readOnly: why this tab cannot write (an observer tab); the controls stay visible but disabled.
type Props = { client: ZetaClient | null; owner: ChildControls; refresh: () => void; readOnly?: string };
const reason = (client: ZetaClient | null) => !client ? "connect to zeta to make changes." : !supportsFeature(client, controlFeature) ? newerControls : undefined;

// sessionId: the chat on screen; spawn refuses a parent that is not that chat.
// title: the chat's title, shown as the review's scope.
export function AgentSpawn({ client, owner, refresh, sessionId, title, readOnly }: Props & { sessionId: string; title: string }) {
  const [open, setOpen] = useState(false);
  const [parent, setParent] = useState<ControlParent | null>();
  const [name, setName] = useState("");
  const [task, setTask] = useState("");
  const [review, setReview] = useState<{ id: number; parent: ControlParent; profile: ControlParent["profiles"][number]; task: string }>();
  const [note, setNote] = useState("");
  const [activity, setActivity] = useState<HTMLDivElement | null>(null);
  const opener = useRef<HTMLButtonElement>(null);
  const unavailable = readOnly ?? reason(client);
  useEffect(() => {
    if (!open || !client || unavailable) return;
    const stop = new AbortController();
    void readControlParent(client, stop.signal).then((result) => {
      if (stop.signal.aborted) return;
      const other = !!result && result.id !== sessionId;
      setParent(other ? null : result);
      setNote(other ? "this chat is not attached in this tab. reload the chat, then try again." : result ? !result.profiles.length ? "no agent profiles are mounted in the active session." : "" : "open a parent session in zeta first.");
    }, () => { if (!stop.signal.aborted) setNote("could not read the active session. reopen the form to retry."); });
    return () => stop.abort();
  }, [open, client, unavailable, sessionId]);
  const profile = parent?.profiles.find((entry) => entry.name === name);
  return <section className="agents-spawn" aria-label="spawn an agent">
    <button type="button" className="ui-button" disabled={!!unavailable} aria-expanded={open} onClick={() => {
      if (!open) { setParent(undefined); setNote(""); }
      setOpen(!open);
    }}>{open ? "close spawn form" : "+ spawn agent"}</button>
    {unavailable && <small>{unavailable}</small>}
    {open && <form className="agents-spawn-form" onSubmit={(event) => {
      event.preventDefault();
      if (!unavailable && parent && profile && task.trim()) setReview({ id: (review?.id ?? 0) + 1, parent, profile, task });
    }}>
      {!parent && !note && !unavailable && <p role="status">reading the active session…</p>}
      {note && <p role="status">{note}</p>}
      <label>profile <select required autoFocus value={name} onChange={(event) => setName(event.currentTarget.value)}>
        <option value="">choose a profile</option>
        {parent?.profiles.map(({ name }) => <option key={name} value={name}>{display(name)}</option>)}
      </select></label>
      {profile?.description && <small>{display(profile.description)}</small>}
      <label>task <textarea required value={task} onChange={(event) => setTask(event.currentTarget.value)} /></label>
      {/* aria-disabled, not disabled: a spawn clears the task, and focus must stay on this button inside the dialog */}
      <button ref={opener} type="submit" aria-disabled={!!unavailable || !profile || !task.trim() || undefined} data-write-surface={WRITE_SURFACE.agentsSpawn}>review spawn</button>
    </form>}
    <div ref={setActivity} />
    {review && <Confirmation key={review.id} level={2} title={t("spawn an agent")} action={t("spawn agent")} keep={t("keep draft")}
      effect={display(`spawn ${review.profile.name}`)} scope={display(title || "this chat")} current={t("no child created by this request")}
      after={t("runs in the background; the parent receives its completion.")} undo={t("no. you can request cancellation after it starts.")}
      fields={[
        { label: t("profile"), value: display(review.profile.name) },
        { label: t("inherited cwd"), value: display(review.parent.cwd, 4096) },
        { label: t("task"), value: display(review.task, 65_536) },
        { label: t("allowed tools"), value: review.profile.tools === null ? t("uses the profile's default tool policy")
          : display(review.profile.tools.join(", ") || "none", 4096) },
      ]} proof={{ kind: "scope" }} external={{ opener: () => opener.current }} activity={activity ?? undefined}
      {...clearOnCommit(owner.operation({ kind: "spawn", ...review }, refresh), () => setTask(""))} />}
  </section>;
}

// a committed spawn clears the task, so a second confirm cannot repeat it by accident
type Operation = ReturnType<ChildControls["operation"]>;
function clearOnCommit(operation: Operation, clear: () => void): Operation {
  const after = (result: Awaited<ReturnType<Operation["execute"]>>) => { if (result.status === "committed") clear(); return result; };
  return { ...operation, execute: () => operation.execute().then(after), checkResult: () => operation.checkResult().then(after) };
}

export function AgentCancel({ client, owner, refresh, row, title, parent, elapsed, readOnly }: Props & {
  row?: AgentRun; title?: string; parent?: AgentRun; elapsed: string;
}) {
  const [review, setReview] = useState<{ id: number; row: AgentRun; title?: string; parent?: AgentRun; elapsed: string }>();
  const [activity, setActivity] = useState<HTMLDivElement | null>(null);
  const opener = useRef<HTMLButtonElement>(null);
  const [focused, setFocused] = useState(false);
  const finished = !!row && isTerminal(row.status);
  const unavailable = readOnly ?? reason(client) ?? (finished ? "this run has finished." : undefined);
  return <>
    {row && <div className="agents-cancel">
      {/* a finished run has no cancel; aria-disabled and kept while focused: a cancelled run turns terminal while this
          button has focus, and focus must stay in the dialog */}
      {(!finished || focused) && <button ref={opener} type="button" aria-disabled={!!unavailable || undefined} data-write-surface={WRITE_SURFACE.agentsCancel}
        onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}
        onClick={() => { if (!unavailable) setReview({ id: (review?.id ?? 0) + 1, row, title, parent, elapsed }); }}>cancel run</button>}
      {unavailable && <small>{unavailable}</small>}
    </div>}
    <div ref={setActivity} className="agents-cancel-activity" />
    {review && <CancelReview key={review.id} {...review} owner={owner} refresh={refresh} activity={activity ?? undefined} opener={() => opener.current} />}
  </>;
}

function CancelReview({ row, title, parent, elapsed, owner, refresh, activity, opener }: {
  row: AgentRun; title?: string; parent?: AgentRun; elapsed: string; owner: ChildControls; refresh: () => void;
  activity?: HTMLElement; opener: () => HTMLElement | null;
}) {
  return <Confirmation level={2} title={t("cancel this run?")} action={t("cancel run")} keep={t("keep run")}
    effect={display(`${row.agentType || "agent"} · ${row.description || "no task summary"}`)}
    scope={display(`${title || "this chat"}${row.parentRunId ? ` · parent ${runDisplayId(parent?.agentType, row.parentRunId)}` : ""}`, 750)}
    current={display([stateWord(row.status), row.turnsUsed === undefined ? "" : `${row.turnsUsed} turns`, elapsed].filter(Boolean).join(" · "))}
    after={t("the run stops at its next safe point.")}
    undo={t("no. work in progress can be lost; the transcript stays; a new run starts from zero.")}
    proof={{ kind: "name", name: runDisplayId(row.agentType, row.runId) }} external={{ opener }} activity={activity}
    {...owner.operation({ kind: "cancel", row }, refresh)} />;
}
