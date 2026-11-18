import type { ReactNode } from "react";
import { formatCount, formatDuration, formatFullTime, formatTime, formatTokens, shortId } from "./format";
import type { Page, TelemetrySession } from "./telemetry-types";

/** The cursor of every page from the first (`null`) to the shown one, and the filters they share. */
export type SessionsQuery = { cursors: (string | null)[]; errorsOnly: boolean; profile: string | null; model: string | null };

const NUMERIC = ["duration", "turns", "model calls", "tool calls", "errors", "tokens in / out"];

export function Sessions({ page, query, rangeLabel, profiles, models, setFilters, next, previous, empty }: {
  page: Page<TelemetrySession>;
  query: SessionsQuery;
  rangeLabel: string;
  profiles: string[];
  models: string[];
  setFilters: (next: Partial<SessionsQuery>) => void;
  next: () => void;
  previous: () => void;
  empty: ReactNode;
}) {
  const filtered = query.errorsOnly || query.profile !== null || query.model !== null;
  const firstPage = query.cursors.length === 1;
  if (page.items.length === 0 && firstPage && !filtered) return empty;
  const index = query.cursors.length - 1;
  const from = index * 50 + 1;
  const to = index * 50 + page.items.length;
  const sum = (key: "input_tokens" | "output_tokens" | "total_tokens") => page.items.reduce((total, session) => total + session[key], 0);
  return (
    <div className="tm-sessions">
      <div className="tm-heading">
        <h1>sessions</h1>
        <span className="tm-dim">{page.items.length ? <><b className="tm-num">{from}–{to}</b> in the {rangeLabel}{filtered && " that match"} · newest first</> : `none in the ${rangeLabel} match`}</span>
      </div>
      <div className="tm-filters">
        <Choice label="profile" value={query.profile} options={profiles} set={(profile) => setFilters({ profile })} />
        <Choice label="model" value={query.model} options={models} set={(model) => setFilters({ model })} />
        <label className="tm-check">
          <input type="checkbox" checked={query.errorsOnly} onChange={(event) => setFilters({ errorsOnly: event.target.checked })} />
          with errors only
        </label>
        {filtered && <button type="button" className="tm-link" onClick={() => setFilters({ errorsOnly: false, profile: null, model: null })}>clear filters</button>}
      </div>
      {page.items.length === 0
        ? <p className="tm-none">no sessions match these filters.</p>
        : <table className="tm-table">
            <caption className="tm-visually-hidden">sessions, newest activity first</caption>
            <thead>
              <tr>{["last seen", "profile", "session", "model", ...NUMERIC].map((label) => <th key={label} scope="col" className={NUMERIC.includes(label) ? "tm-num" : undefined} aria-sort={label === "last seen" ? "descending" : undefined}>{label}{label === "last seen" && <span aria-hidden="true"> ↓</span>}</th>)}</tr>
            </thead>
            <tbody>{page.items.map((session) => <SessionRow key={session.session_id} session={session} />)}</tbody>
          </table>}
      {page.items.length > 0 && <footer className="tm-pager">
        <p>these {formatCount(page.items.length)} used <b className="tm-num">{formatTokens(sum("total_tokens"))}</b> tokens · in <b className="tm-num">{formatTokens(sum("input_tokens"))}</b> · out <b className="tm-num">{formatTokens(sum("output_tokens"))}</b></p>
        <div className="tm-pager-buttons">
          <span className="tm-num tm-dim">{from}–{to}</span>
          <button type="button" className="tm-button" disabled={firstPage} onClick={previous} aria-label="newer sessions">‹ newer</button>
          <button type="button" className="tm-button" disabled={!page.next_cursor} onClick={next} aria-label="older sessions">older ›</button>
        </div>
      </footer>}
    </div>
  );
}

function Choice({ label, value, options, set }: { label: string; value: string | null; options: string[]; set: (value: string | null) => void }) {
  const choices = value !== null && !options.includes(value) ? [value, ...options] : options;
  return (
    <label className={`tm-select${value !== null ? " tm-select-on" : ""}`}>
      <span>{label}</span>
      <select value={value ?? ""} onChange={(event) => set(event.target.value || null)}>
        <option value="">any</option>
        {choices.map((option) => <option key={option} value={option}>{option}</option>)}
      </select>
    </label>
  );
}

/** Narrow screens show each row as a two-line card; `unit` is the word printed after a number there, so every value keeps a label. */
function SessionRow({ session }: { session: TelemetrySession }) {
  const cell = (label: string, content: ReactNode, className?: string, unit?: string) => <td data-label={label} data-unit={unit} className={className}>{content}</td>;
  return (
    <tr>
      {cell("last seen", <time dateTime={new Date(session.last_ns / 1e6).toISOString()} title={formatFullTime(session.last_ns)}>{formatTime(session.last_ns)}</time>, "tm-time")}
      {cell("profile", session.profile ?? <span className="tm-dim">no profile</span>, "tm-profile")}
      {cell("session", <span title={session.session_id} aria-label={`session ${session.session_id}`}>{shortId(session.session_id)}</span>, "tm-id")}
      {cell("model", session.model ?? <span className="tm-dim">not reported</span>, "tm-model")}
      {cell("duration", formatDuration(session.last_ns - session.first_ns), "tm-num tm-duration")}
      {cell("turns", formatCount(session.turn_count), "tm-num tm-turns", "turns")}
      {cell("model calls", formatCount(session.model_count), "tm-num tm-calls")}
      {cell("tool calls", formatCount(session.tool_count), "tm-num")}
      {cell("errors", session.error_count > 0 ? <span className="tm-danger">{formatCount(session.error_count)}</span> : <span className="tm-dim">0</span>, "tm-num tm-errors", "errors")}
      {cell("tokens in / out", <span title={`${formatCount(session.input_tokens)} in, ${formatCount(session.output_tokens)} out`}>{formatTokens(session.input_tokens)} / {formatTokens(session.output_tokens)}</span>, "tm-num tm-inout")}
      {cell("tokens", <span title={`${formatCount(session.total_tokens)} tokens`}>{formatTokens(session.total_tokens)}</span>, "tm-num tm-total", "tok")}
    </tr>
  );
}
