/**
 * A quote in its context: the text before and after it as plain text and the quote highlighted as
 * `<mark data-kind="quote">`. Everything is rendered as React children, never as HTML.
 */
export function QuoteContext({ before, quote, after }: { before: string; quote: string; after: string }) {
  return (
    <span className="whitespace-pre-wrap [&_mark]:rounded-sm [&_mark]:bg-sky-200 [&_mark]:px-0.5">
      {before}
      <mark data-kind="quote">{quote}</mark>
      {after}
    </span>
  );
}
