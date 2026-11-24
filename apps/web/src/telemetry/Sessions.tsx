import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
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
    <div className="min-w-0">
      <div className="mb-4 grid gap-1 [&_h1]:text-xl [&_h1]:font-semibold">
        <h1>{count && <span className="sm:hidden">{count}</span>}<span className="hidden sm:inline">sessions</span>{!count && <span className="sm:hidden">sessions</span>}</h1>
        <p className="text-muted-foreground">
          {count ? <span className="hidden sm:inline"><b>{count}</b> in the </span> : <span className="hidden sm:inline">matching sessions in the </span>}
          {rangeLabel}
          <span className="sm:hidden"> · last seen, newest first</span><span className="hidden sm:inline"> · newest first</span>
        </p>
      </div>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Choice label="profile" value={query.profile} options={profiles} set={(profile) => setFilters({ profile })} />
        <Choice label="model" value={query.model} options={models} set={(model) => setFilters({ model })} />
        <label className="inline-flex min-h-10 items-center gap-2 text-sm">
          <input type="checkbox" checked={query.errorsOnly} onChange={(event) => setFilters({ errorsOnly: event.target.checked })} />
          <span><span className="hidden sm:inline">with </span>errors only</span>
        </label>
        {isFiltered(query) && <Button variant="outline" type="button" onClick={() => setFilters({ errorsOnly: false, profile: null, model: null })}>clear filters</Button>}
      </div>
      {page.items.length === 0
        ? <p className="border-y py-4 text-muted-foreground">no sessions match these filters.</p>
        : <Table className="tabular-nums">
            <TableCaption className="sr-only">sessions, newest activity first</TableCaption>
            <TableHeader>
              <TableRow>{["last seen", "profile", "session", "model", ...NUMERIC].map((label) => <TableHead key={label} scope="col" className={NUMERIC.includes(label) ? "tabular-nums" : undefined} aria-sort={label === "last seen" ? "descending" : undefined}>{label}{label === "last seen" && <span aria-hidden="true"> ↓</span>}</TableHead>)}</TableRow>
            </TableHeader>
            <TableBody>{page.items.map((session) => <SessionRow key={session.session_id} session={session} open={open} />)}</TableBody>
          </Table>}
      {page.items.length > 0 && <footer className="mt-4 flex flex-wrap items-center justify-between gap-3 text-sm text-muted-foreground">
        <p>these {formatCount(page.items.length)} used <b className="tabular-nums">{formatTokens(sum("total_tokens"))}</b> tokens · in <b className="tabular-nums">{formatTokens(sum("input_tokens"))}</b> · out <b className="tabular-nums">{formatTokens(sum("output_tokens"))}</b></p>
        <div className="flex flex-wrap items-center gap-2">
          <span className="tabular-nums text-muted-foreground">{from}–{to}{count && ` of ${formatCount(total)}`}</span>
          <Button variant="outline" type="button" disabled={!previous} onClick={previous} aria-label="newer sessions">‹ newer</Button>
          <Button variant="outline" type="button" disabled={!next} onClick={next} aria-label="older sessions">older ›</Button>
        </div>
      </footer>}
    </div>
  );
}

/** Options follow EnumListbox's convention: real values are JSON-encoded, so a profile named "any" never reads as no filter. */
function Choice({ label, value, options, set }: { label: string; value: string | null; options: string[]; set: (value: string | null) => void }) {
  const choices = value !== null && !options.includes(value) ? [value, ...options] : options;
  return (
    <div className="min-w-0">
      <EnumListbox label={label} value={value === null ? ANY : JSON.stringify(value)} options={[ANY, ...choices.map((option) => JSON.stringify(option))]} onChange={(next) => set(next === ANY ? null : JSON.parse(next))} />
    </div>
  );
}

/**
 * One row is one link target: the profile link stretches over the row and opens the session's route. The table can scroll horizontally on narrow screens.
 */
function SessionRow({ session, open }: { session: TelemetrySession; open: (event: MouseEvent<HTMLAnchorElement>, href: string) => void }) {
  const href = `/telemetry/sessions/${encodeURIComponent(session.session_id)}`;
  const cell = (label: string, content: ReactNode, className?: string, unit?: string) => <TableCell data-label={label} data-unit={unit} className={className}>{content}</TableCell>;
  return (
    <TableRow className="relative">
      {cell("last seen", <time dateTime={new Date(session.last_ns / 1e6).toISOString()} title={formatFullTime(session.last_ns)}>{formatTime(session.last_ns)}</time>, "tabular-nums")}
      {cell("profile", <a className="text-accent-foreground underline-offset-4 after:absolute after:inset-0 hover:underline" href={href} onClick={(event) => open(event, href)} aria-label={`session ${session.session_id}, ${session.profile ?? "no profile"}`}>{session.profile ?? <span className="text-muted-foreground">no profile</span>}</a>, "tabular-nums")}
      {cell("session", <span title={session.session_id}>{shortId(session.session_id)}</span>, "tabular-nums")}
      {cell("model", session.model ?? <span className="text-muted-foreground">not reported</span>, "text-muted-foreground")}
      {cell("duration", formatDuration(session.last_ns - session.first_ns), "tabular-nums")}
      {cell("turns", formatCount(session.turn_count), "tabular-nums", session.turn_count === 1 ? "turn" : "turns")}
      {cell("model calls", formatCount(session.model_count), "tabular-nums", "model")}
      {cell("tool calls", formatCount(session.tool_count), "tabular-nums", "tool")}
      {cell("errors", session.error_count > 0 ? <span className="text-destructive"><span aria-hidden="true" className="sm:hidden">▲ </span>{formatCount(session.error_count)}</span> : <span className="text-muted-foreground">0</span>, "tabular-nums", session.error_count === 1 ? "error" : "errors")}
      {cell("tokens in / out", <span title={`${formatCount(session.input_tokens)} in, ${formatCount(session.output_tokens)} out`}>{formatTokens(session.input_tokens)} / {formatTokens(session.output_tokens)}</span>, "tabular-nums", "tok")}
    </TableRow>
  );
}
