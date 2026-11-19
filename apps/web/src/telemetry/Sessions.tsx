import type { MouseEvent, ReactNode } from "react";
import { EnumListbox } from "../page/EnumListbox";
import { formatCount, formatDuration, formatFullTime, formatTime, formatTokens, shortId } from "./format";
import type { Page, TelemetrySession } from "./telemetry-types";

/** The cursor of every page from the first (`null`) to the shown one, and the filters they share. */
export type SessionsQuery = { cursors: (string | null)[]; errorsOnly: boolean; profile: string | null; model: string | null };

export const PAGE_SIZE = 50;
const isFiltered = (query: SessionsQuery) => query.errorsOnly || query.profile !== null || query.model !== null;
const ANY = "any";
const NUMERIC = ["duration", "turns", "model calls", "tool calls", "errors", "tokens in / out"];

/**
 * `total` is the session count of the whole range (overview totals). It ignores the filters, so it shows only while
 * no filter is on. `open` follows a row's link inside the module.
 */
export function Sessions({ page, total, query, shown, rangeLabel, profiles, models, setFilters, next, previous, open, empty }: {
  page: Page<TelemetrySession>;
  total: number;
  /** The choice in the filter controls. */
  query: SessionsQuery;
  /** The query that `page` answers; it differs from `query` until the reply for a new choice arrives. */
  shown: SessionsQuery;
  rangeLabel: string;
  profiles: string[];
  models: string[];
  setFilters: (next: Partial<SessionsQuery>) => void;
  /** Absent while paging is off: on the first page, at the end, or until the reply for the shown choice arrives. */
  next?: () => void;
  previous?: () => void;
  open: (event: MouseEvent<HTMLAnchorElement>, href: string) => void;
  empty: ReactNode;
}) {
  const filtered = isFiltered(shown);
  if (page.items.length === 0 && shown.cursors.length === 1 && !filtered) return empty;
  const from = (shown.cursors.length - 1) * PAGE_SIZE + 1;
  const to = from + page.items.length - 1;
  const sum = (key: "input_tokens" | "output_tokens" | "total_tokens") => page.items.reduce((sum, session) => sum + session[key], 0);
  const count = filtered ? null : `${formatCount(total)} ${total === 1 ? "session" : "sessions"}`;
  return (
    <div className="tm-sessions">
      <div className="tm-heading">
        <h1>{count && <span className="tm-narrow-only">{count}</span>}<span className="tm-wide-only">sessions</span>{!count && <span className="tm-narrow-only">sessions</span>}</h1>
        <p className="tm-dim">
          {count ? <span className="tm-wide-only"><b>{count}</b> in the </span> : <span className="tm-wide-only">matching sessions in the </span>}
          {rangeLabel}
          <span className="tm-narrow-only"> · last seen, newest first</span><span className="tm-wide-only"> · newest first</span>
        </p>
      </div>
      <div className="tm-filters">
        <Choice label="profile" value={query.profile} options={profiles} set={(profile) => setFilters({ profile })} />
        <Choice label="model" value={query.model} options={models} set={(model) => setFilters({ model })} />
        <label className="tm-check">
          <input type="checkbox" checked={query.errorsOnly} onChange={(event) => setFilters({ errorsOnly: event.target.checked })} />
          <span><span className="tm-wide-only">with </span>errors only</span>
        </label>
        {isFiltered(query) && <button type="button" className="tm-link" onClick={() => setFilters({ errorsOnly: false, profile: null, model: null })}>clear filters</button>}
      </div>
      {page.items.length === 0
        ? <p className="tm-none">no sessions match these filters.</p>
        : <table className="tm-table">
            <caption className="tm-visually-hidden">sessions, newest activity first</caption>
            <thead>
              <tr>{["last seen", "profile", "session", "model", ...NUMERIC].map((label) => <th key={label} scope="col" className={NUMERIC.includes(label) ? "tm-num" : undefined} aria-sort={label === "last seen" ? "descending" : undefined}>{label}{label === "last seen" && <span aria-hidden="true"> ↓</span>}</th>)}</tr>
            </thead>
            <tbody>{page.items.map((session) => <SessionRow key={session.session_id} session={session} open={open} />)}</tbody>
          </table>}
      {page.items.length > 0 && <footer className="tm-pager">
        <p>these {formatCount(page.items.length)} used <b className="tm-num">{formatTokens(sum("total_tokens"))}</b> tokens · in <b className="tm-num">{formatTokens(sum("input_tokens"))}</b> · out <b className="tm-num">{formatTokens(sum("output_tokens"))}</b></p>
        <div className="tm-pager-buttons">
          <span className="tm-num tm-dim">{from}–{to}{count && ` of ${formatCount(total)}`}</span>
          <button type="button" className="tm-button" disabled={!previous} onClick={previous} aria-label="newer sessions">‹ newer</button>
          <button type="button" className="tm-button" disabled={!next} onClick={next} aria-label="older sessions">older ›</button>
        </div>
      </footer>}
    </div>
  );
}

/** Options follow EnumListbox's convention: real values are JSON-encoded, so a profile named "any" never reads as no filter. */
function Choice({ label, value, options, set }: { label: string; value: string | null; options: string[]; set: (value: string | null) => void }) {
  const choices = value !== null && !options.includes(value) ? [value, ...options] : options;
  return (
    <div className={`tm-select${value !== null ? " tm-select-on" : ""}`}>
      <EnumListbox label={label} value={value === null ? ANY : JSON.stringify(value)} options={[ANY, ...choices.map((option) => JSON.stringify(option))]} onChange={(next) => set(next === ANY ? null : JSON.parse(next))} />
    </div>
  );
}

/**
 * One row is one link target: the profile link stretches over the row and opens the session's route. Narrow screens
 * show the row as a three-line card; `unit` is the word printed after a number there, so every value keeps a label.
 */
function SessionRow({ session, open }: { session: TelemetrySession; open: (event: MouseEvent<HTMLAnchorElement>, href: string) => void }) {
  const href = `/telemetry/sessions/${encodeURIComponent(session.session_id)}`;
  const cell = (label: string, content: ReactNode, className?: string, unit?: string) => <td data-label={label} data-unit={unit} className={className}>{content}</td>;
  return (
    <tr className="tm-row">
      {cell("last seen", <time dateTime={new Date(session.last_ns / 1e6).toISOString()} title={formatFullTime(session.last_ns)}>{formatTime(session.last_ns)}</time>, "tm-time")}
      {cell("profile", <a className="tm-row-link" href={href} onClick={(event) => open(event, href)} aria-label={`session ${session.session_id}, ${session.profile ?? "no profile"}`}>{session.profile ?? <span className="tm-dim">no profile</span>}</a>, "tm-profile")}
      {cell("session", <span title={session.session_id}>{shortId(session.session_id)}</span>, "tm-id")}
      {cell("model", session.model ?? <span className="tm-dim">not reported</span>, "tm-model")}
      {cell("duration", formatDuration(session.last_ns - session.first_ns), "tm-num tm-duration")}
      {cell("turns", formatCount(session.turn_count), "tm-num tm-turns", session.turn_count === 1 ? "turn" : "turns")}
      {cell("model calls", formatCount(session.model_count), "tm-num tm-calls", "model")}
      {cell("tool calls", formatCount(session.tool_count), "tm-num tm-toolcalls", "tool")}
      {cell("errors", session.error_count > 0 ? <span className="tm-danger"><span aria-hidden="true" className="tm-narrow-only">▲ </span>{formatCount(session.error_count)}</span> : <span className="tm-dim">0</span>, "tm-num tm-errors", session.error_count === 1 ? "error" : "errors")}
      {cell("tokens in / out", <span title={`${formatCount(session.input_tokens)} in, ${formatCount(session.output_tokens)} out`}>{formatTokens(session.input_tokens)} / {formatTokens(session.output_tokens)}</span>, "tm-num tm-inout", "tok")}
      <td className="tm-break" aria-hidden="true" />
    </tr>
  );
}
