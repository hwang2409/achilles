import { useEffect, useRef, useState } from "react";

type Props = { pageId: string; credential: string; revision: number };

export function acceptsBridgeMessage(event: MessageEvent, source: Window | null, pageId: string, revision: number) {
  const message = event.data;
  if (event.source !== source || event.origin !== "null" || !message || message.pageId !== pageId || message.revision !== revision) return false;
  return !!message.runtimeError || (typeof message.requestId === "string" && typeof message.collection === "string" && ["list", "insert"].includes(message.method));
}

// a new revision remounts the frame: the open document runs the old code and only sends old-revision messages
export const PageFrame = (props: Props) => <Frame key={props.revision} {...props} />;

function Frame({ pageId, credential, revision }: Props) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const onMessage = async (event: MessageEvent) => {
      if (!acceptsBridgeMessage(event, frame.current?.contentWindow ?? null, pageId, revision)) return;
      const message = event.data;
      if (message.runtimeError) {
        void fetch(`/api/pages/${encodeURIComponent(pageId)}/runtime-error`, { method: "POST", headers: { authorization: `Bearer ${credential}`, "content-type": "application/json" }, body: JSON.stringify({ revision, error: String(message.runtimeError) }) });
        setError(String(message.runtimeError));
        return;
      }
      try {
        const path = `/api/pages/${encodeURIComponent(pageId)}/records/${encodeURIComponent(message.collection)}`;
        const response = await fetch(path, { method: message.method === "insert" ? "POST" : "GET", headers: { authorization: `Bearer ${credential}`, "content-type": "application/json" }, body: message.method === "insert" ? JSON.stringify(message.document) : undefined });
        const result = await response.json();
        frame.current?.contentWindow?.postMessage({ requestId: message.requestId, ok: response.ok, result }, "*");
      } catch (caught) { setError(String(caught)); }
    };
    addEventListener("message", onMessage);
    return () => removeEventListener("message", onMessage);
  }, [credential, pageId, revision]);
  return <div className="page-frame">
    {error && <p className="page-error" role="alert" title={error}>this page hit an error: {error}</p>}
    <iframe ref={frame} title="custom page" sandbox="allow-scripts allow-forms allow-downloads" src={`/api/pages/${encodeURIComponent(pageId)}/frame`} />
  </div>;
}
