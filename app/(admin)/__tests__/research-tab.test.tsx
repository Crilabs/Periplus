import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ResearchRow, ResearchViewData } from "@/lib/domain/research/view";
import { ResearchTab } from "../places/[id]/research-tab";

const row = (over: Partial<ResearchRow> = {}): ResearchRow => ({
  url: "https://blog.test.invalid/kolona",
  domain: "blog.test.invalid",
  link: "search",
  rank: 2,
  purpose: "positive",
  purposes: ["positive"],
  keyword: "Kolona anchorage",
  ownWebsite: false,
  documentId: "00000000-0000-4000-8000-000000000001",
  fetch: null,
  assessment: { pageKind: "trip_report", firstHand: true, generated: false, observedAt: "2025-06-15", berths: ["Vathi", "Kolona"] },
  signals: [],
  facts: [],
  signalCount: 0,
  factCount: 0,
  ...over,
});

const verdict = (over: Partial<ResearchViewData["verdict"]> = {}): ResearchViewData["verdict"] => ({
  status: "candidate",
  reason: "1 von 2 unabhängigen Quellen",
  independentSources: [],
  blockingSignalId: null,
  signalIds: [],
  ...over,
});

const view = (rows: ResearchRow[], v = verdict(), over: Partial<ResearchViewData> = {}): ResearchViewData => ({
  status: v.status,
  statusReason: null,
  verdict: v,
  rows,
  ...over,
});

describe("ResearchTab", () => {
  it("shows the empty state", () => {
    const html = renderToStaticMarkup(<ResearchTab view={view([])} />);
    expect(html).toContain("Noch keine Recherche für diesen Liegeplatz.");
  });

  it("labels the place's own website", () => {
    const html = renderToStaticMarkup(<ResearchTab view={view([row({ ownWebsite: true, rank: 0, keyword: null })])} />);
    expect(html).toContain("eigene Website");
  });

  it("renders a first-hand row with German labels and a link to the document", () => {
    const html = renderToStaticMarkup(<ResearchTab view={view([row()])} />);
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
      <ResearchTab view={view([row({ purpose: "negative", purposes: ["negative"], documentId: null, assessment: { pageKind: "other", firstHand: false, generated: true, observedAt: "2024-01-01", berths: [] } })])} />,
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
        view={view([
          row({ documentId: null, assessment: null, fetch: { outcome: "skipped", reason: "robots" } }),
          row({ url: "https://b.test.invalid/x", documentId: null, assessment: null, fetch: { outcome: "failed", reason: "HTTP 503" } }),
          row({ url: "https://c.test.invalid/x", documentId: null, assessment: null, fetch: null }),
        ])}
      />,
    );
    expect(html).toContain("nicht geholt: robots.txt verbietet es");
    expect(html).toContain("nicht geholt: HTTP 503");
    expect(html.match(/nicht geholt/g)).toHaveLength(2);
  });

  it("shows the confirmation with its independent sources on top", () => {
    const html = renderToStaticMarkup(
      <ResearchTab view={view([row()], verdict({ status: "confirmed", independentSources: ["a.example", "b.example"], reason: "bestätigt" }))} />,
    );
    expect(html).toContain("Bestätigt: 2 unabhängige Quellen (a.example, b.example)");
  });

  it("says confirmed only when the place is confirmed; otherwise its status and reason, and what the rule says", () => {
    const confirmedVerdict = verdict({ status: "confirmed", independentSources: ["a.example", "b.example"], reason: "bestätigt" });
    const blocked = renderToStaticMarkup(<ResearchTab view={view([row()], confirmedVerdict, { status: "no_anchoring", statusReason: "Sperrgebiet" })} />);
    expect(blocked).not.toContain("Bestätigt:");
    expect(blocked).toContain("Kein Ankerplatz: Sperrgebiet");
    expect(blocked).toContain("Regel ergibt: bestätigt, 2 unabhängige Quellen (a.example, b.example)");

    const admin = renderToStaticMarkup(<ResearchTab view={view([row()], verdict({ reason: "0 von 2 unabhängigen Quellen" }), { status: "confirmed" })} />);
    expect(admin).toContain("Bestätigt (von Hand)");
    expect(admin).toContain("Regel ergibt: 0 von 2 unabhängigen Quellen");
    expect(admin).not.toContain("Bestätigt:");

    const same = renderToStaticMarkup(<ResearchTab view={view([row()], confirmedVerdict)} />);
    expect(same).not.toContain("Regel ergibt");
  });

  it("shows the reason when not confirmed, also without hits", () => {
    const html = renderToStaticMarkup(
      <ResearchTab view={view([], verdict({ reason: "Ankerverbot der Behörde vom 2026-05-01" }), { statusReason: "Ankerverbot der Behörde vom 2026-05-01" })} />,
    );
    expect(html).toContain("Nicht bestätigt: Ankerverbot der Behörde vom 2026-05-01");
    expect(html).toContain("Noch keine Recherche für diesen Liegeplatz.");
  });

  it("labels a page linked by a neighbour's hit or a route stop, without rank and search term (final review 7)", () => {
    const linked = (link: "neighbour" | "route", url: string) => row({ url, link, rank: null, purpose: null, purposes: [], keyword: null });
    const html = renderToStaticMarkup(<ResearchTab view={view([linked("neighbour", "https://n.test.invalid/x"), linked("route", "https://r.test.invalid/x")])} />);
    expect(html).toContain("Treffer eines Nachbarn");
    expect(html).toContain("Routenhalt");
    expect(html).not.toContain("Kolona anchorage");
    expect(html).not.toContain("Bestätigung");
  });

  it("shows both purposes of a page listed once", () => {
    const html = renderToStaticMarkup(<ResearchTab view={view([row({ purposes: ["positive", "negative"] })])} />);
    expect(html).toContain("Bestätigung, Negativsuche");
  });

  it("lists the signals and facts of a page with kind, first hand, confidence, date, quote, subject and tone", () => {
    const html = renderToStaticMarkup(
      <ResearchTab
        view={view([
          row({
            signalCount: 2,
            factCount: 2,
            signals: [
              { kind: "moored_buoy", firstHand: true, confidence: 0.85, observedAt: "2024-06-15", observedAtBasis: "explicit", quote: "picked up one of the buoys" },
              { kind: "prohibited", firstHand: false, confidence: 0.9, observedAt: "2026-05-01", observedAtBasis: "fetched", quote: "Anchoring is prohibited" },
            ],
            facts: [
              { statement: "Good holding on sand", subject: null, observedAt: "2024-06-15", tone: "positive", quote: "good holding on sand" },
              { statement: "Taverna by the quay", subject: "Taverna Nikos", observedAt: "2024-06-15", tone: null, quote: "Taverna Nikos at the quay" },
            ],
          }),
        ])}
      />,
    );
    expect(html).toContain("an Boje gelegen");
    expect(html).toContain("Verbot/Sperrgebiet");
    expect(html).toContain("erste Hand");
    expect(html).toContain("Sicherheit 0.85");
    expect(html).toContain("2024-06-15");
    expect(html).toContain("picked up one of the buoys");
    expect(html).toContain("Good holding on sand");
    expect(html).toContain("Liegeplatz");
    expect(html).toContain("Taverna Nikos");
    expect(html).toContain("positiv");
    expect(html).toContain("2 / 2");
  });
});
