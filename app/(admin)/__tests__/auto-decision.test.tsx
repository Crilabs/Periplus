import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { AutoDecision } from "@/lib/domain/geo-view";
import { AutoDecisionLine } from "../places/[id]/auto-decision";

const decision = (over: Partial<AutoDecision> = {}): AutoDecision => ({
  action: "confirm",
  rule: "research",
  decidedAt: new Date("2026-10-23T12:00:00Z"),
  factIds: [],
  documentIds: [],
  routeStopIds: [],
  ...over,
});

describe("AutoDecisionLine", () => {
  it("names a confirmation by the research rule", () => {
    const html = renderToStaticMarkup(<AutoDecisionLine decision={decision()} />);
    expect(html).toContain("Automatisch bestätigt am");
    expect(html).toContain("(Regel: Recherche)");
  });

  it("names a withdrawn confirmation", () => {
    const html = renderToStaticMarkup(<AutoDecisionLine decision={decision({ action: "candidate" })} />);
    expect(html).toContain("Bestätigung automatisch zurückgenommen am");
    expect(html).toContain("(Regel: Recherche)");
  });

  it("names an exclusion and a kind switch, and links the evidence documents", () => {
    expect(renderToStaticMarkup(<AutoDecisionLine decision={decision({ action: "no_anchoring" })} />)).toContain("Automatisch als Ankerverbot eingestuft am");
    const html = renderToStaticMarkup(<AutoDecisionLine decision={decision({ action: "set_kind", rule: null, documentIds: ["00000000-0000-4000-8000-000000000001"] })} />);
    expect(html).toContain("Ortsart automatisch geändert am");
    expect(html).not.toContain("Regel:");
    expect(html).toContain('href="/documents/00000000-0000-4000-8000-000000000001"');
  });
});
