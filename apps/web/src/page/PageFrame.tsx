import { useEffect, useRef } from "react";

type Props = { pageId: string; credential: string; revision: number; onRuntimeError?: (message: string) => void };

export function PageFrame({ pageId, credential, revision, onRuntimeError }: Props) {
  const frame = useRef<HTMLIFrameElement>(null);
  useEffect(() => {
    const onMessage = async (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow || (event.origin !== "null" && event.origin !== location.origin)) return;
      const message = event.data;
      if (message?.runtimeError) {
        void fetch(`/api/pages/${encodeURIComponent(pageId)}/runtime-error`, { method: "POST", headers: { authorization: `Bearer ${credential}`, "content-type": "application/json" }, body: JSON.stringify({ revision, error: String(message.runtimeError) }) });
        onRuntimeError?.(String(message.runtimeError));
        return;
      }
      if (!message || message.revision !== revision || typeof message.requestId !== "string") return;
      try {
        const path = `/api/pages/${encodeURIComponent(pageId)}/records/${encodeURIComponent(message.collection)}`;
        const response = await fetch(path, { method: message.method === "insert" ? "POST" : "GET", headers: { authorization: `Bearer ${credential}`, "content-type": "application/json" }, body: message.method === "insert" ? JSON.stringify(message.document) : undefined });
        const result = await response.json();
        frame.current?.contentWindow?.postMessage({ requestId: message.requestId, ok: response.ok, result }, location.origin);
      } catch (error) { onRuntimeError?.(String(error)); }
    };
    const onError = (event: ErrorEvent) => {
      void fetch(`/api/pages/${encodeURIComponent(pageId)}/runtime-error`, { method: "POST", headers: { authorization: `Bearer ${credential}`, "content-type": "application/json" }, body: JSON.stringify({ revision, error: event.message }) });
      onRuntimeError?.(event.message);
    };
    addEventListener("message", onMessage);
    addEventListener("error", onError);
    return () => { removeEventListener("message", onMessage); removeEventListener("error", onError); };
  }, [credential, pageId, revision, onRuntimeError]);
  return <iframe ref={frame} title="custom page" sandbox="allow-scripts allow-forms allow-downloads" src={`/api/pages/${encodeURIComponent(pageId)}/frame`} style={{ width: "100%", minHeight: "560px", border: 0 }} />;
}
