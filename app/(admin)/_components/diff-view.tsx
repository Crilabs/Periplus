import type { DiffLine } from "@/lib/domain/document-view";

const DIFF_STYLE = {
  same: "text-muted",
  added: "bg-ok-soft text-ok",
  removed: "bg-danger-soft text-danger line-through decoration-danger/40",
} as const;
const DIFF_MARK = { same: " ", added: "+", removed: "-" } as const;

/** Line diff of two versions as preformatted text; each line is a block span (a `<pre>` holds phrasing content only). */
export function DiffView({ lines }: { lines: DiffLine[] }) {
  return (
    <pre className="overflow-x-auto rounded-lg border border-line bg-sunken/40 py-2 font-mono text-xs leading-relaxed whitespace-pre-wrap">
      {lines.map((line, i) => (
        <span key={i} className={`block px-3 ${DIFF_STYLE[line.kind]}`}>
          {DIFF_MARK[line.kind]} {line.text}
        </span>
      ))}
    </pre>
  );
}
