import { useEffect, useState } from "react";

type ComposerState = "idle" | "running" | "steerable" | "read-only";
type VimMode = "insert" | "normal" | "visual";

const SEGMENT_WIDTH = 9;
const SEPARATOR_WIDTH = 12;

export function composerHintSegments({ state, mode = "plain", queues = false, focused = true, questionWaiting = false }: {
  state: ComposerState;
  mode?: VimMode | "plain";
  queues?: boolean;
  focused?: boolean;
  questionWaiting?: boolean;
}) {
  if (questionWaiting) return ["enter answer"];
  if (state === "running") return ["stop or wait to send"];
  const action = queues ? "queue" : state === "steerable" ? "steer" : "send";
  if (mode === "plain") return [
    `enter ${action}`,
    ...(queues ? ["esc cancels last"] : ["shift+enter new line"]),
  ];
  if (mode === "insert") return [`enter ${action}`, "shift+enter new line", "esc normal"];
  if (mode === "visual") return [`enter ${action}`, "d delete", "y yank", "c change", "esc normal"];
  return [`enter ${action}`, focused ? "i insert" : "i focus", "j/k scroll chat", "? shortcuts"];
}

export function fitHintSegments(segments: string[], width: number) {
  if (width <= 0) return [];
  const kept: string[] = [];
  let used = 0;
  for (const segment of segments) {
    const needed = segment.length * SEGMENT_WIDTH + (kept.length ? SEPARATOR_WIDTH : 0);
    if (kept.length && used + needed > width) break;
    if (!kept.length && needed > width) return [segment];
    kept.push(segment);
    used += needed;
  }
  return kept;
}

export function ComposerHint(props: {
  state: ComposerState;
  mode?: VimMode | "plain";
  queues?: boolean;
  focused?: boolean;
  questionWaiting?: boolean;
  override?: string;
  id: string;
  hidden?: boolean;
}) {
  const segments = props.override ? [props.override] : composerHintSegments(props);
  const [width, setWidth] = useState(Number.POSITIVE_INFINITY);
  useEffect(() => {
    const element = document.getElementById(props.id)?.parentElement;
    if (!element || typeof ResizeObserver === "undefined") return;
    const update = () => setWidth(element.clientWidth);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, [props.id]);
  const visible = props.override ? segments : fitHintSegments(segments, width);
  return <span data-part="composer-hint" id={props.id} hidden={props.hidden}>
    {visible.map((segment, index) => <span key={segment} data-hint-segment={index}>{index > 0 && " · "}{segment}</span>)}
  </span>;
}
