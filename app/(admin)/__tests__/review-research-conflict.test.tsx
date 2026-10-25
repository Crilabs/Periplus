import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ResearchConflictSubjectView } from "@/lib/domain/review-view";

vi.mock("../review/[id]/actions", () => ({ decideAction: vi.fn() }));
vi.mock("../_components/mini-map", () => ({ MiniMap: () => <div data-map /> }));

import { ResearchConflictDecision } from "../review/[id]/research-conflict-decision";

const subject: ResearchConflictSubjectView = {
  type: "research_conflict",
  place: { id: "00000000-0000-4000-8000-000000000002", publicId: null, name: "Testbucht", kind: "anchorage", status: "candidate", statusReason: null, position: { lon: 21.5, lat: 35.25 } },
  threshold: 2,
  verdict: { status: "candidate", reason: "1 von 2 unabhängigen Quellen", independentSources: ["a.example"] },
  evidence: [
    {
      url: "https://www.a.example/p1",
      domain: "a.example",
      signals: [{ kind: "anchored", firstHand: true, confidence: 0.9, observedAt: "2024-06-15", observedAtBasis: "explicit", quote: "We anchored in Testbucht" }],
    },
  ],
};

const render = (open = true) =>
  renderToStaticMarkup(<ResearchConflictDecision subject={subject} features={{ type: "FeatureCollection", features: [] }} taskId="t1" openedAt="2026-10-21T10:00:00.000Z" open={open} />);

describe("ResearchConflictDecision", () => {
  it("offers „Liegeplatz“ and „Kein Liegeplatz“, each posting its decision", () => {
    const html = render();
    expect(html).toMatch(/<button[^>]*>Liegeplatz<\/button>/);
    expect(html).toMatch(/<button[^>]*>Kein Liegeplatz<\/button>/);
    expect(html).toContain("&quot;action&quot;:&quot;berth&quot;");
    expect(html).toContain("&quot;action&quot;:&quot;not_berth&quot;");
  });

  it("says only „nicht in der Referenz“, shows the evidence with quote and domain and the map links", () => {
    const html = render();
    expect(html).toContain("nicht in der Referenz");
    expect(html).not.toMatch(/navily/i);
    expect(html).toContain("a.example");
    expect(html).toContain("We anchored in Testbucht");
    expect(html).toContain("35.25000, 21.50000");
    expect(html).toContain("Luftbild");
    expect(html).toContain("data-map");
  });

  it("offers no buttons once decided", () => {
    expect(render(false)).not.toContain("<button");
  });
});
