import { useEffect, useState } from "react";

export type PageTool = { name: string; operation: string; collection: string; input_schema: unknown; version: number };

// One owner for GET /api/pages/{id}/tools: FormBlock and EmptyChat both need the page's tool
// list, so they share this fetch instead of each running their own loader.
// tools is null while loading; error carries a fetch/HTTP failure for callers that want to show it.
export function usePageTools(pageId: string, credential: string, refreshKey: string): { tools: PageTool[] | null; error: string | null } {
  const [tools, setTools] = useState<PageTool[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setTools(null);
    setError(null);
    void fetch(`/api/pages/${pageId}/tools`, { headers: { Authorization: `Bearer ${credential}` }, cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error(`could not load tools (${response.status})`);
        const body = await response.json() as { tools?: PageTool[] };
        if (live) setTools(body.tools ?? []);
      })
      .catch((caught) => { if (live) setError(caught instanceof Error ? caught.message : String(caught)); });
    return () => { live = false; };
  }, [pageId, credential, refreshKey]);
  return { tools, error };
}
