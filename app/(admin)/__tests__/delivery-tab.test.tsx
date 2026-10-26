import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Spot } from "@/contract";
import { DeliveryTab } from "../places/[id]/delivery-tab";

const spot = {
  id: "sp_01J9ZD00000000000000000001",
  asOf: "2026-10-20",
  gaps: ["depth"],
  facts: [
    { id: "fc_00000000000000000000000001", subject: { kind: "spot" }, text: "Schwell bei Südwind", observedAt: null, tone: "negative", safety: true, mentions: 2 },
    { id: "fc_00000000000000000000000002", subject: { kind: "landside", id: "hl_01J9ZD00000000000000000009", name: null }, text: "Gute Bäckerei", observedAt: "2026-05-01", tone: "positive", safety: false, mentions: 1 },
  ],
  landingPoints: [{ kind: "beach", position: { lat: 37.1, lon: 23.2 } }, { kind: "text", description: "Beiboot am Felsen" }],
  nearby: [{ id: "hl_01J9ZD00000000000000000009", category: "bakery", name: "Bäckerei Nikos", position: { lat: 37.1, lon: 23.2 }, distanceM: 250, access: "foot" }],
} as unknown as Spot;

describe("DeliveryTab (contract 4.0)", () => {
  it("shows facts with safety marker and tone, landing points, nearby with distance and access, gaps", () => {
    const html = renderToStaticMarkup(
      <DeliveryTab view={{ delivered: { spot, dataVersion: 3, deliveryId: "d1" }, preview: { spot, differs: false }, history: [] }} />,
    );
    expect(html).toContain("Sicherheit");
    expect(html).toContain("negativ");
    expect(html).toContain("Schwell bei Südwind");
    expect(html).toContain("Bäckerei Nikos");
    expect(html).toContain("250 m");
    expect(html).toContain("zu Fuß");
    expect(html).toContain("Beiboot am Felsen");
    expect(html).toContain("Strand");
    expect(html).toContain("Lücken (1)");
    expect(html).toContain("depth");
  });
});
