import type { ComponentType } from "react";
import { useItem } from "@fulcrum/react";
import { stamp } from "../agents/AgentRunDetail";
import { displayControl } from "../agents/childControls";

const kinds = new Set(["child_suspended", "child_recovered"]);
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
type Notice = { kind: string; text: string; next?: number };

/** zeta's notice for a child it paused or resumed. Reads only the description and the planned retry time; the child's
 * session path and provider code never show. */
function notice(kind: unknown, data: unknown): Notice | undefined {
  if (typeof kind !== "string" || !kinds.has(kind) || !object(data)) return;
  const who = displayControl(typeof data.description === "string" && data.description.trim() ? data.description : "agent", 200);
  if (kind === "child_recovered") return { kind, text: `${who} resumed` };
  const next = typeof data.next_retry_at === "string" && Number.isFinite(Date.parse(data.next_retry_at)) ? Date.parse(data.next_retry_at) : undefined;
  return { kind, text: `${who} paused · provider unavailable · `, next };
}

// live, fulcrum does not map these events yet and gives an unknown item; in history they are notification rows
function useNotice(id: string) {
  const item = useItem(id);
  if (item?.type === "unknown" && item.event.type === "unknown") return notice(item.event.name, item.event.data?.data);
  if (item?.type === "notification" && item.event.type === "notification") return notice(item.event.data?.kind, item.event.data);
}

/** A row renderer that shows a child recovery notice as one line, and any other item with `Other`. */
export function withChildRecovery(Other: ComponentType<{ id: string }>) {
  return function ChildRecoveryRow({ id }: { id: string }) {
    const shown = useNotice(id);
    // the time is what zeta planned when it wrote the notice; the agents view shows the current plan
    return shown ? <p className="chat-continuation" data-part="child-recovery" data-kind={shown.kind}>{shown.text}
      {shown.kind === "child_suspended" && (shown.next === undefined ? "stopped retrying"
        : <>retries at <time dateTime={new Date(shown.next).toISOString()}>{stamp(shown.next)}</time></>)}</p> : <Other id={id} />;
  };
}
