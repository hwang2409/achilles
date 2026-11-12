import type { RunEvent } from "@fulcrum/core";

type Run = { source_run_id: string; parent_run_id: string | null; messages: { sequence: number; id: string; role: string; content: { type: string; text: string }[] }[]; tool_calls: { sequence: number; id: string; name: string; arguments: Record<string, unknown>; result: { sequence: number; content: string; is_error: boolean } }[]; outcome: string };
type Bundle = { runs: Run[] };
export function runEvents(bundle: Bundle, runId: string): RunEvent[] {
  const run = bundle.runs.find(item => item.source_run_id === runId);
  if (!run) throw new Error(`unknown run ${runId}`);
  const events: RunEvent[] = [{ type: "run_start" }];
  const items = [...run.messages.map(message => ({ sequence: message.sequence, message })), ...run.tool_calls.map(tool => ({ sequence: tool.sequence, tool }))].sort((a, b) => a.sequence - b.sequence);
  for (const item of items) {
    if ("message" in item) events.push({ type: "message_commit", message_id: item.message.id, message: { role: item.message.role, content: item.message.content } } as RunEvent);
    else events.push({ type: "tool_start", tool_call: { id: item.tool.id, name: item.tool.name, arguments: item.tool.arguments } } as RunEvent, { type: "tool_end", tool_call: { id: item.tool.id, name: item.tool.name, arguments: item.tool.arguments }, tool_result: { content: item.tool.result.content, is_error: item.tool.result.is_error } } as RunEvent);
  }
  const child = bundle.runs.find(item => item.parent_run_id === runId);
  if (child) events.push({ type: "sub_agent", childRunId: child.source_run_id, status: "done", task: "inspect build", summary: "build failed in fixture" } as RunEvent);
  events.push({ type: "run_end", outcome: run.outcome === "failed" ? "failed" : "completed" });
  return events;
}
