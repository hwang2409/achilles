import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import { GenericBody, ToolResultBlocks, useItem, type ToolBodyProps } from "@fulcrum/react";
import { ToolSummaryBody, toolArgumentSummary, toolErrorLine } from "./ToolSummary";

const OpenTools = createContext<Set<string> | null>(null);
const SessionCwd = createContext<string | null>(null);

// Rows may remount during virtual scrolling or replay; disclosure belongs to the open chat.
export function ToolDisclosure({ sessionId, cwd = null, children }: { sessionId: string; cwd?: string | null; children: ReactNode }) {
  const open = useMemo(() => new Set<string>(), [sessionId]);
  return <OpenTools.Provider value={open}><SessionCwd.Provider value={cwd}>{children}</SessionCwd.Provider></OpenTools.Provider>;
}

const withNotice = (text: string, notice: string) => `${text}${text && !text.endsWith("\n") ? "\n" : ""}${notice}`;
const humanBytes = (bytes: number) => bytes < 1024 ? `${bytes} bytes` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

// Match Fulcrum's sourceText (not exported by the pinned @fulcrum/react).
function readText(source: ToolBodyProps["output"]): string {
  const { omission, protocolTruncated } = source;
  let head = "", tail = "";
  for (const chunk of source.chunks()) {
    if (omission && chunk.start >= omission.end) tail += chunk.text;
    else head += chunk.text;
  }
  if (omission) {
    const bytes = humanBytes(omission.bytes);
    const notice = omission.whole && omission.reason === "run-cap"
      ? `output not kept (${bytes}) to save memory in this long run` : `${bytes} not kept`;
    const reset = head.includes("\u001b") ? "\u001b[0m" : "";
    head = withNotice(head, reset + notice) + (tail ? `\n${tail}` : "");
  }
  return protocolTruncated ? withNotice(head, "host did not provide the complete output") : head;
}

export function CompactTool({ id }: { id: string }) {
  const choices = useContext(OpenTools);
  const cwd = useContext(SessionCwd);
  const item = useItem(id);
  const [open, setOpen] = useState(() => choices?.has(id) ?? false);
  const [opened, setOpened] = useState(open);
  if (item?.type !== "tool") return null;
  const state = item.canceled ? "canceled" : item.is_error ? "error" : item.active ? "streaming" : "done";
  const approval = item.approval?.type === "approval_end" ? item.approval.decision : undefined;
  const status = approval === "deny" ? "denied" : state === "streaming" ? "running" : state === "error" ? "failed" : state;
  const name = item.tool_call.name.trim().slice(0, 260) || "unnamed tool";
  const summary = toolArgumentSummary(item, cwd);
  const duration = item.view?.durationMs;
  return <details className="compact-tool" open={open} data-part="tool" data-kind="tool" data-id={id} data-tool={name} data-tool-view={item.view?.kind} data-state={state}>
      <summary data-part="tool-header" onClick={(event) => {
        event.preventDefault();
        if (open) choices?.delete(id); else choices?.add(id);
        if (!open) setOpened(true);
        setOpen(!open);
      }}>
        <span data-part="tool-name" title={name}>{name}</span>
        <span data-part="tool-summary" title={summary}>{summary}</span>
        <span data-part="tool-status">
          {approval && <span data-part="tool-approval" data-decision={approval}>{approval === "deny" ? "denied" : approval === "approve" ? "approved" : "canceled"}</span>}
          {approval !== "deny" && !(approval === "abort" && status === "canceled") && status}
          {duration !== undefined && <span data-part="tool-duration">{duration < 1000 ? `${Math.round(duration)}ms` : `${(duration / 1000).toFixed(1)}s`}</span>}
        </span>
        {state === "error" && !open && <span className="compact-tool-error">{toolErrorLine(item.output)}</span>}
      </summary>
      {opened && <div data-part="tool-body">
          {item.output.omission && !item.output.omission.whole && <p data-part="tool-gap" data-cut="">{item.output.omission.bytes} bytes not kept from the middle of this output</p>}
          <ToolSummaryBody item={item} output={item.output} state={state} />
          {item.result?.finalContent && <section data-part="tool-final-result" aria-label="final result"><span data-part="block-label">final result</span><GenericBody item={item} output={item.result.finalContent} state={state} /></section>}
          {item.result?.blocks?.length ? <ToolResultBlocks id={id} blocks={item.result.blocks.map((block) => block.text ? { ...block.metadata, text: readText(block.text) } : block.metadata)} /> : null}
      </div>}
  </details>;
}
