import { useEffect, useId, useRef, useState } from "react";
import type { ZetaClient } from "@fulcrum/zeta";
import { libraryMethods, projectBody, sourceTiers, type Body, type CatalogRow, type LibraryKind } from "./catalog";
import { createProblems, nameProblem, SAVED_NOTICE, type createLibraryWriter, type WriteOutcome, type WriteScope, type WriteTarget } from "./libraryWrites";

type Writer = ReturnType<typeof createLibraryWriter>;
type Failure = Exclude<WriteOutcome, { status: "saved" }>;
/** What the user typed in the create form. Kept in memory only, never in storage or the URL: a draft can hold a secret. */
export type CreateDraft = { name: string; description: string; scope: WriteScope; edited: string | null };
type Props = {
  client: ZetaClient; kind: LibraryKind; writer: Writer; rows: CatalogRow[];
  /** Starts the form from this draft; every change is reported back, so the owner can restore it after a remount. */
  draft: CreateDraft | undefined;
  onDraft: (draft: CreateDraft) => void;
  /** The catalog method used to probe project scope; null when this zeta has no live catalog. */
  catalogMethod: string | null;
  takeControl: () => Promise<string | null>;
  /** The last take-control refusal (held above this component, so it survives a socket replace). */
  feedback: string | null;
  /** Why this tab cannot save here; the draft stays visible, read-only, and nothing is sent. */
  blocked: string | null;
  onCreated: (name: string, redacted: boolean) => void;
  onOpen: (name: string) => void;
  onClose: () => void;
};

const header = (kind: LibraryKind, name: string, description: string) =>
  `---\nname: ${JSON.stringify(name)}\ndescription: ${JSON.stringify(description)}\n${kind === "skills" ? "keywords: []\n" : ""}---\n` +
  (kind === "skills" ? "describe when and how to use this skill.\n" : "describe how this agent works.\n");

/** The create form. The draft is mirrored to `onDraft`, so a socket drop that unmounts the form does not lose it. */
export function LibraryEditor({ client, kind, writer, rows, draft, onDraft, catalogMethod, takeControl, feedback, blocked, onCreated, onOpen, onClose }: Props) {
  const noun = kind === "skills" ? "skill" : "profile";
  const id = useId();
  const [name, setName] = useState(draft?.name ?? "");
  const [description, setDescription] = useState(draft?.description ?? "");
  const [scope, setScope] = useState<WriteScope>(draft?.scope ?? "home");
  const [edited, setEdited] = useState<string | null>(draft?.edited ?? null);
  const [project, setProject] = useState<"checking" | "available" | string>(catalogMethod ? "checking" : "needs a newer zeta");
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [tried, setTried] = useState(false);
  const abort = useRef<AbortController | null>(null);
  const alert = useRef<HTMLDivElement>(null);
  const nameField = useRef<HTMLInputElement>(null);
  const text = edited ?? header(kind, name, description);
  const problems = createProblems(name, text);
  if (edited === null && !description.trim()) problems.push("enter a description");

  useEffect(() => {
    nameField.current?.focus();
    return () => abort.current?.abort();
  }, []);
  useEffect(() => { onDraft({ name, description, scope, edited }); }, [name, description, scope, edited]);
  // Project scope needs an open chat in a project; ask zeta once with a one-row read.
  useEffect(() => {
    if (!catalogMethod) return;
    let live = true;
    client.request(catalogMethod, { scope: "project", limit: 1 }).then(
      () => { if (live) setProject("available"); },
      (error) => { if (live) setProject((error as { code?: unknown })?.code === -32005 ? "needs an open chat in a project" : "could not check project items"); });
    return () => { live = false; };
  }, [client, catalogMethod]);
  useEffect(() => { if (failure || (tried && problems.length)) alert.current?.focus(); }, [failure, tried]);

  const existing = rows.find((row) => row.name === name);
  const shadow = existing && (sourceTiers.indexOf(existing.source) < sourceTiers.indexOf(scope)
    ? `a ${existing.source} ${noun} named ${name} wins over this one.`
    : existing.source !== scope ? `this will win over the ${existing.source} ${name}.` : null);

  async function save() {
    if (pending || blocked) return;
    setTried(true);
    if (problems.length) return alert.current?.focus();
    setPending(true);
    setFailure(null);
    abort.current = new AbortController();
    const outcome = await writer.create(client, { kind, name, scope }, text, abort.current.signal);
    // a sent write cannot be recalled: a save that landed after discard is still shown.
    if (outcome.status === "saved") return onCreated(name, outcome.redacted);
    if (abort.current.signal.aborted) return;
    setPending(false);
    setFailure(outcome);
  }

  return <section className="library-editor" aria-label={`new ${noun}`} onKeyDown={(event) => {
    if (event.key === "Escape") event.preventDefault();
  }}>
    <h2>new {noun}</h2>
    <div className="library-editor-row">
      <label htmlFor={`${id}-name`}>name</label>
      <input id={`${id}-name`} ref={nameField} readOnly={Boolean(blocked)} value={name} autoComplete="off" spellCheck={false} aria-describedby={`${id}-rules`} aria-invalid={Boolean(name && nameProblem(name))}
        onChange={(event) => setName(event.target.value)} />
      <small id={`${id}-rules`} data-invalid={Boolean(name && nameProblem(name)) || undefined}>one word: no spaces, no / or \, not . or ..</small>
    </div>
    <fieldset className="library-editor-row">
      <legend>scope</legend>
      <label><input type="radio" name={`${id}-scope`} checked={scope === "home"} disabled={Boolean(blocked) && scope !== "home"} onChange={() => setScope("home")} /> home · every project</label>
      <label><input type="radio" name={`${id}-scope`} checked={scope === "project"} disabled={project !== "available" || (Boolean(blocked) && scope !== "project")} aria-describedby={`${id}-project`}
        onChange={() => setScope("project")} /> project · this project only</label>
      {project !== "available" && <small id={`${id}-project`}>{project === "checking" ? "checking project items…" : project}</small>}
    </fieldset>
    <div className="library-editor-row">
      <label htmlFor={`${id}-description`}>description</label>
      <input id={`${id}-description`} readOnly={Boolean(blocked)} value={description} autoComplete="off" disabled={edited !== null} onChange={(event) => setDescription(event.target.value)} />
      {edited !== null && <small>edit the description in the file text.</small>}
    </div>
    <div className="library-editor-row">
      <label htmlFor={`${id}-text`}>{name || "<name>"}.md · file text</label>
      <textarea id={`${id}-text`} readOnly={Boolean(blocked)} value={text} spellCheck={false} rows={12} onChange={(event) => setEdited(event.target.value)} />
      <small>the name and description fill the header until you edit the file text. sessions pick up the change at their next catalog refresh.</small>
    </div>
    {shadow && <p className="library-flag">{shadow}</p>}
    <div ref={alert} tabIndex={-1} className="library-editor-status">
      {blocked && <p role="alert" className="library-error">{blocked}. your text is kept; nothing was sent.</p>}
      {tried && problems.length > 0 && <ul role="alert" className="library-error">{problems.map((problem) => <li key={problem}>{problem}</li>)}</ul>}
      {failure && <div role="alert">
        <p className="library-error">{failure.message}</p>
        {failure.status === "stale" && <button type="button" onClick={() => onOpen(name)}>open it</button>}
        {failure.status === "observer" && <>
          <button type="button" onClick={() => void takeControl().then((reason) => { if (!reason) setFailure(null); })}>take control</button>
          {feedback && <span role="status">{feedback}</span>}
        </>}
      </div>}
    </div>
    <div className="library-editor-actions">
      <button type="button" onClick={() => { abort.current?.abort(); onClose(); }}>discard</button>
      {!blocked && <button type="button" className="library-primary" aria-disabled={pending || (tried && problems.length > 0)} onClick={() => void save()}>
        {pending ? "saving…" : tried && problems.length ? `save · fix ${problems.length} ${problems.length === 1 ? "problem" : "problems"} first` : `save ${noun}`}
      </button>}
    </div>
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
type EditProps = {
  client: ZetaClient; writer: Writer;
  /** Starts the editor from this draft; every change is reported back, so a socket drop that unmounts it loses nothing.
   * `onSaved` runs after each save; the editor shows the saved notice itself while the text is unchanged. */
  draft: EditDraft; onDraft: (draft: EditDraft) => void;
  takeControl: () => Promise<string | null>; feedback: string | null; blocked: string | null;
  onSaved: (redacted: boolean) => void; onClose: () => void;
};

/** Edits one existing file. Like the create form, its text lives only in memory and survives a client swap. */
export function LibraryEdit({ client, writer, draft, onDraft, takeControl, feedback, blocked, onSaved, onClose }: EditProps) {
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
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saved, setSaved] = useState(false);
  const field = useRef<HTMLTextAreaElement>(null);
  const alert = useRef<HTMLDivElement>(null);
  const keep = useRef<HTMLButtonElement>(null);
  const dirty = text !== base.document;
  const problems = createProblems(target.name, text);

  useEffect(() => { field.current?.focus(); }, []);
  useEffect(() => { onDraft({ target, base, text, mine }); }, [base, text, mine]);
  useEffect(() => { if (failure || (tried && problems.length)) alert.current?.focus(); }, [failure, tried]);
  useEffect(() => { if (confirmDiscard) keep.current?.focus(); }, [confirmDiscard]);
  // the browser asks before a reload, a close or a full page load (the library tabs) drops unsaved text.
  useEffect(() => {
    if (!dirty && !pending) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    addEventListener("beforeunload", warn);
    return () => removeEventListener("beforeunload", warn);
  }, [dirty, pending]);

  async function save() {
    // a stale save waits for "load the latest version": never a second write with a revision the user did not see.
    if (pending || blocked || !dirty || failure?.status === "stale") return;
    setTried(true);
    if (problems.length) return alert.current?.focus();
    setPending(true);
    setFailure(null);
    const sent = text;
    const outcome = await writer.save(client, target, base.revision, sent);
    setPending(false);
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
    <p role="status" className="library-editor-saved">{saved && !dirty ? SAVED_NOTICE : ""}</p>
    <div ref={alert} tabIndex={-1} className="library-editor-status">
      {blocked && <p role="alert" className="library-error">{blocked}. your text is kept; nothing was sent.</p>}
      {tried && problems.length > 0 && <ul role="alert" className="library-error">{problems.map((problem) => <li key={problem}>{problem}</li>)}</ul>}
      {failure && <div role="alert" className={stale ? "library-conflict" : undefined}>
        <p className="library-error">{failure.message}</p>
        {stale && <button type="button" aria-disabled={loading} onClick={() => void loadLatest()}>{loading ? "loading…" : "load the latest version"}</button>}
        {failure.status === "observer" && <>
          <button type="button" onClick={() => void takeControl().then((reason) => { if (!reason) setFailure(null); })}>take control</button>
          {feedback && <span role="status">{feedback}</span>}
        </>}
        {failure.status === "busy" && <button type="button" onClick={() => void save()}>try again</button>}
      </div>}
    </div>
    {confirmDiscard ? <div role="group" aria-label="discard changes?" className="library-editor-actions">
      <span>discard your changes to {target.name}?</span>
      <button type="button" ref={keep} onClick={() => setConfirmDiscard(false)}>keep editing</button>
      <button type="button" onClick={onClose}>discard changes</button>
    </div> : <div className="library-editor-actions">
      <button type="button" onClick={() => dirty ? setConfirmDiscard(true) : onClose()}>{dirty ? "discard" : "close"}</button>
      {!blocked && <button type="button" className="library-primary" aria-disabled={pending || stale || !dirty || (tried && problems.length > 0)} onClick={() => void save()}>
        {pending ? "saving…" : stale ? "load the latest version first" : tried && problems.length ? `save · fix ${problems.length} ${problems.length === 1 ? "problem" : "problems"} first` : `save ${noun}`}
      </button>}
    </div>}
  </section>;
}
