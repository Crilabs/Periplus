import { segmentText, type Span } from "@/lib/domain/extraction/quote";

/**
 * Text with highlighted spans (mentions, quotes): every segment covered by a span is a `<mark data-kind="…">` (the
 * kinds of all covering spans, space-separated). The text is rendered as React children only, never as HTML, so markup
 * in a source text stays text.
 */
export function AnnotatedText({ text, spans, className }: { text: string; spans: Span[]; className?: string }) {
  return (
    <span
      className={`whitespace-pre-wrap [&_mark]:rounded-sm [&_mark]:px-0.5 [&_mark[data-kind~=mention]]:bg-amber-200 [&_mark[data-kind~=quote]]:bg-sky-200 ${className ?? ""}`}
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
