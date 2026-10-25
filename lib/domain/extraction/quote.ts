/** `inactive-quote`: the quote of a fact that is not from the active extraction run of its (version, object). */
export type SpanKind = "mention" | "quote" | "inactive-quote";
export type Span = { start: number; end: number; kind: SpanKind; ref: string };
export type TextSegment = { text: string; kinds: SpanKind[]; refs: string[] };

/**
 * Splits `text` at the boundaries of all spans; each segment lists the kinds (once each) and refs of the spans
 * covering it, in span order. Spans are clamped to the text; empty spans are ignored.
 */
export function segmentText(text: string, spans: Span[]): TextSegment[] {
  const clamped = spans
    .map((s) => ({ ...s, start: Math.max(0, s.start), end: Math.min(text.length, s.end) }))
    .filter((s) => s.start < s.end);
  const bounds = [...new Set([0, text.length, ...clamped.flatMap((s) => [s.start, s.end])])].sort((a, b) => a - b);
  const segments: TextSegment[] = [];
  for (let i = 0; i + 1 < bounds.length; i++) {
    const [from, to] = [bounds[i]!, bounds[i + 1]!];
    const covering = clamped.filter((s) => s.start <= from && s.end >= to);
    segments.push({
      text: text.slice(from, to),
      kinds: [...new Set(covering.map((s) => s.kind))],
      refs: covering.map((s) => s.ref),
    });
  }
  return segments;
}
