import { CopyButton } from "@fulcrum/react/code";
import type { FenceProps } from "@fulcrum/markdown/react";

export function CodeFence({ code, language, source }: FenceProps) {
  return <div data-part="code-fence">
    <div data-part="code-fence-head">
      <span>{language}</span>
      <CopyButton value={code} label="code" />
    </div>
    {source}
  </div>;
}
