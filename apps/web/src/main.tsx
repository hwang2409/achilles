import { createRoot } from "react-dom/client";
import { useEffect, useMemo, useState } from "react";
import { createRunStore } from "@fulcrum/core";
import { RunProvider, SubAgentNavigationProvider, Timeline } from "@fulcrum/react";
import "@fulcrum/react/styles.css";
import "@fulcrum/react/themes.css";
import { runEvents } from "./trace-adapter";
import "./style.css";

type Run = { source_run_id: string; parent_run_id: string | null; messages: { sequence: number; id: string; role: string; content: { type: string; text: string }[] }[]; tool_calls: { sequence: number; id: string; name: string; arguments: Record<string, unknown>; result: { sequence: number; content: string; is_error: boolean } }[]; outcome: string };
type Verdict = { id: string; label: string; run_id: string; product: string; judge_id: string; judge_version: number; urgent: boolean; delivery_outcome: string; trace?: { runs: Run[] } };
function Trace({ detail }: { detail: Verdict }) {
  const [selected, setSelected] = useState(detail.trace!.runs[0].source_run_id);
  const run = detail.trace!.runs.find(item => item.source_run_id === selected)!;
  const store = useMemo(() => { const value = createRunStore(); value.resync(runEvents(detail.trace!, selected)); return value; }, [detail, selected]);
  useEffect(() => () => store.dispose(), [store]);
  const children = detail.trace!.runs.filter(item => item.parent_run_id === run.source_run_id);
  return <SubAgentNavigationProvider value={{ open: setSelected, unavailable: id => detail.trace!.runs.some(item => item.source_run_id === id) ? undefined : "run unavailable" }}><p>run: {run.source_run_id}</p>{children.map(child => <button key={child.source_run_id} onClick={() => setSelected(child.source_run_id)}>{child.source_run_id}</button>)}<RunProvider store={store}><Timeline aria-label="trace timeline" /></RunProvider></SubAgentNavigationProvider>;
}
function App() { const [list, setList] = useState<Verdict[]>([]); const [detail, setDetail] = useState<Verdict | null>(null); useEffect(() => { fetch("/api/verdicts").then(r => r.json()).then(setList); }, []); const open = (v: Verdict) => { history.pushState({}, "", `/verdicts/${v.id}`); fetch(`/api/verdicts/${v.id}`).then(r => r.json()).then(setDetail); }; useEffect(() => { const id = location.pathname.split("/").pop(); if (id && id !== "verdicts") fetch(`/api/verdicts/${id}`).then(r => r.json()).then(setDetail); }, []); return <main><h1>achilles verdicts</h1>{!detail ? list.map(v => <button className="verdict" key={v.id} onClick={() => open(v)}>{v.label} — {v.id}</button>) : <><h2>{detail.label}</h2><section aria-label="verdict details"><p>verdict id: {detail.id}</p><p>label: {detail.label}</p><p>judge: {detail.judge_id} v{detail.judge_version}</p><p>urgent: {detail.urgent ? "yes" : "no"}</p><p>delivery: {detail.delivery_outcome}</p></section><Trace detail={detail} /></>}</main>; }
createRoot(document.getElementById("root")!).render(<App />);
