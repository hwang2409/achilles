import { createContext, useContext, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

// The shell's build status strip and receipt; each route frame renders it once, under its own bar.
export const ShellDock = createContext<ReactNode>(null);
export const ShellDockSlot = () => <>{useContext(ShellDock)}</>;

export function ModuleFrame({ title, subtitle, actions, children }: { title: string; subtitle?: string; actions?: ReactNode; children: ReactNode }) {
  return <section data-module-frame className="module-frame flex min-h-0 flex-1 flex-col">
    <header className="flex min-h-16 shrink-0 items-center justify-between gap-2 border-b px-6 py-2 [@media(max-width:760px),(max-height:500px)]:min-h-14 [@media(max-width:760px),(max-height:500px)]:pl-16"><div><h1 className="text-lg font-semibold first-letter:uppercase" title={title}>{title}</h1>{subtitle && <p className="text-sm text-muted-foreground">{subtitle}</p>}</div>{actions}</header>
    <ShellDockSlot />
    <div className="module-body min-h-0 flex-1 overflow-auto [scrollbar-width:thin]">{children}</div>
  </section>;
}

type StateProps = {
  kind: "empty" | "loading" | "failed" | "unsupported" | "offline";
  title: string;
  detail?: string;
  action?: { label: string; run: () => void };
};

export function ModuleState({ kind, title, detail, action }: StateProps) {
  return <div className="module-state mx-auto max-w-5xl px-4 py-6 sm:px-6" data-state={kind}>
    <div className="module-state-copy" role={kind === "failed" || kind === "offline" ? "alert" : "status"}>
      <h2 className="text-base font-semibold first-letter:uppercase">{title}</h2>
      {detail && <p className="mt-2 max-w-[55ch] break-words text-muted-foreground">{detail}</p>}
    </div>
    {kind === "loading" && <div className="mt-4 grid gap-3" aria-hidden="true"><Skeleton className="h-2.5 w-[min(48ch,100%)]" /><Skeleton className="h-2.5 w-[min(36ch,75%)]" /><Skeleton className="h-2.5 w-[min(24ch,55%)]" /></div>}
    {action && <Button type="button" variant="outline" className="mt-4 min-h-11" onClick={action.run}>{action.label}</Button>}
  </div>;
}
