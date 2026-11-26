import { useEffect, useRef } from "react";

type Props = { pageId: string; credential: string; revision: number; onRuntimeError?: (message: string) => void };

export function acceptsBridgeMessage(event: MessageEvent, source: Window | null, pageId: string, revision: number) {
  const message = event.data;
  if (event.source !== source || event.origin !== "null" || !message || message.pageId !== pageId || message.revision !== revision) return false;
  return !!message.runtimeError || (typeof message.requestId === "string" && typeof message.collection === "string" && ["list", "insert"].includes(message.method));
}

export function PageFrame({ pageId, credential, revision, onRuntimeError }: Props) {
  const frame = useRef<HTMLIFrameElement>(null);
  useEffect(() => {
    const onMessage = async (event: MessageEvent) => {
      if (!acceptsBridgeMessage(event, frame.current?.contentWindow ?? null, pageId, revision)) return;
      const message = event.data;
      if (message.runtimeError) {
        void fetch(`/api/pages/${encodeURIComponent(pageId)}/runtime-error`, { method: "POST", headers: { authorization: `Bearer ${credential}`, "content-type": "application/json" }, body: JSON.stringify({ revision, error: String(message.runtimeError) }) });
        onRuntimeError?.(String(message.runtimeError));
        return;
      }
      try {
        const path = `/api/pages/${encodeURIComponent(pageId)}/records/${encodeURIComponent(message.collection)}`;
        const response = await fetch(path, { method: message.method === "insert" ? "POST" : "GET", headers: { authorization: `Bearer ${credential}`, "content-type": "application/json" }, body: message.method === "insert" ? JSON.stringify(message.document) : undefined });
        const result = await response.json();
        frame.current?.contentWindow?.postMessage({ requestId: message.requestId, ok: response.ok, result }, "*");
      } catch (error) { onRuntimeError?.(String(error)); }
    };
    addEventListener("message", onMessage);
    return () => removeEventListener("message", onMessage);
  }, [credential, pageId, revision, onRuntimeError]);
  return <iframe ref={frame} title="custom page" sandbox="allow-scripts allow-forms allow-downloads" src={`/api/pages/${encodeURIComponent(pageId)}/frame`} style={{ width: "100%", height: "100%", minHeight: "560px", border: 0 }} />;
}
