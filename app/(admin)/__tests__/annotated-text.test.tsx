import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { FactView } from "@/lib/domain/geo-facts";
import { AnnotatedText } from "../_components/annotated-text";
import { QuoteContext } from "../_components/quote-context";
import { FactsTab } from "../places/[id]/facts-tab";

describe("AnnotatedText", () => {
  it("annotated text escapes html in the source text", () => {
    const html = renderToStaticMarkup(
      <AnnotatedText text={"<img src=x onerror=a()> Kolona"} spans={[{ start: 24, end: 30, kind: "mention", ref: "m" }]} />,
    );
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img src=x onerror=a()&gt; ");
    expect(html).toContain('<mark data-kind="mention">Kolona</mark>');
  });

  it("marks overlapping spans with all their kinds", () => {
    const html = renderToStaticMarkup(
      <AnnotatedText
        text="Ormos Vathy bietet guten Schutz"
        spans={[
          { start: 6, end: 11, kind: "mention", ref: "m" },
          { start: 6, end: 30, kind: "quote", ref: "f" },
        ]}
      />,
    );
    expect(html).toContain('Ormos <mark data-kind="mention quote">Vathy</mark><mark data-kind="quote"> bietet guten Schut</mark>z');
  });
});

describe("QuoteContext", () => {
  it("highlights the quote and escapes html around it", () => {
    const html = renderToStaticMarkup(<QuoteContext before={"<script>x()</script> "} quote="Holding is good" after=" in sand" />);
    expect(html).not.toContain("<script>");
    expect(html).toContain('&lt;script&gt;x()&lt;/script&gt; <mark data-kind="quote">Holding is good</mark> in sand');
  });
});

describe("FactsTab", () => {
  const fact = (over: Partial<FactView>): FactView => ({
    id: "f1",
    attribute: "holding",
    value: "good",
    confidence: 0.9,
    observedAt: "2026-05-15",
    origin: "text",
    quote: "Holding is good in sand",
    context: { before: "Kolona. ", quote: "Holding is good in sand", after: "." },
    source: { domain: "example.test.invalid", weight: 0.6 },
    documentId: "d1",
    documentVersionId: "v1",
    model: "claude-sonnet-5-5",
    extractionRunId: "e1",
    runId: "r1234567-0000",
    active: true,
    ...over,
  });

  it("shows label, formatted value, highlighted quote, source link and run; a fact of another run greyed", () => {
    const html = renderToStaticMarkup(
      <FactsTab
        groups={[{ attribute: "holding", facts: [fact({}), fact({ id: "f2", value: "moderate", active: false, model: "claude-opus-5-5" })] }]}
        runs="all"
        runsHref={(r) => `/x?runs=${r}`}
      />,
    );
    expect(html).toContain("Halt");
    expect(html).toContain("gut");
    expect(html).toContain('<mark data-kind="quote">Holding is good in sand</mark>');
    // the document link opens the quote's version on the tab that highlights it
    expect(html).toContain('href="/documents/d1?v=v1&amp;tab=annotations"');
    expect(html).toContain('href="/runs/r1234567-0000"');
    expect(html).toMatch(/opacity-60[^>]*><p[^>]*><span class="font-semibold">mäßig/);
    expect(html).toContain("nicht aktiver Lauf");
    expect(html).toContain('href="/x?runs=active"');
  });
});
