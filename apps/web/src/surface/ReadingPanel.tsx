import { Button } from "@/components/ui/button";
import { Sheet, SheetClose, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Fragment, useMemo, type ReactNode, type RefObject } from "react";
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
  return <div data-reading-markdown className="max-w-[72ch] space-y-3 wrap-anywhere [&_blockquote]:border-s-2 [&_blockquote]:ps-3 [&_ol]:list-decimal [&_ol]:ps-6 [&_ul]:list-disc [&_ul]:ps-6 [&_pre]:overflow-auto [&_pre]:bg-muted [&_pre]:p-3 [&_th]:border-b [&_td]:border-b [&_th]:p-2 [&_td]:p-2 [&_th]:text-start [&_h3]:font-semibold [&_h4]:font-semibold [&_h5]:font-semibold [&_h6]:font-semibold">{body}</div>;
}

export function ReadingPanel({ title, opener, onClose, children }: { title: string; opener: RefObject<HTMLButtonElement | null>; onClose: () => void; children: ReactNode }) {
  return <Sheet open onOpenChange={(open) => { if (!open) onClose(); }}>
    <SheetContent showCloseButton={false} className="w-full gap-0 sm:max-w-xl" onCloseAutoFocus={(event) => {
      event.preventDefault();
      opener.current?.focus();
    }}>
      <SheetHeader className="flex-row items-start justify-between gap-3 border-b">
        <div className="grid min-w-0 gap-1 wrap-anywhere"><SheetTitle>{title}</SheetTitle><SheetDescription>Untrusted text. Not sent to a model.</SheetDescription></div>
        <SheetClose asChild><Button variant="outline" type="button">Close</Button></SheetClose>
      </SheetHeader>
      <div className="grid min-h-0 flex-1 content-start gap-4 overflow-auto p-4 md:p-6">{children}</div>
    </SheetContent>
  </Sheet>;
}
