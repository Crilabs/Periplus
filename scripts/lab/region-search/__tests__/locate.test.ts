import { describe, expect, it } from "vitest";
import { getConfig } from "../../../../lib/config";
import type { Mention } from "../extract";
import type { GazObject } from "../gazetteer";
import { locateAll, locateByGazetteer } from "../locate";

// Invented names and North Sea coordinates: nothing here resembles the reference (spec, anti-goal 1).
const gaz: GazObject[] = [
  { id: "g1", type: "bay", category: null, names: ["Ormos Zorbakia", "Zorbakia Bay"], lon: 4.5, lat: 54.2, islandName: "Nisos Plinth" },
  { id: "g2", type: "bay", category: null, names: ["Kolpos Mirrin"], lon: 4.6, lat: 54.25, islandName: "Nisos Plinth" },
  { id: "g3", type: "bay", category: null, names: ["Kolpos Mirrin"], lon: 4.9, lat: 54.1, islandName: "Nisos Quell" },
  { id: "g4", type: "settlement", category: null, names: ["Vrontaki"], lon: 4.7, lat: 54.3, islandName: "Nisos Plinth" },
  { id: "g5", type: "bay", category: null, names: ["Ormos Vrontaki"], lon: 4.7008, lat: 54.3005, islandName: "Nisos Plinth" },
];

const affixes = getConfig().nameAffixes;

function mention(over: Partial<Mention>): Mention {
  return {
    url: "https://example.org/p",
    domain: "example.org",
    name: "Zorbakia",
    aliases: [],
    area: null,
    kind: "anchorage",
    coordinate: null,
    coordinateQuote: null,
    positionQuote: null,
    berthQuote: "we anchored in Zorbakia bay overnight in sand",
    firstHand: true,
    pageKind: "trip_report",
    ...over,
  };
}

describe("locateByGazetteer", () => {
  it("finds the one object whose name matches", () => {
    const r = locateByGazetteer(mention({ name: "Zorbakia" }), gaz, affixes);
    expect("object" in r && r.object.id).toBe("g1");
  });

  it("reports ambiguity when two distant objects share the name", () => {
    const r = locateByGazetteer(mention({ name: "Mirrin" }), gaz, affixes);
    expect("reason" in r && r.reason).toBe("ambiguous");
  });

  it("prefers the bay when the same name sits on a bay and a settlement 100 m apart", () => {
    const r = locateByGazetteer(mention({ name: "Vrontaki" }), gaz, affixes);
    expect("object" in r && r.object.id).toBe("g5");
  });

  it("reports no match for an unknown name", () => {
    const r = locateByGazetteer(mention({ name: "Kalimnotis" }), gaz, affixes);
    expect("reason" in r && r.reason).toBe("no_match");
  });
});

describe("locateAll", () => {
  it("uses a coordinate before the name, and records the reason for an unresolved mention", () => {
    const located = locateAll(
      [
        mention({ name: "Kalimnotis", coordinate: { lat: 54.21, lon: 4.51, precisionM: 90, text: "54°12.6'N 4°30.6'E" } }),
        mention({ name: "Kalimnotis" }),
        mention({ name: "" }),
      ],
      gaz,
      affixes,
    );
    expect(located[0]?.method).toBe("coordinate");
    expect(located[0]?.lat).toBeCloseTo(54.21, 3);
    expect(located[1]?.method).toBeNull();
    expect(located[1]?.reason).toBe("no_match");
    expect(located[2]?.reason).toBe("no_name");
  });
});
