import { useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { Confirmation, reviewText, type Result, type ReviewText } from "../surface/Confirmation";
import { WRITE_SURFACE } from "../writeSurfaces";
import { mcpFailure, mcpReceipt } from "./McpActions";
import { projectAdd, type McpAddAttempt, type McpAddMutation, type McpOutcome, type McpOwner } from "./mcpOwner";
import { isMcpName, type McpReads, type McpRow } from "./mcpReads";

type Scope = McpRow["scope"];
type Snapshot = NonNullable<ReturnType<McpReads["snapshot"]>>;
const LIMIT = 128;
const bounded = (value: string) => !value.includes("\0") && [...value].length <= 8192;

function readFields(data: FormData, field: string) {
  const keys = data.getAll(`${field}-key`).map(String);
  const values = data.getAll(field).map(String);
  if (keys.length > LIMIT || keys.length !== values.length || new Set(keys).size !== keys.length
    || keys.some((key) => !key || !bounded(key)) || values.some((value) => !bounded(value))) return null;
  return Object.fromEntries(keys.map((key, index) => [key, values[index]!]));
}
type AddBase = Pick<McpAddMutation, "scope" | "name" | "enabled" | "env">;

function readMutation(form: HTMLFormElement): McpAddMutation | string {
  const data = new FormData(form);
  const scope = data.get("scope"), name = data.get("name");
  if (!isMcpName(name)) return "enter a connection name of 1–256 characters without control characters. do not use . or ..";
  if (scope !== "user" && scope !== "project") return "choose a configuration scope.";
  const env = readFields(data, "environment");
  if (!env) return "enter a unique, nonempty key for each environment value. check the field limits below.";
  const base = { scope, name, enabled: data.has("enabled"), env } as const;
  return data.get("transport") === "stdio" ? readStdio(data, base) : readHttp(data, base);
}

function readStdio(data: FormData, base: AddBase) {
  const command = String(data.get("command") ?? "");
  const args = data.getAll("argument").map(String);
  if (!command || !bounded(command) || args.length > LIMIT || args.some((arg) => !bounded(arg))) return "enter a command and check the argument limits below.";
  return { ...base, command, args };
}

function readHttp(data: FormData, base: AddBase) {
  const url = String(data.get("url") ?? "");
  const headers = readFields(data, "header"), oauth = data.has("oauth");
  const client_id = String(data.get("client_id") ?? ""), client_secret = String(data.get("client_secret") ?? "");
  if (!url || !bounded(url)) return "enter an HTTP URL within the field limit below.";
  if (!headers) return "enter a unique, nonempty key for each header. check the field limits below.";
  if (!bounded(client_id) || !bounded(client_secret) || (client_secret && !client_id)) return "enter a client ID before a client secret, and check the field limits below.";
  return { ...base, url, headers, oauth, ...(client_id && { client_id }), ...(client_secret && { client_secret }) };
}

const clearPrivate = (form: HTMLFormElement) => {
  for (const input of form.querySelectorAll<HTMLInputElement>('input[type="password"]')) input.value = "";
};
function PrivateField({ name, label }: { name: string; label: string }) {
  return <label className="mcp-add-field">{label}<input name={name} type="password" autoComplete="off" spellCheck={false} /></label>;
}
function Fields({ field, paired = false }: { field: "argument" | "environment" | "header"; paired?: boolean }) {
  const [count, setCount] = useState(0);
  const legends = { argument: "arguments", environment: "environment", header: "headers" };
  return <fieldset className="mcp-add-entries">
    <legend>{legends[field]}</legend>
    {Array.from({ length: count }, (_, index) => <div className="mcp-add-entry" key={index}>
      {paired && <PrivateField name={`${field}-key`} label={`${field} ${index + 1} key`} />}
      <PrivateField name={field} label={`${field} ${index + 1}${paired ? " value" : ""}`} />
    </div>)}
    <div className="mcp-add-buttons">
      <button type="button" disabled={count >= LIMIT} onClick={() => setCount(count + 1)}>add {field}</button>
      {count > 0 && <button type="button" onClick={() => setCount(count - 1)}>remove last {field}</button>}
    </div>
  </fieldset>;
}

const scopeLabel = (scope: Scope) => scope === "project" ? reviewText("zeta’s current project") : reviewText("user");
const countText = (count: number) => `${count}${count ? " provided · redacted" : ""}` as ReviewText;
function reviewFields(config: McpRow["config"], enabled: boolean, clientId: boolean) {
  return [
    { label: reviewText("transport"), value: config.transport === "stdio" ? reviewText("local command") : reviewText("remote HTTP") },
    { label: config.commandProvided ? reviewText("command") : reviewText("URL"), value: reviewText("provided · redacted") },
    config.commandProvided ? { label: reviewText("arguments"), value: countText(config.args) }
      : { label: reviewText("headers"), value: countText(config.headers) },
    { label: reviewText("environment"), value: countText(config.env) },
    ...(config.urlProvided ? [
      { label: reviewText("OAuth"), value: config.oauth ? reviewText("oauth configured · sign-in state not checked") : reviewText("not configured") },
      { label: reviewText("client ID"), value: { provided: clientId } },
      { label: reviewText("client secret"), value: { provided: config.oauth?.secretProvided === true } },
    ] : []),
    { label: reviewText("configuration"), value: enabled ? reviewText("enabled") : reviewText("disabled") },
  ];
}

type Review = { id: number; attempt: McpAddAttempt; clientId: boolean };
export function McpAdd({ owner, snapshot, defaultScope, online, reviewTrust }: {
  owner: McpOwner; snapshot: Snapshot; defaultScope: Scope; online: boolean; reviewTrust: (name: string) => void;
}) {
  const [open, setOpen] = useState(false);
  return <section className="mcp-add" aria-label="add a connection">
    {!open ? <button type="button" className="primary" data-write-surface={WRITE_SURFACE.mcpAdd} disabled={!online}
      onClick={() => setOpen(true)}>add connection</button>
      : <AddForm owner={owner} snapshot={snapshot} defaultScope={defaultScope} online={online} reviewTrust={reviewTrust} close={() => setOpen(false)} />}
  </section>;
}

function AddForm({ owner, snapshot, defaultScope, online, reviewTrust, close }: {
  owner: McpOwner; snapshot: Snapshot; defaultScope: Scope; online: boolean; reviewTrust: (name: string) => void; close: () => void;
}) {
  const [scope, setScope] = useState(defaultScope);
  const [http, setHttp] = useState(false);
  const [oauth, setOauth] = useState(false);
  const [error, setError] = useState("");
  const [review, setReview] = useState<Review | null>(null);
  const [trustName, setTrustName] = useState<string | null>(null);
  const [activity, setActivity] = useState<HTMLDivElement | null>(null);
  const form = useRef<HTMLFormElement>(null);
  const opener = useRef<HTMLButtonElement>(null);
  const flight = useRef<string | null>(null);
  useLayoutEffect(() => () => { if (flight.current) owner.close(flight.current); }, [owner]);
  const clear = () => { if (form.current) clearPrivate(form.current); };
  const begin = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!online) return;
    const mutation = readMutation(event.currentTarget);
    if (typeof mutation === "string") { setError(mutation); return; }
    const current = snapshot[mutation.scope];
    if (!("revision" in current)) { setError("zeta could not read this scope. refresh the configuration before reviewing."); return; }
    const { name, scope, enabled } = mutation;
    setError("");
    setTrustName(null);
    const attempt: McpAddAttempt = { action: "add", revision: current.revision, scope, name, enabled, config: projectAdd(mutation),
      existed: current.rows.some((row) => row.name === name) };
    setReview({ id: (review?.id ?? 0) + 1, attempt, clientId: "client_id" in mutation && Boolean(mutation.client_id) });
  };
  async function perform(attempt: McpAddAttempt, check: boolean): Promise<Result<{ status: "committed"; receipt: ReviewText }>> {
    const id = owner.open();
    flight.current = id;
    let outcome: McpOutcome = { status: "unknown" };
    const detach = owner.attach(id, (result) => { outcome = result; });
    try {
      if (check) await owner.check(id, attempt);
      else await owner.add(id, attempt, () => {
        const mutation = form.current && readMutation(form.current);
        clear();
        return typeof mutation === "string" ? null : mutation;
      });
    } finally {
      clear();
      detach();
      owner.close(id);
      flight.current = null;
    }
    const result = outcome as McpOutcome;
    if (result.status !== "committed") return mcpFailure(result);
    if (attempt.scope === "project" && attempt.config.commandProvided) setTrustName(attempt.name);
    return { status: "committed", receipt: mcpReceipt(result) };
  }
  const attempt = review?.attempt;
  const projectCommand = attempt?.scope === "project" && attempt.config.commandProvided;
  return <>
    <form ref={form} className="mcp-add-form" autoComplete="off" onSubmit={begin} noValidate>
      <h2>add connection</h2>
      <p>save a definition for new sessions. adding it does not start a process or contact a server.</p>
      <div className="mcp-add-entry">
        <label className="mcp-add-field">scope<select name="scope" value={scope} onChange={(event) => setScope(event.currentTarget.value === "project" ? "project" : "user")}>
          <option value="user">user</option><option value="project">zeta’s current project</option>
        </select></label>
        <label className="mcp-add-field">transport<select name="transport" value={http ? "http" : "stdio"} onChange={(event) => { setHttp(event.currentTarget.value === "http"); setOauth(false); }}>
          <option value="stdio">local command (stdio)</option><option value="http">remote HTTP</option>
        </select></label>
      </div>
      <label className="mcp-add-field">connection name<input name="name" type="text" autoComplete="off" spellCheck={false} /></label>
      {http ? <PrivateField key="url" name="url" label="HTTP URL" /> : <PrivateField key="command" name="command" label="local command" />}
      {!http && <Fields field="argument" />}
      <Fields field="environment" paired />
      {http && <>
        <Fields field="header" paired />
        <label><input name="oauth" type="checkbox" checked={oauth} onChange={(event) => setOauth(event.currentTarget.checked)} /> configure OAuth</label>
        {oauth && <div className="mcp-add-entry">
          <PrivateField name="client_id" label="client ID (optional)" />
          <PrivateField name="client_secret" label="client secret (requires a client ID)" />
        </div>}
      </>}
      <label><input name="enabled" type="checkbox" defaultChecked /> enable for new sessions</label>
      <p className="mcp-add-limits">name: 1–256 characters. other fields: up to 8192 characters, no NUL. up to 128 arguments, environment entries, and headers each. entry keys cannot be empty. check the command or URL before confirming.</p>
      {error && <p role="alert">{error}</p>}
      <div className="mcp-add-buttons">
        <button ref={opener} type="submit" className="primary" disabled={!online}>review connection</button>
        <button type="button" onClick={() => { clear(); close(); }}>cancel add</button>
      </div>
    </form>
    <div ref={setActivity} />
    {trustName && <button type="button" disabled={!online} onClick={() => { clear(); close(); reviewTrust(trustName); }}>open connection to review trust</button>}
    {attempt && review && <Confirmation key={review.id} level={2} external={{ opener: () => opener.current, onKeep: clear }} activity={activity ?? undefined}
      title={reviewText("review new connection")} action={reviewText("add connection")} keep={reviewText("back to fields")}
      scope={scopeLabel(attempt.scope)} current={attempt.existed ? reviewText("name already configured") : reviewText("no definition for this name")}
      after={reviewText("new definition on disk")} proof={{ kind: "scope", label: reviewText("i reviewed the scope for this connection") }}
      fields={reviewFields(attempt.config, attempt.enabled, review.clientId)}
      effect={projectCommand ? reviewText("a separate trust review is required before new sessions can run this local process. nothing runs now.")
        : attempt.config.commandProvided ? reviewText("new sessions can start this local process when enabled. nothing runs now.")
        : reviewText("new sessions can contact this remote server when enabled. no network request is made now.")}
      undo={reviewText("remove the definition to undo this change. running sessions are unchanged.")}
      execute={() => perform(attempt, false)} checkResult={() => perform(attempt, true)} />}
  </>;
}
