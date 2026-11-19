import type { ReactNode } from "react";
import "./surface.css";

export function ModuleFrame({ title, children }: { title: string; children: ReactNode }) {
  return <section className="module-frame">
    <header><h1>{title}</h1></header>
    <div className="module-body">{children}</div>
  </section>;
}

type StateProps = {
  kind: "empty" | "loading" | "failed" | "unsupported" | "offline";
  title: string;
  detail?: string;
  action?: { label: string; run: () => void };
};

export function ModuleState({ kind, title, detail, action }: StateProps) {
  return <div className="module-state" data-state={kind}>
    <div className="module-state-copy" role={kind === "failed" || kind === "offline" ? "alert" : "status"}>
      <h2>{title}</h2>
      {detail && <p>{detail}</p>}
    </div>
    {kind === "loading" && <div className="module-skeleton" aria-hidden="true"><i /><i /><i /></div>}
    {action && <button type="button" className="primary" onClick={action.run}>{action.label}</button>}
  </div>;
}
