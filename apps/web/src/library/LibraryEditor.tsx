import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type { ZetaClient } from "@fulcrum/zeta";
import { libraryMethods, projectBody, sourceTiers, type Body, type CatalogRow, type LibraryKind } from "./catalog";
import { createProblems, nameProblem, savedNotice, type createLibraryWriter, type WriteOutcome, type WriteScope, type WriteTarget } from "./libraryWrites";

type Writer = ReturnType<typeof createLibraryWriter>;
// The writer threw before sending (for example `crypto.subtle` is missing outside a secure context).
const notSent: WriteOutcome = { status: "unknown", message: "this page could not send the save. nothing was sent." };
type Failure = Exclude<WriteOutcome, { status: "saved" }>;
/** What the user typed in the create form. Kept in memory only, never in storage or the URL: a draft can hold a secret. */
export type CreateDraft = { name: string; description: string; scope: WriteScope; edited: string | null };
/** Shared by both editors: who may save and how to get control. */
type Control = {
  /** Whether this tab controls zeta now. When it does not, save first takes control (only if the slot is free). */
  controller: boolean;
  takeControl: () => Promise<string | null>;
  /** The last take-control refusal (held above the editor, so it survives a socket replace). */
  feedback: string | null;
  /** Why this tab cannot save here; the draft stays visible, read-only, and nothing is sent. */
  blocked: string | null;
};
type Props = Control & {
  client: ZetaClient; kind: LibraryKind; writer: Writer; rows: CatalogRow[];
  /** Starts the form from this draft; every change is reported back, so the owner can restore it after a remount. */
  draft: CreateDraft | undefined;
  onDraft: (draft: CreateDraft) => void;
  /** The catalog method used to probe project scope; null when this zeta has no live catalog. */
  catalogMethod: string | null;
  /** `where`: the saved file, for the notice ("<project> · .zeta/skills/<name>.md"). */
  onCreated: (name: string, redacted: boolean, where: string) => void;
  onOpen: (name: string) => void;
  onClose: () => void;
};

const header = (kind: LibraryKind, name: string, description: string) =>
  `---\nname: ${JSON.stringify(name)}\ndescription: ${JSON.stringify(description)}\n${kind === "skills" ? "keywords: []\n" : ""}---\n` +
  (kind === "skills" ? "describe when and how to use this skill.\n" : "describe how this agent works.\n");
const problemLabel = (count: number) => `save · fix ${count} ${count === 1 ? "problem" : "problems"} first`;
const folder = (kind: LibraryKind) => kind === "skills" ? "skills" : "agents";

/** The browser asks before a reload, a close or a full page load (the library tabs) drops a changed draft. */
function useLeaveGuard(active: boolean) {
  useEffect(() => {
    if (!active) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    addEventListener("beforeunload", warn);
    return () => removeEventListener("beforeunload", warn);
  }, [active]);
}

/** Discard with a level-1 confirm when the draft changed; focus lands on "keep editing". `save` is the save button. */
function EditorActions({ dirty, what, onDiscard, save }: { dirty: boolean; what: string; onDiscard: () => void; save: ReactNode }) {
  const [confirm, setConfirm] = useState(false);
  const keep = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (confirm) keep.current?.focus(); }, [confirm]);
  if (confirm) return <div role="group" aria-label="discard changes?" className="library-editor-actions">
    <span>discard your changes to {what}?</span>
    <button type="button" ref={keep} onClick={() => setConfirm(false)}>keep editing</button>
    <button type="button" onClick={onDiscard}>discard changes</button>
  </div>;
  return <div className="library-editor-actions">
    <button type="button" onClick={() => dirty ? setConfirm(true) : onDiscard()}>{dirty ? "discard" : "close"}</button>
    {save}
  </div>;
}

/** A tab that lost control (another tab took it while this one reconnected) says so before save. */
const Demoted = ({ show }: { show: boolean }) => show
  ? <p role="status" className="library-flag">this tab is read-only now. save takes control first, if no other tab has it.</p> : null;

/** Take control for a save on an observer tab; on refusal the failure shows the reason. Returns whether to send. */
async function controlForSave({ controller, takeControl }: Control, fail: (failure: Failure) => void) {
  if (controller) return true;
  const reason = await takeControl();
  if (reason) fail({ status: "observer", message: reason });
  return !reason;
}

/** The create form. The draft is mirrored to `onDraft`, so a socket drop that unmounts the form does not lose it. */
export function LibraryEditor({ client, kind, writer, rows, draft, onDraft, catalogMethod, onCreated, onOpen, onClose, ...control }: Props) {
  const { takeControl, feedback, blocked, controller } = control;
  const noun = kind === "skills" ? "skill" : "profile";
  const id = useId();
  const [name, setName] = useState(draft?.name ?? "");
  const [description, setDescription] = useState(draft?.description ?? "");
  const [scope, setScope] = useState<WriteScope>(draft?.scope ?? "home");
  const [edited, setEdited] = useState<string | null>(draft?.edited ?? null);
  const [project, setProject] = useState<{ state: "checking" | "unavailable"; why: string } | { state: "available"; label: string }>(
    catalogMethod ? { state: "checking", why: "checking project items…" } : { state: "unavailable", why: "needs a newer zeta" });
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [tried, setTried] = useState(false);
  const abort = useRef<AbortController | null>(null);
  const alert = useRef<HTMLDivElement>(null);
  const nameField = useRef<HTMLInputElement>(null);
  const text = edited ?? header(kind, name, description);
  const existing = rows.find((row) => row.name === name);
  const problems = createProblems(name, text);
  if (edited === null && !description.trim()) problems.push("enter a description");
  if (existing?.source === scope) problems.push(`a ${scope} ${noun} named ${name} already exists. open it to edit it.`);
  const dirty = Boolean(name || description || edited !== null);

  useEffect(() => {
    nameField.current?.focus();
    return () => abort.current?.abort();
  }, []);
  useEffect(() => { onDraft({ name, description, scope, edited }); }, [name, description, scope, edited]);
  useLeaveGuard(dirty || pending);
  // Project scope needs an open chat in a project: a one-row read says whether zeta has one, and the session's
  // working directory names it.
  useEffect(() => {
    if (!catalogMethod) return;
    let live = true;
    client.request(catalogMethod, { scope: "project", limit: 1 }).then(
      async () => {
        const status = await client.request("status", {}).catch(() => null) as { session?: { cwd?: unknown } | null } | null;
        const cwd = typeof status?.session?.cwd === "string" ? status.session.cwd : null;
        if (live) setProject({ state: "available", label: cwd?.split(/[\\/]/).filter(Boolean).at(-1) ?? "the open chat's project" });
      },
      (error) => { if (live) setProject({ state: "unavailable", why: (error as { code?: unknown })?.code === -32005 ? "needs an open chat in a project" : "could not check project items" }); });
    return () => { live = false; };
  }, [client, catalogMethod]);
  useEffect(() => { if (failure || (tried && problems.length)) alert.current?.focus(); }, [failure, tried]);

  const shadow = existing && existing.source !== scope && (sourceTiers.indexOf(existing.source) < sourceTiers.indexOf(scope)
    ? `a ${existing.source} ${noun} named ${name} wins over this one.` : `this will win over the ${existing.source} ${name}.`);
  const file = `.zeta/${folder(kind)}/${name}.md`;
  const where = scope === "project" && project.state === "available" ? `${project.label} · ${file}` : `home · ${folder(kind)}/${name}.md`;

  async function save() {
    if (pending || blocked) return;
    setTried(true);
    if (problems.length) return alert.current?.focus();
    setPending(true);
    setFailure(null);
    abort.current = new AbortController();
    const outcome = await controlForSave(control, setFailure)
      ? await writer.create(client, { kind, name, scope }, text, abort.current.signal).catch(() => notSent) : null;
    // a sent write cannot be recalled: a save that landed after discard is still reported (the owner decides how).
    if (outcome?.status === "saved") return onCreated(name, outcome.redacted, where);
    if (abort.current.signal.aborted) return;
    setPending(false);
    if (outcome) setFailure(outcome);
  }
  const onEnter = (event: KeyboardEvent<HTMLInputElement>) => { if (event.key === "Enter") { event.preventDefault(); void save(); } };

  return <section className="library-editor" aria-label={`new ${noun}`} onKeyDown={(event) => {
    if (event.key === "Escape") event.preventDefault();
    if (event.key === "s" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void save(); }
  }}>
    <h2>new {noun}</h2>
    <div className="library-editor-row">
      <label htmlFor={`${id}-name`}>name</label>
      <input id={`${id}-name`} ref={nameField} readOnly={Boolean(blocked)} value={name} autoComplete="off" spellCheck={false} aria-describedby={`${id}-rules`} aria-invalid={Boolean(name && nameProblem(name))}
        onChange={(event) => setName(event.target.value)} onKeyDown={onEnter} />
      <small id={`${id}-rules`} data-invalid={Boolean(name && nameProblem(name)) || undefined}>one word: no spaces, no / or \, not . or ..</small>
    </div>
    <fieldset className="library-editor-row">
      <legend>scope</legend>
      <label><input type="radio" name={`${id}-scope`} checked={scope === "home"} disabled={Boolean(blocked) && scope !== "home"} onChange={() => setScope("home")} /> home · every project</label>
      <label><input type="radio" name={`${id}-scope`} checked={scope === "project"} disabled={project.state !== "available" || (Boolean(blocked) && scope !== "project")} aria-describedby={`${id}-project`}
        onChange={() => setScope("project")} /> project · {project.state === "available" ? project.label : "this project only"}</label>
      <small id={`${id}-project`}>{project.state === "available" ? `saves to ${file} in ${project.label}` : project.why}</small>
    </fieldset>
    <div className="library-editor-row">
      <label htmlFor={`${id}-description`}>description</label>
      {edited === null
        ? <input id={`${id}-description`} readOnly={Boolean(blocked)} value={description} autoComplete="off" onChange={(event) => setDescription(event.target.value)} onKeyDown={onEnter} />
        : <small id={`${id}-description`}>the description is in the file text now. edit it there.</small>}
    </div>
    <div className="library-editor-row">
      <label htmlFor={`${id}-text`}>{name || "<name>"}.md · file text</label>
      <textarea id={`${id}-text`} readOnly={Boolean(blocked)} value={text} spellCheck={false} rows={12} onChange={(event) => setEdited(event.target.value)} />
      <small>the name and description fill the header until you edit the file text. sessions pick up the change at their next catalog refresh.</small>
    </div>
    {shadow && <p className="library-flag">{shadow}</p>}
    {existing?.source === scope && <p className="library-flag">{`a ${scope} ${noun} named ${name} already exists.`} <button type="button" onClick={() => onOpen(name)}>open it</button></p>}
    <Demoted show={!controller && !blocked} />
    <div ref={alert} tabIndex={-1} className="library-editor-status">
      {blocked && <p role="alert" className="library-error">{blocked}. your text is kept; nothing was sent.</p>}
      {tried && problems.length > 0 && <ul role="alert" className="library-error">{problems.map((problem) => <li key={problem}>{problem}</li>)}</ul>}
      {failure && <div role="alert">
        <p className="library-error">{failure.message}</p>
        {failure.status === "stale" && <button type="button" onClick={() => onOpen(name)}>open it</button>}
        {failure.status === "observer" && <>
          <button type="button" onClick={() => void takeControl().then((reason) => { if (!reason) { setFailure(null); nameField.current?.focus(); } })}>take control</button>
          {feedback && <span role="status">{feedback}</span>}
        </>}
      </div>}
    </div>
    <EditorActions dirty={dirty} what={`the new ${noun}`} onDiscard={() => { abort.current?.abort(); onClose(); }}
      save={!blocked && <button type="button" className="library-primary" aria-disabled={pending || problems.length > 0} onClick={() => void save()}>
        {pending ? "saving…" : problems.length ? problemLabel(problems.length) : `save ${noun}`}
      </button>} />
  </section>;
}

/** Why zeta's read gives no editable copy; null when it does. Shared by the detail view and "load the latest version". */
export function uneditable(body: Body) {
  if (body.redacted) return "this file has text that looks like a secret, shown masked. edit it in your own editor; saving here would replace the secret with the mask.";
  if (body.truncated) return "this file is over 128 KiB. edit it in your own editor.";
  if (!body.editable) return "zeta did not send an editable copy: the file has text that looks like a secret, or it is over 128 KiB. edit it in your own editor.";
  return null;
}

/** An open edit, kept in memory only (it can hold a secret). `base`: the read the user opened or last saved; its
 * revision is the only one a save may send. `mine`: the user's text kept beside the latest version after a conflict. */
export type EditDraft = { target: WriteTarget; base: { revision: string; document: string }; text: string; mine: string | null };
type EditProps = Control & {
  client: ZetaClient; writer: Writer;
  /** Starts the editor from this draft; every change is reported back, so a socket drop that unmounts it loses nothing.
   * `onSaved` runs after each save; the editor shows the saved notice itself while the text is unchanged. */
  draft: EditDraft; onDraft: (draft: EditDraft) => void;
  onSaved: (redacted: boolean) => void; onClose: () => void;
};

/** Edits one existing file. Like the create form, its text lives only in memory and survives a client swap. */
export function LibraryEdit({ client, writer, draft, onDraft, onSaved, onClose, ...control }: EditProps) {
  const { takeControl, feedback, blocked, controller } = control;
  const { target } = draft;
  const noun = target.kind === "skills" ? "skill" : "profile";
  const id = useId();
  const [base, setBase] = useState(draft.base);
  const [text, setText] = useState(draft.text);
  // after "load the latest version": the user's text, kept read-only beside zeta's for a manual merge.
  const [mine, setMine] = useState(draft.mine);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [tried, setTried] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saved, setSaved] = useState(false);
  const field = useRef<HTMLTextAreaElement>(null);
  const alert = useRef<HTMLDivElement>(null);
  const dirty = text !== base.document;
  const problems = createProblems(target.name, text);

  useEffect(() => { field.current?.focus(); }, []);
  useEffect(() => { onDraft({ target, base, text, mine }); }, [base, text, mine]);
  useEffect(() => { if (failure || (tried && problems.length)) alert.current?.focus(); }, [failure, tried]);
  useLeaveGuard(dirty || pending);

  async function save() {
    // a stale save waits for "load the latest version": never a second write with a revision the user did not see.
    if (pending || blocked || !dirty || failure?.status === "stale") return;
    setTried(true);
    if (problems.length) return alert.current?.focus();
    setPending(true);
    setFailure(null);
    const sent = text;
    const outcome = await controlForSave(control, setFailure)
      ? await writer.save(client, target, base.revision, sent).catch(() => notSent) : null;
    setPending(false);
    if (!outcome) return;
    if (outcome.status !== "saved") return setFailure(outcome);
    // zeta wrote exactly these bytes (the writer checked the sha256), so they are the new baseline.
    setBase({ revision: outcome.revision, document: sent });
    setTried(false);
    setSaved(true);
    onSaved(outcome.redacted);
  }

  async function loadLatest() {
    if (loading) return;
    setLoading(true);
    let body: Body | null = null;
    let problem: string | null = null;
    try {
      body = projectBody(await client.request(libraryMethods(target.kind).read, { name: target.name, scope: target.scope }), target.name);
      problem = body ? uneditable(body) : "zeta sent data this view cannot read.";
    } catch (error) {
      const rpc = error as { code?: unknown; data?: { reason?: unknown } } | null;
      problem = rpc?.code === -32602 && rpc.data?.reason === "resource_not_found" ? "this file no longer exists." : "zeta could not read the latest version. try again.";
    }
    setLoading(false);
    setMine(text);
    if (problem || !body?.editable) return setFailure({ status: "stale", message: `${problem} your text is kept below.` });
    setBase(body.editable);
    setText(body.editable.document);
    setFailure(null);
    field.current?.focus();
  }

  const stale = failure?.status === "stale";
  return <section className="library-editor" aria-label={`edit ${noun} ${target.name}`} onKeyDown={(event) => {
    if (event.key === "Escape") event.preventDefault();
    if (event.key === "s" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void save(); }
  }}>
    <h2>edit {target.name} <small>{target.scope}</small></h2>
    <div className="library-editor-row">
      <label htmlFor={`${id}-text`}>{target.name} · file text{dirty ? " · edited" : ""}</label>
      <textarea id={`${id}-text`} ref={field} readOnly={Boolean(blocked) || pending} value={text} spellCheck={false} rows={16} onChange={(event) => setText(event.target.value)} />
      <small>the whole file: the header between --- lines, then the text. sessions pick up the change at their next catalog refresh.</small>
    </div>
    {mine !== null && <div className="library-editor-row">
      <label htmlFor={`${id}-mine`}>your unsaved text · copy what you need</label>
      <textarea id={`${id}-mine`} className="library-mine" readOnly value={mine} spellCheck={false} rows={8} />
      <button type="button" className="library-dismiss" onClick={() => setMine(null)}>dismiss your text</button>
    </div>}
    <p role="status" className="library-editor-saved">{saved && !dirty ? savedNotice(target.name) : ""}</p>
    <Demoted show={!controller && !blocked} />
    <div ref={alert} tabIndex={-1} className="library-editor-status">
      {blocked && <p role="alert" className="library-error">{blocked}. your text is kept; nothing was sent.</p>}
      {tried && problems.length > 0 && <ul role="alert" className="library-error">{problems.map((problem) => <li key={problem}>{problem}</li>)}</ul>}
      {failure && <div role="alert" className={stale ? "library-conflict" : undefined}>
        <p className="library-error">{failure.message}</p>
        {stale && <button type="button" aria-disabled={loading} onClick={() => void loadLatest()}>{loading ? "loading…" : "load the latest version"}</button>}
        {failure.status === "observer" && <>
          <button type="button" onClick={() => void takeControl().then((reason) => { if (!reason) { setFailure(null); field.current?.focus(); } })}>take control</button>
          {feedback && <span role="status">{feedback}</span>}
        </>}
        {failure.status === "busy" && <button type="button" onClick={() => void save()}>try again</button>}
      </div>}
    </div>
    <EditorActions dirty={dirty} what={target.name} onDiscard={onClose}
      save={!blocked && <button type="button" className="library-primary" aria-disabled={pending || stale || !dirty || problems.length > 0} onClick={() => void save()}>
        {pending ? "saving…" : stale ? "load the latest version first" : problems.length ? problemLabel(problems.length) : `save ${noun}`}
      </button>} />
  </section>;
}
