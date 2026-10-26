import { describe, expect, it } from "vitest";
import { publicId } from "@/contract/v2";
import { newId } from "@/lib/domain/ids";
import { factPublicId, mapFacts, mapLandingPoints, mapNearby } from "../map-facts";
import type { NearbyObject } from "../types";

const HL_1 = "hl_01J9ZD00000000000000000001";
const HL_2 = "hl_01J9ZD00000000000000000002";

const obj = (id: string, publicId: string | null, name: string, lon = 21.1, lat = 35.1): NearbyObject => ({
  geoObjectId: id,
  publicId,
  name,
  names: [],
  position: { lon, lat },
});

describe("factPublicId", () => {
  it("is fc_ and the Crockford base 32 of the uuid, 26 characters, valid by the contract's id pattern", () => {
    expect(factPublicId("00000000-0000-0000-0000-000000000000")).toBe(`fc_${"0".repeat(26)}`);
    // 128 bits: the first of the 26 characters carries only 3 bits
    expect(factPublicId("ffffffff-ffff-ffff-ffff-ffffffffffff")).toBe(`fc_7${"Z".repeat(25)}`);
    expect(factPublicId("00000000-0000-0000-0000-00000000001f")).toBe(`fc_${"0".repeat(25)}Z`);
    const schema = publicId("fc");
    for (let i = 0; i < 200; i++) {
      const id = newId();
      expect(schema.safeParse(factPublicId(id)).success, id).toBe(true);
    }
  });

  it("is deterministic, case-blind and distinct per uuid", () => {
    const a = newId();
    const b = newId();
    expect(factPublicId(a)).toBe(factPublicId(a));
    expect(factPublicId(a)).toBe(factPublicId(a.toUpperCase()));
    expect(factPublicId(a)).not.toBe(factPublicId(b));
  });

  it("rejects what is no uuid", () => {
    expect(() => factPublicId("nope")).toThrow();
  });
});

describe("mapNearby", () => {
  const entry = (geoObjectId: string, patch: Record<string, unknown> = {}) => ({ geoObjectId, category: "food" as const, distanceM: 300.4, access: "foot" as const, ...patch });

  it("delivers the things with a public id, nearest first, distance rounded, position at 5 decimals", () => {
    const { delivered, warnings } = mapNearby(
      [entry("a", { distanceM: 900.6 }), entry("b", { category: "bakery", distanceM: 120 })],
      [obj("a", HL_1, "Taverna", 21.123456789, 35.1), obj("b", HL_2, "Backerei")],
    );
    expect(warnings).toEqual([]);
    expect(delivered.map((d) => d.entry)).toEqual([
      { id: HL_2, category: "bakery", name: "Backerei", position: { lat: 35.1, lon: 21.1 }, distanceM: 120, access: "foot" },
      { id: HL_1, category: "food", name: "Taverna", position: { lat: 35.1, lon: 21.12346 }, distanceM: 901, access: "foot" },
    ]);
  });

  it("leaves out an object without a public id or not loaded, with a warning, and a category outside the contract silently", () => {
    const { delivered, warnings } = mapNearby(
      [entry("a"), entry("b"), entry("c"), entry("d", { category: "landing" })],
      [obj("a", null, "Ohne ID"), obj("b", HL_1, "Mit ID"), obj("d", HL_2, "Landung")],
    );
    expect(delivered.map((d) => d.entry.id)).toEqual([HL_1]);
    expect(warnings).toEqual([
      { code: "nearby_without_id", geoObjectId: "a" },
      { code: "nearby_without_id", geoObjectId: "c" },
    ]);
  });
});

describe("mapFacts", () => {
  const nearby = mapNearby([{ geoObjectId: "a", category: "food", distanceM: 10, access: "foot" }], [{ ...obj("a", HL_1, "Taverna Ελένη"), names: [{ lang: "el", name: "Ταβέρνα Ελένη", script: "greek" }] }]).delivered;
  const fact = (patch: Record<string, unknown>) => ({
    factId: newId(),
    subject: "landside" as const,
    subjectName: null,
    subjectCategory: null,
    statement: "Fresh fish.",
    observedAt: "2025-06-10",
    tone: "positive" as const,
    safety: false,
    mentions: 1,
    ...patch,
  });

  it("matches a landside fact to a nearby entry by any name of the object, ignoring case, accents and punctuation", () => {
    for (const subjectName of ["taverna ελένη", "TAVERNA  Ελενη!", "Ταβέρνα Ελένη", "ταβερνα ελενη"]) {
      const { facts } = mapFacts([fact({ subjectName })], nearby);
      expect(facts[0]!.subject, subjectName).toEqual({ kind: "landside", id: HL_1, name: null });
    }
  });

  it("keeps the name of a landside fact without a match, and drops one without a name with a warning", () => {
    const named = fact({ subjectName: "Kafeneio Kosta" });
    const nameless = fact({ subjectName: "  " });
    const { facts, warnings } = mapFacts([named, nameless], nearby);
    expect(facts.map((f) => f.subject)).toEqual([{ kind: "landside", id: null, name: "Kafeneio Kosta" }]);
    expect(warnings).toEqual([{ code: "fact_without_subject", factId: nameless.factId }]);
  });

  it("a fact of the berth is a spot fact whatever its subject name; the date is the day; newest first", () => {
    const { facts } = mapFacts(
      [fact({ subject: "berth", subjectName: "Taverna Ελένη", observedAt: "2024-01-01" }), fact({ subject: "berth", observedAt: "2026-03-04T10:00:00Z", safety: true })],
      nearby,
    );
    expect(facts.map((f) => [f.subject.kind, f.observedAt, f.safety])).toEqual([
      ["spot", "2026-03-04", true],
      ["spot", "2024-01-01", false],
    ]);
  });

  it("two landside facts of one object both point at it, and only the statement and date are delivered (no quote, no source)", () => {
    const { facts } = mapFacts([fact({ subjectName: "Taverna Ελένη" }), fact({ subjectName: "Ταβέρνα Ελένη" })], nearby);
    expect(facts.every((f) => f.subject.kind === "landside" && f.subject.id === HL_1)).toBe(true);
    expect(Object.keys(facts[0]!).sort()).toEqual(["id", "mentions", "observedAt", "safety", "subject", "text", "tone"]);
  });
});

describe("mapLandingPoints", () => {
  it("maps points with 5 decimals and texts; leaves out a point without a position and a text without a description", () => {
    expect(
      mapLandingPoints([
        { kind: "pier", lon: 21.1234567, lat: 35.7654321, geoObjectId: null, description: null },
        { kind: "slipway", lon: null, lat: 35.1, geoObjectId: "g", description: null },
        { kind: "text", lon: null, lat: null, geoObjectId: null, description: "Small beach in the corner" },
        { kind: "text", lon: null, lat: null, geoObjectId: null, description: " " },
      ]),
    ).toEqual([
      { kind: "pier", position: { lat: 35.76543, lon: 21.12346 } },
      { kind: "text", description: "Small beach in the corner" },
    ]);
  });
});
