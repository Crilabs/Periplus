import { segmentText, type Span } from "@/lib/domain/extraction/quote";

/**
 * Text with highlighted spans (mentions, quotes, quotes of facts outside the active run): every segment covered by a
 * span is a `<mark data-kind="…">` (the kinds of all covering spans, space-separated). The text is rendered as React children only, never as HTML, so markup
 * in a source text stays text.
 */
export function AnnotatedText({ text, spans, className }: { text: string; spans: Span[]; className?: string }) {
  return (
    <span
      className={`whitespace-pre-wrap [&_mark]:rounded-sm [&_mark]:px-0.5 [&_mark]:text-ink [&_mark[data-kind~=mention]]:bg-warn-soft [&_mark[data-kind~=mention]]:shadow-[inset_0_-2px_0_var(--warn)] [&_mark[data-kind~=quote]]:bg-accent-soft [&_mark[data-kind~=quote]]:shadow-[inset_0_-2px_0_var(--accent)] [&_mark[data-kind~=inactive-quote]]:bg-sunken [&_mark[data-kind~=inactive-quote]]:border [&_mark[data-kind~=inactive-quote]]:border-dashed [&_mark[data-kind~=inactive-quote]]:border-line-strong [&_mark[data-kind~=inactive-quote]]:text-muted ${className ?? ""}`}
    >
      {segmentText(text, spans).map((segment, i) =>
        segment.kinds.length === 0 ? (
          segment.text
        ) : (
          <mark key={i} data-kind={segment.kinds.join(" ")}>
            {segment.text}
          </mark>
        ),
      )}
    </span>
  );
}

/** The legend of `AnnotatedText`'s highlights. */
export function AnnotationLegend() {
  return (
    <p className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
      <span>
        <mark className="rounded-sm bg-warn-soft px-0.5 text-ink shadow-[inset_0_-2px_0_var(--warn)]">Erwähnung</mark> eines Geo-Objekts
      </span>
      <span>
        <mark className="rounded-sm bg-accent-soft px-0.5 text-ink shadow-[inset_0_-2px_0_var(--accent)]">Zitat</mark> eines Facts
      </span>
      <span>
        <mark className="rounded-sm border border-dashed border-line-strong bg-sunken px-0.5 text-muted">Zitat</mark> eines Facts
        aus einem nicht aktiven Lauf
      </span>
    </p>
  );
}
