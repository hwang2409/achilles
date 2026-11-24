import { Fragment, useMemo, type ReactNode } from "react";
import { parseMarkdown, type Block, type Inline } from "@fulcrum/markdown";

// Resource text is untrusted: render readable markup without fetching embedded URLs.
function inline(nodes: Inline[]): ReactNode {
  return nodes.map((node, i) => <Fragment key={i}>{(() => {
    switch (node.type) {
      case "text": case "pending-reference": return node.value;
      case "break": return <br />;
      case "code": return <code>{node.value}</code>;
      case "strong": return <strong>{inline(node.children)}</strong>;
      case "emphasis": return <em>{inline(node.children)}</em>;
      case "strike": return <del>{inline(node.children)}</del>;
      case "link": return inline(node.children);
      case "image": return node.alt;
    }
  })()}</Fragment>);
}

function blocks(nodes: Block[]): ReactNode {
  return nodes.map((node, i) => <Fragment key={i}>{(() => {
    switch (node.type) {
      case "paragraph": return <p>{inline(node.children)}</p>;
      case "heading": {
        const Heading = (["h3", "h4", "h5", "h6"] as const)[Math.min(3, Math.max(0, node.level - 1))];
        return <Heading>{inline(node.children)}</Heading>;
      }
      case "code": return <pre><code>{node.value}</code></pre>;
      case "blockquote": return <blockquote>{blocks(node.children)}</blockquote>;
      case "rule": return <hr />;
      case "list": {
        const Tag = node.ordered ? "ol" : "ul";
        return <Tag start={node.ordered ? node.start : undefined}>{node.items.map((item, j) => <li key={j}>{item.checked !== undefined && (item.checked ? "Done: " : "To do: ")}{blocks(item.children)}</li>)}</Tag>;
      }
      case "table": return <table><thead><tr>{node.header.map((cell, j) => <th key={j}>{inline(cell)}</th>)}</tr></thead><tbody>{node.rows.map((row, j) => <tr key={j}>{row.map((cell, k) => <td key={k}>{inline(cell)}</td>)}</tr>)}</tbody></table>;
    }
  })()}</Fragment>);
}

export function ReadingMarkdown({ source }: { source: string }) {
  const body = useMemo(() => blocks(parseMarkdown(source)), [source]);
  return <div className="ui-reading-markdown">{body}</div>;
}

export function ReadingPanel({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return <aside className="ui-reading-panel" aria-label={title} onKeyDown={(event) => {
    if (event.key === "Escape") { event.stopPropagation(); onClose(); }
  }}>
    <header><div><h2>{title}</h2><small>Untrusted text. Not sent to a model.</small></div><button type="button" className="ui-button" onClick={onClose}>Close</button></header>
    <div className="ui-reading-body">{children}</div>
  </aside>;
}
