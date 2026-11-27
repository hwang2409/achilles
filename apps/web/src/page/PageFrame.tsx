import { useEffect, useRef, useState } from "react";

type Props = { pageId: string; credential: string; revision: number };

export function acceptsBridgeMessage(event: MessageEvent, source: Window | null, pageId: string, revision: number) {
  const message = event.data;
  if (event.source !== source || event.origin !== "null" || !message || message.pageId !== pageId || message.revision !== revision) return false;
  if (message.runtimeError) return true;
  if (typeof message.requestId !== "string" || typeof message.collection !== "string") return false;
  return ["list", "insert"].includes(message.method) || (["update", "delete"].includes(message.method) && typeof message.id === "string");
}

const BRIDGE_HTTP: Record<string, string> = { list: "GET", insert: "POST", update: "PATCH", delete: "DELETE" };

// a new page or revision remounts the frame: the open document runs the old code and only sends old-revision messages,
// and an error line or in-flight reply must not carry over to another page
export const PageFrame = (props: Props) => <Frame key={`${props.pageId}:${props.revision}`} {...props} />;

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
      // every call gets a reply, so the page's promise always settles; a failure rejects with {detail}
      const reply = (ok: boolean, result: unknown) => frame.current?.contentWindow?.postMessage({ requestId: message.requestId, ok, result }, "*");
      try {
        const record = message.method === "update" || message.method === "delete" ? `/${encodeURIComponent(message.id)}` : "";
        const path = `/api/pages/${encodeURIComponent(pageId)}/records/${encodeURIComponent(message.collection)}${record}`;
        const method = BRIDGE_HTTP[message.method];
        const response = await fetch(path, { method, headers: { authorization: `Bearer ${credential}`, "content-type": "application/json" }, body: method === "POST" || method === "PATCH" ? JSON.stringify(message.document) : undefined });
        reply(response.ok, response.ok ? await response.json() : { detail: await response.text() });
      } catch (caught) { reply(false, { detail: String(caught) }); }
    };
    addEventListener("message", onMessage);
    return () => removeEventListener("message", onMessage);
  }, [credential, pageId, revision]);
  return <div className="page-frame">
    {error && <p className="page-error" role="alert" title={error}>this page hit an error: {error}</p>}
    <iframe ref={frame} title="custom page" sandbox="allow-scripts allow-forms allow-downloads allow-modals" src={`/api/pages/${encodeURIComponent(pageId)}/frame`} />
  </div>;
}
