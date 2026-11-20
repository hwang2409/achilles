import { useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { ZetaClient } from "@fulcrum/zeta";
import { DisplaySettings } from "../AppShell";
import { Confirmation, reviewText, type ReviewText } from "../surface/Confirmation";
import { ModuleFrame } from "../surface/ModuleState";
import { surfaceHref } from "../surface/routes";
import { WRITE_SURFACE } from "../writeSurfaces";
import { supportsFeature } from "../zeta";
import { HOME_SETTINGS_FEATURE, readHomeSettings, receipt, telemetryChange, type HomeSettings, type Restart } from "./homeSettings";
import "./settings-place.css";

type WithControl = <T>(read: (client: ZetaClient) => Promise<T>) => Promise<{ value: T } | { refused: string }>;
type Props = { client: ZetaClient | null; connecting: boolean; withControl: WithControl; live: () => ZetaClient | null };

export function SettingsModule(props: Props) {
  const openBrowserSettings = useContext(DisplaySettings);
  const [shown, setShown] = useState(() => ["#zeta-defaults", "#telemetry"].includes(location.hash) ? "zeta-defaults" : "browser");
  const section = (id: string, label: string) => <a href={`#${id}`} aria-current={shown === id ? "location" : undefined}
    onClick={() => { setShown(id); document.querySelector<HTMLElement>(`#${id} h2`)?.focus(); }}>{label}</a>;
  return <ModuleFrame title="settings">
    <div className="sp">
      <nav className="sp-subnav" aria-label="settings sections">
        {section("browser", "this browser")}
        {section("zeta-defaults", "zeta defaults")}
        <a href={surfaceHref("/accounts")}>accounts <span aria-hidden="true">→</span></a>
        <a href={surfaceHref("/mcp")}>mcp connections <span aria-hidden="true">→</span></a>
      </nav>
      <div className="sp-content">
        <section id="browser" aria-labelledby="settings-browser">
          <h2 id="settings-browser" tabIndex={-1}>this browser</h2>
          <p className="sp-dim">theme, fonts, text size, density and vim mode. they apply to this browser only.</p>
          <button type="button" onClick={openBrowserSettings}>display settings</button>
        </section>
        <section id="zeta-defaults" aria-labelledby="settings-zeta">
          <h2 id="settings-zeta" tabIndex={-1}>zeta defaults</h2>
          <p className="sp-dim">these apply to every zeta on this computer.</p>
          {props.client ? <ZetaDefaults {...props} client={props.client} />
            : <p className="sp-dim" role="status">{props.connecting ? "connecting to zeta…" : "zeta is not connected. retrying automatically."}</p>}
        </section>
      </div>
    </div>
  </ModuleFrame>;
}

function ZetaDefaults({ client, withControl, live }: Props & { client: ZetaClient }) {
  return <>
    {supportsFeature(client, HOME_SETTINGS_FEATURE) ? <TelemetryRow client={client} withControl={withControl} live={live} />
      : <Row id="telemetry" title="telemetry" detail={RECORDS}><p className="sp-note">this zeta cannot change settings here. update zeta.</p></Row>}
    {supportsFeature(client, "state_read_v1") && <Defaults client={client} />}
  </>;
}

const RECORDS = "records timings, model, tokens, tool names and error types on this computer. never prompts, replies, or tool arguments.";

function Row({ id, title, detail, children }: { id?: string; title: string; detail: string; children: ReactNode }) {
  return <div className="sp-row" id={id}>
    <div className="sp-row-text"><h3 tabIndex={-1}>{title}</h3><p className="sp-dim">{detail}</p></div>
    {children}
  </div>;
}

type Load = { kind: "loading" } | { kind: "failed"; unsafe: boolean } | { kind: "ready"; settings: HomeSettings };
type Change = { enabled: boolean; restart: Restart; at: Date };
type Attempt = Awaited<ReturnType<ReturnType<typeof telemetryChange>["execute"]>>;

function TelemetryRow({ client, withControl, live }: { client: ZetaClient; withControl: WithControl; live: () => ZetaClient | null }) {
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [change, setChange] = useState<Change | null>(null);
  const [note, setNote] = useState<ReviewText | null>(null);
  const [activity, setActivity] = useState<HTMLElement | null>(null);
  // a stale change remounts the confirmation, so the next attempt sends the reread revision
  const [attempts, setAttempts] = useState(0);
  // after a stale change: focus the row's control once now, and again when the reread lands
  const refocus = useRef<"now" | "read" | null>(null);
  const status = useRef<HTMLParagraphElement>(null);
  const noteRef = useRef<HTMLParagraphElement>(null);
  const generation = useRef(0);
  const scrolled = useRef(false);
  const reread = useCallback(() => {
    const mine = ++generation.current;
    // the live client: a reread asked for by a borrowed write runs after control went back
    readHomeSettings(live() ?? client).then(
      (settings) => { if (mine === generation.current) setLoad({ kind: "ready", settings }); },
      (error) => { if (mine === generation.current) setLoad({ kind: "failed", unsafe: (error as { data?: { code?: unknown } })?.data?.code === "settings_unsafe" }); });
  }, [client, live]);
  useEffect(() => {
    reread();
    // zeta sends no change event: read again when the tab comes back
    window.addEventListener("focus", reread);
    return () => { generation.current++; window.removeEventListener("focus", reread); };
  }, [reread]);
  useEffect(() => {
    if (load.kind === "loading" || scrolled.current) return;
    scrolled.current = true;
    if (location.hash !== "#telemetry") return;
    const heading = document.querySelector<HTMLElement>("#telemetry h3");
    heading?.focus({ preventScroll: true });
    heading?.scrollIntoView({ block: "center" });
  }, [load.kind]);
  useEffect(() => { if (change) status.current?.focus(); }, [change]);
  useLayoutEffect(() => {
    if (!refocus.current) return;
    (document.getElementById("telemetry")?.querySelector("button") ?? noteRef.current)?.focus();
    refocus.current = refocus.current === "now" ? "read" : null;
  }, [attempts, load]);

  let control: ReactNode;
  if (load.kind === "loading") control = <p className="sp-dim" role="status">reading settings…</p>;
  else if (load.kind === "failed") control = <div className="sp-switch">
    <span className="sp-value">unknown</span>
    <p className="sp-note" role="alert">{load.unsafe ? "settings.toml is a link or a shared file. zeta does not change it." : "could not read settings from zeta."}
      {!load.unsafe && <button type="button" onClick={reread}>try again</button>}</p>
  </div>;
  else {
    const { settings } = load;
    const op = (enabled: boolean) => {
      const attempt = telemetryChange({ before: settings, enabled, withControl, live, reread,
        committed: (next, restart) => { generation.current++; setNote(null); setLoad({ kind: "ready", settings: next }); setChange({ enabled, restart, at: new Date() }); } });
      const settle = (result: Attempt) => {
        const failed = result.status === "failed" ? result : null;
        // a refusal with zeta's own reason, and a stale change, stay in the row after the confirmation closes
        setNote(failed?.message && (enabled || failed.reason === "changed") ? failed.message : null);
        if (failed?.reason === "changed") { refocus.current = "now"; setAttempts((count) => count + 1); }
        return result;
      };
      return {
        execute: async () => { setChange(null); return settle(await attempt.execute()); },
        checkResult: async () => settle(await attempt.checkResult()),
      };
    };
    if (settings.editable && settings.telemetry === "on") {
      control = <Confirmation key={attempts} level={1} surface={WRITE_SURFACE.settingsTelemetry} label={reviewText("telemetry")} value={reviewText("on")}
        action={reviewText("turn off")} keep={reviewText("keep it on")}
        effect={reviewText("turn telemetry off? it stops new traces after zeta serve and running sessions restart. recorded traces stay.")}
        onCommitted={() => {}} {...op(false)} />;
    } else if (settings.editable) {
      control = <div className="sp-switch">
        <span className="sp-value">off</span>
        {activity && <Confirmation key={attempts} level={2} surface={WRITE_SURFACE.settingsTelemetry} activity={activity} title={reviewText("turn on telemetry")}
          scope={reviewText("every zeta on this computer (settings.toml in your zeta home)")}
          current={reviewText("off")} after={reviewText("on. zeta sends traces to the built-in receiver on 127.0.0.1:4323")}
          effect={reviewText("records timings, model, tokens, tool names and error types on this computer. never prompts, replies, or tool arguments. it starts after zeta serve and running sessions restart. zeta needs zeta[otel] installed; without it zeta does not start until you install it or turn telemetry off (or remove the otel endpoint line from settings.toml).")}
          undo={reviewText("turn it off here. settings.toml goes back to the exact bytes it had.")}
          proof={{ kind: "scope", label: reviewText("i understand this applies to every zeta on this computer") }}
          action={reviewText("turn on telemetry")} keep={reviewText("keep it off")} {...op(true)} />}
      </div>;
    } else {
      const custom = settings.telemetry === "custom-on" || settings.telemetry === "custom-off";
      control = <div className="sp-switch">
        <span className="sp-value">{custom ? `${settings.telemetry === "custom-on" ? "on" : "off"} (custom endpoint)` : "unknown"}</span>
        <p className="sp-note">{custom ? "telemetry uses a custom endpoint from settings.toml. change it there."
          : settings.malformed ? "settings.toml has an error. zeta will not start until it is fixed."
          : "zeta reports a telemetry setting this page does not know. change it in settings.toml."}</p>
      </div>;
    }
  }
  return <Row id="telemetry" title="telemetry" detail={RECORDS}>
    {control}
    <div ref={setActivity} className="sp-activity" />
    {note && <p ref={noteRef} className="sp-note sp-result" tabIndex={-1} role="status">{note}</p>}
    {change && <div className="sp-receipt">
      <p ref={status} tabIndex={-1} role="status">{receipt(change.enabled)} at <time dateTime={change.at.toISOString()}>
        {change.at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }).toLowerCase()}</time></p>
      <p>{restartText(change.restart)} this list goes away when you leave this page.</p>
    </div>}
  </Row>;
}

export function restartText(restart: Restart) {
  if (!restart) return "zeta did not report which sessions to restart. restart zeta serve and every running session.";
  const { sessions, complete } = restart;
  const list = sessions.length === 0 ? "restart zeta serve."
    : `restart zeta serve and ${sessions.length} running ${sessions.length === 1 ? "session" : "sessions"}: ${sessions.map((id) => id.slice(0, 8)).join(", ")}.`;
  return complete ? list : `${list} zeta stopped looking after 1 s; other running sessions may also need a restart.`;
}

type Defaults = { model: string | null; provider: string | null; approval: "allow" | "ask" | null; depth: number };

export function parseDefaults(result: unknown): Defaults | null {
  const value = result as Record<string, unknown> | null;
  if (value === null || typeof value !== "object") return null;
  const { model, provider, approval_mode: approval, max_depth: depth } = value;
  const optional = (item: unknown): item is string | null => item === null || typeof item === "string";
  if (!optional(model) || !optional(provider) || !(approval === null || approval === "allow" || approval === "ask") ||
      typeof depth !== "number" || !Number.isSafeInteger(depth) || depth < 0) return null;
  return { model, provider, approval, depth };
}

// `state_settings` errors name only the kind: say what that kind is true for
export function defaultsFailure(error: unknown) {
  const code = (error as { data?: { code?: unknown } } | null)?.data?.code;
  return code === "corrupt_state" ? "could not read the other zeta defaults. zeta reports that settings.toml or its stored state is invalid."
    : code === "state_unavailable" ? "could not read the other zeta defaults right now. reload the page to try again."
    : "could not read the other zeta defaults.";
}

function Defaults({ client }: { client: ZetaClient }) {
  const [defaults, setDefaults] = useState<Defaults | "loading" | { failed: string }>("loading");
  useEffect(() => {
    let live = true;
    client.request("state_settings", { collection: "mcp", limit: 1 }).then(
      (result) => { if (live) setDefaults(parseDefaults(result) ?? { failed: defaultsFailure(null) }); },
      (error) => { if (live) setDefaults({ failed: defaultsFailure(error) }); });
    return () => { live = false; };
  }, [client]);
  if (defaults === "loading") return <p className="sp-dim" role="status">reading zeta defaults…</p>;
  if ("failed" in defaults) return <p className="sp-note">{defaults.failed}</p>;
  const rows: [string, string, string][] = [
    ["model", defaults.model ?? "not set", "change it in the terminal (model in settings.toml). a chat can change its own model."],
    ["provider", defaults.provider ?? "not set", "change it in the terminal (provider in settings.toml)."],
    ["approval mode", defaults.approval === "allow" ? "allow without asking" : defaults.approval ?? "not set", "change it in the terminal (yolo in settings.toml). a chat can change its own approvals."],
    ["agent nesting depth", String(defaults.depth), "change it in the terminal (max_depth under [agents] in settings.toml)."],
  ];
  return <dl className="sp-defaults">
    {rows.map(([label, value, where]) => <div key={label}>
      <dt>{label}</dt><dd className="sp-value">{value}</dd><dd className="sp-dim">{where}</dd>
    </div>)}
  </dl>;
}
