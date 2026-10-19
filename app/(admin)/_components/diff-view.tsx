import type { DiffLine } from "@/lib/domain/document-view";

const DIFF_STYLE = { same: "text-neutral-600", added: "bg-green-100", removed: "bg-red-100" } as const;
const DIFF_MARK = { same: " ", added: "+", removed: "-" } as const;

/** Line diff of two versions as preformatted text; each line is a block span (a `<pre>` holds phrasing content only). */
export function DiffView({ lines }: { lines: DiffLine[] }) {
  return (
    <pre className="overflow-x-auto rounded border border-neutral-300 p-2 text-xs whitespace-pre-wrap">
      {lines.map((line, i) => (
        <span key={i} className={`block ${DIFF_STYLE[line.kind]}`}>
          {DIFF_MARK[line.kind]} {line.text}
        </span>
      ))}
    </pre>
  );
}
