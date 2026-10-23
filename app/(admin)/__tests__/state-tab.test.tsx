import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { BerthStateView } from "@/lib/domain/research/view";
import { StateTab } from "../places/[id]/state-tab";

const view = (over: Partial<BerthStateView> = {}): BerthStateView => ({
  status: "confirmed",
  updatedAt: new Date("2026-10-23T10:00:00Z"),
  runId: null,
  core: [
    { attribute: "holding", label: "Ankergrund", value: "gut", origin: "text", confidence: 0.8, observedAt: "2025-06-15" },
    { attribute: "shelter.N", label: "Schutz N", value: "0,9", origin: "computed", confidence: 0.55, observedAt: null },
    { attribute: "berthable", label: "Festmachplatz", value: "ja", origin: "rule", confidence: 1, observedAt: null },
  ],
  gaps: [{ attribute: "seabed", label: "Meeresboden" }],
  facts: [
    { factId: "f1", subject: "landside", subjectName: "Taverna Nikos", subjectCategory: "food", statement: "Taverne geschlossen", observedAt: "2025-06-15", tone: "negative", safety: false, mentions: 2 },
    { factId: "f2", subject: "berth", subjectName: null, subjectCategory: null, statement: "Felsen am Eingang", observedAt: "2024-06-15", tone: null, safety: true, mentions: 1 },
  ],
  landing: [
    { kind: "pier", lon: 21.0, lat: 35.2, geoObjectId: null, description: null },
    { kind: "text", lon: null, lat: null, geoObjectId: null, description: "Dinghy am Strand links" },
  ],
  nearby: [
    { geoObjectId: "o1", name: "Bushaltestelle", category: "transport", categoryLabel: "Verkehr", distanceM: 420, access: "foot" },
    { geoObjectId: "o2", name: "Kloster", category: "culture", categoryLabel: "Kultur", distanceM: 6200, access: "transport" },
  ],
  ...over,
});

describe("StateTab", () => {
  it("shows the empty state without a state", () => {
    expect(renderToStaticMarkup(<StateTab view={null} />)).toContain("Noch kein Stand für diesen Liegeplatz.");
  });

  it("shows core values with their origin, gaps, facts, landing points and reachable things in German", () => {
    const html = renderToStaticMarkup(<StateTab view={view()} />);
    for (const text of ["Ankergrund", "Text", "berechnet", "Regel", "Meeresboden", "Taverne geschlossen", "Taverna Nikos", "negativ", "Sicherheit", "Steg", "Hinweis aus Text", "Dinghy am Strand links"]) {
      expect(html).toContain(text);
    }
    expect(html).toContain("Bushaltestelle");
    expect(html).toContain("420 m");
    expect(html).toContain("zu Fuß");
    expect(html).toContain("Bus/Taxi");
    expect(html).not.toContain("Nicht mehr bestätigt");
  });

  it("says when the place is no longer confirmed", () => {
    expect(renderToStaticMarkup(<StateTab view={view({ status: "candidate" })} />)).toContain("Nicht mehr bestätigt");
  });
});
