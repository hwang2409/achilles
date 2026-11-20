import { useEffect, useId, useRef, useState } from "react";
import type { ZetaClient } from "@fulcrum/zeta";
import { sourceTiers, type CatalogRow, type LibraryKind } from "./catalog";
import { createProblems, nameProblem, type createLibraryWriter, type WriteOutcome, type WriteScope } from "./libraryWrites";

type Writer = ReturnType<typeof createLibraryWriter>;
type Failure = Exclude<WriteOutcome, { status: "saved" }>;
type Props = {
  client: ZetaClient; kind: LibraryKind; writer: Writer; rows: CatalogRow[];
  /** The catalog method used to probe project scope; null when this zeta has no live catalog. */
  catalogMethod: string | null;
  takeControl: () => Promise<string | null>;
  onCreated: (name: string, redacted: boolean) => void;
  onOpen: (name: string) => void;
  onClose: () => void;
};

const header = (kind: LibraryKind, name: string, description: string) =>
  `---\nname: ${JSON.stringify(name)}\ndescription: ${JSON.stringify(description)}\n${kind === "skills" ? "keywords: []\n" : ""}---\n` +
  (kind === "skills" ? "describe when and how to use this skill.\n" : "describe how this agent works.\n");

/** The create form. Its text lives only in this component's memory (a draft can hold a secret), and the component
 * keeps its place when take control swaps the client, so the draft survives. */
export function LibraryEditor({ client, kind, writer, rows, catalogMethod, takeControl, onCreated, onOpen, onClose }: Props) {
  const noun = kind === "skills" ? "skill" : "profile";
  const id = useId();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [scope, setScope] = useState<WriteScope>("home");
  const [edited, setEdited] = useState<string | null>(null);
  const [project, setProject] = useState<"checking" | "available" | string>(catalogMethod ? "checking" : "needs a newer zeta");
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [control, setControl] = useState<string | null>(null);
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
    if (pending) return;
    setTried(true);
    if (problems.length) return alert.current?.focus();
    setPending(true);
    setFailure(null);
    setControl(null);
    abort.current = new AbortController();
    const outcome = await writer.create(client, { kind, name, scope }, text, abort.current.signal);
    if (abort.current.signal.aborted) return;
    setPending(false);
    if (outcome.status === "saved") onCreated(name, outcome.redacted);
    else setFailure(outcome);
  }

  return <section className="library-editor" aria-label={`new ${noun}`} onKeyDown={(event) => {
    if (event.key === "Escape") event.preventDefault();
  }}>
    <h2>new {noun}</h2>
    <div className="library-editor-row">
      <label htmlFor={`${id}-name`}>name</label>
      <input id={`${id}-name`} ref={nameField} value={name} autoComplete="off" spellCheck={false} aria-describedby={`${id}-rules`} aria-invalid={Boolean(name && nameProblem(name))}
        onChange={(event) => setName(event.target.value)} />
      <small id={`${id}-rules`} data-invalid={Boolean(name && nameProblem(name)) || undefined}>one word: no spaces, no / or \, not . or ..</small>
    </div>
    <fieldset className="library-editor-row">
      <legend>scope</legend>
      <label><input type="radio" name={`${id}-scope`} checked={scope === "home"} onChange={() => setScope("home")} /> home · every project</label>
      <label><input type="radio" name={`${id}-scope`} checked={scope === "project"} disabled={project !== "available"} aria-describedby={`${id}-project`}
        onChange={() => setScope("project")} /> project · this project only</label>
      {project !== "available" && <small id={`${id}-project`}>{project === "checking" ? "checking project items…" : project}</small>}
    </fieldset>
    <div className="library-editor-row">
      <label htmlFor={`${id}-description`}>description</label>
      <input id={`${id}-description`} value={description} autoComplete="off" disabled={edited !== null} onChange={(event) => setDescription(event.target.value)} />
      {edited !== null && <small>edit the description in the file text.</small>}
    </div>
    <div className="library-editor-row">
      <label htmlFor={`${id}-text`}>{name || "<name>"}.md · file text</label>
      <textarea id={`${id}-text`} value={text} spellCheck={false} rows={12} onChange={(event) => setEdited(event.target.value)} />
      <small>the name and description fill the header until you edit the file text. sessions pick up the change at their next catalog refresh.</small>
    </div>
    {shadow && <p className="library-flag">{shadow}</p>}
    <div ref={alert} tabIndex={-1} className="library-editor-status">
      {tried && problems.length > 0 && <ul role="alert" className="library-error">{problems.map((problem) => <li key={problem}>{problem}</li>)}</ul>}
      {failure && <div role="alert">
        <p className="library-error">{failure.message}</p>
        {failure.status === "stale" && <button type="button" onClick={() => onOpen(name)}>open it</button>}
        {failure.status === "observer" && <>
          <button type="button" onClick={() => void takeControl().then((reason) => { setControl(reason); if (!reason) setFailure(null); })}>take control</button>
          {control && <span role="status">{control}</span>}
        </>}
      </div>}
    </div>
    <div className="library-editor-actions">
      <button type="button" onClick={() => { abort.current?.abort(); onClose(); }}>discard</button>
      <button type="button" className="library-primary" aria-disabled={pending || (tried && problems.length > 0)} onClick={() => void save()}>
        {pending ? "saving…" : tried && problems.length ? `save · fix ${problems.length} ${problems.length === 1 ? "problem" : "problems"} first` : `save ${noun}`}
      </button>
    </div>
  </section>;
}
