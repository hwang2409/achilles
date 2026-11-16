import { useState } from "react";
import { isLargeCode } from "@fulcrum/react/code";
import type { FenceProps } from "@fulcrum/markdown/react";

export function CodeFence({ code, language, source }: FenceProps) {
  const [copied, setCopied] = useState(false);

  // Fulcrum's large viewer already owns its head and copy action; keep its zero-padding layout intact.
  if (isLargeCode(code)) return source;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      // Clipboard access can be unavailable in an insecure context. Keep the code usable.
    }
  };

  return <div data-part="code-fence">
    <div data-part="code-fence-head">
      <span>{language}</span>
      <button type="button" aria-label="copy code" onClick={() => void copy()}>{copied ? "copied" : "copy"}</button>
    </div>
    {source}
  </div>;
}
