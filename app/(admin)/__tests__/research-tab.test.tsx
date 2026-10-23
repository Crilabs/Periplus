import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ResearchRow } from "@/lib/domain/research/view";
import { ResearchTab } from "../places/[id]/research-tab";

const row = (over: Partial<ResearchRow> = {}): ResearchRow => ({
  url: "https://blog.test.invalid/kolona",
  domain: "blog.test.invalid",
  rank: 2,
  purpose: "positive",
  keyword: "Kolona anchorage",
  documentId: "00000000-0000-4000-8000-000000000001",
  fetch: null,
  assessment: { pageKind: "trip_report", firstHand: true, generated: false, observedAt: "2025-06-15", berths: ["Vathi", "Kolona"] },
  ...over,
});

describe("ResearchTab", () => {
  it("shows the empty state", () => {
    const html = renderToStaticMarkup(<ResearchTab rows={[]} />);
    expect(html).toContain("Noch keine Recherche für diesen Liegeplatz.");
  });

  it("renders a first-hand row with German labels and a link to the document", () => {
    const html = renderToStaticMarkup(<ResearchTab rows={[row()]} />);
    expect(html).toContain("Bestätigung");
    expect(html).toContain("Törnbericht");
    expect(html).toContain("erste Hand");
    expect(html).toContain("Kolona anchorage");
    expect(html).toContain('href="/documents/00000000-0000-4000-8000-000000000001"');
    expect(html).toContain("Vathi, Kolona");
    expect(html).not.toContain("SEO/KI");
  });

  it("marks generated pages, negative searches, and links an unfetched hit to the external URL", () => {
    const html = renderToStaticMarkup(
      <ResearchTab rows={[row({ purpose: "negative", documentId: null, assessment: { pageKind: "other", firstHand: false, generated: true, observedAt: "2024-01-01", berths: [] } })]} />,
    );
    expect(html).toContain("Negativsuche");
    expect(html).toContain("SEO/KI");
    expect(html).not.toContain("erste Hand");
    expect(html).toContain('href="https://blog.test.invalid/kolona"');
    expect(html).not.toContain("/documents/");
  });

  it("says why a hit without assessment was not fetched", () => {
    const html = renderToStaticMarkup(
      <ResearchTab
        rows={[
          row({ documentId: null, assessment: null, fetch: { outcome: "skipped", reason: "robots" } }),
          row({ url: "https://b.test.invalid/x", documentId: null, assessment: null, fetch: { outcome: "failed", reason: "HTTP 503" } }),
          row({ url: "https://c.test.invalid/x", documentId: null, assessment: null, fetch: null }),
        ]}
      />,
    );
    expect(html).toContain("nicht geholt: robots.txt verbietet es");
    expect(html).toContain("nicht geholt: HTTP 503");
    expect(html.match(/nicht geholt/g)).toHaveLength(2);
  });
});
