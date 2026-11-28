import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ZetaClient } from "@fulcrum/zeta";
import { useNow } from "../agents/AgentRunDetail";
import { displayControl, duration } from "../agents/childControls";
import { wrapTab } from "../keyboard";
import { onRunEnd, onTaskUpdate } from "../zeta/turnEnd";
import "../settings-dialog.css";
import "./background-tasks.css";

export const RUN_WORK_FEATURE = "run_work";

// one row of zeta's run_work_list (zeta f5efa62d tools/_shared/run_work.py background_task_row). `at` is this page's
// monotonic time of the read, so a live row counts on from zeta's elapsed_seconds
type Task = { id: string; command: string; status: string; elapsed: number; cancelable: boolean; exitCode?: number; at: number };
const live = (task: Task) => task.status === "starting" || task.status === "running" || task.status === "stopping";
// zeta's "killed" is a task_kill or a session shutdown; the user asked for it, so it reads as canceled
const words: Record<string, string> = { killed: "canceled", exited: "done" };
const word = (task: Task) => task.status === "failed" && task.exitCode !== undefined ? `failed · exit ${task.exitCode}` : words[task.status] ?? task.status;

function taskRow(value: unknown, at: number): Task | undefined {
  if (!value || typeof value !== "object") return;
  const v = value as Record<string, unknown>;
  if (typeof v.id !== "string" || !v.id || typeof v.status !== "string" || typeof v.command !== "string" || typeof v.elapsed_seconds !== "number") return;
  return { id: v.id, command: v.command, status: v.status, elapsed: Math.max(0, v.elapsed_seconds), cancelable: v.cancelable === true,
    ...(Number.isInteger(v.exit_code) ? { exitCode: v.exit_code as number } : {}), at };
}

/**
 * This chat's background tasks while `sessionId` is attached to this tab's controller: zeta answers run_work_list and
 * background_task_cancel only for the caller's own active session, never for an observer. null: no list (an older
 * zeta, an observer, another tab holds the chat, or the read failed). Each background_task_updated event rereads it, and
 * the end of a turn rereads it after a failed read, so one timeout does not hide the chip while a task runs.
 */
export function useBackgroundTasks(client: ZetaClient | null, sessionId: string | undefined, enabled: boolean) {
  const [tasks, setTasks] = useState<Task[] | null>(null);
  useEffect(() => {
    setTasks(null);
    if (!client || !sessionId || !enabled) return;
    let current = new AbortController();
    let failed = false;
    const read = () => {
      current.abort();
      const { signal } = current = new AbortController();
      client.request("run_work_list", { session_id: sessionId }, { signal, timeoutMs: 5000 }).then((result) => {
        if (signal.aborted) return;
        failed = false;
        const rows = (result as { tasks?: unknown } | null)?.tasks;
        const at = performance.now();
        setTasks(Array.isArray(rows) ? rows.flatMap((row) => taskRow(row, at) ?? []) : null);
      }, () => { if (!signal.aborted) { failed = true; setTasks(null); } });
    };
    read();
    const stop = onTaskUpdate(client, (id) => { if (id === sessionId) read(); });
    const stopEnd = onRunEnd(client, (id) => { if (id === sessionId && failed) read(); });
    return () => { stop(); stopEnd(); current.abort(); };
  }, [client, sessionId, enabled]);
  const replace = (row: Task) => setTasks((rows) => rows && rows.map((one) => one.id === row.id ? row : one));
  return { tasks, running: tasks?.filter(live).length ?? 0, replace };
}

export function BackgroundTasks({ client, sessionId, list, opener, onClose }: {
  client: ZetaClient | null; sessionId: string; list: ReturnType<typeof useBackgroundTasks>; opener: HTMLElement | null; onClose(): void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState("");
  const tasks = list.tasks ?? [];
  const mono = useNow(tasks.some(live)).mono;
  useLayoutEffect(() => {
    const node = dialog.current;
    node?.showModal();
    // the chip that opened the list goes away when nothing runs; focus then returns to the header's first action
    return () => { node?.close(); (opener?.isConnected ? opener : document.querySelector<HTMLElement>(".chat-header .chat-actions > button"))?.focus(); };
  }, []);
  const cancel = async (task: Task) => {
    if (!client || pending) return;
    setPending(task.id);
    setError("");
    try {
      const result = await client.request("background_task_cancel", { session_id: sessionId, task_id: task.id }, { timeoutMs: 10000 });
      const row = taskRow((result as { task?: unknown } | null)?.task, performance.now());
      if (row) list.replace(row);
    } catch (failure) {
      setError(`could not cancel: ${(failure as Error)?.message || "zeta did not answer"}`);
    } finally { setPending(null); }
    // a canceled row loses its cancel button; keep focus in the list instead of on the page body
    requestAnimationFrame(() => { if (!dialog.current?.contains(document.activeElement)) heading.current?.focus(); });
  };
  return <dialog ref={dialog} className="settings-dialog chat-tasks" aria-labelledby="chat-tasks-title"
    onCancel={(event) => { event.preventDefault(); onClose(); }}
    onClick={(event) => { if (event.target === dialog.current) onClose(); }}
    onKeyDown={(event) => wrapTab(event, event.currentTarget)}>
    <div className="settings-panel">
      <div className="settings-titlebar"><div><span className="settings-mark" /><h2 id="chat-tasks-title" ref={heading} tabIndex={-1}>background tasks in this chat</h2></div>
        <div><button type="button" onClick={onClose}>close</button></div></div>
      <div className="settings-content">
        {error && <p role="alert">{error}</p>}
        {tasks.length ? <ul className="chat-tasks-rows">{tasks.map((task) => {
          const command = displayControl(task.command, 200);
          const seconds = live(task) ? task.elapsed + Math.max(0, mono - task.at) / 1000 : task.elapsed;
          return <li key={task.id} data-status={task.status}>
            <code title={task.command}>{command}</code>
            <span className="chat-tasks-meta"><span className="chat-tasks-state">{word(task)}</span> · <span>{duration(seconds)}</span></span>
            {task.cancelable && <button type="button" aria-label={`cancel ${command}`} aria-disabled={!!pending || undefined}
              onClick={() => void cancel(task)}>{pending === task.id ? "canceling…" : "cancel"}</button>}
          </li>;
        })}</ul> : <p>no background tasks in this chat.</p>}
      </div>
    </div>
  </dialog>;
}
