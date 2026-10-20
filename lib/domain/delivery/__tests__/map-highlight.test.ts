import { describe, expect, it } from "vitest";
import { highlightSchema } from "@/contract/v1";
import { getConsolidationConfig, loadConfig } from "@/lib/config";
import type { AttributeProvenance, ProfileSnapshot } from "@/lib/domain/consolidation/types";
import { provenanceEntry } from "@/test/consolidation";
import { highlightIdsBySpot, mapHighlights, type HighlightSpot } from "../map-highlight";
import type { LonLat, PoiSource } from "../types";

const cfg = loadConfig("config").delivery;
const consolidation = getConsolidationConfig();
const radiusNm = consolidation.importance.radiusNm;
const ctx = { radiusNm, cfg, poiConfidence: consolidation.poiConfidence, regionIdFor: () => null };

const LAT_PER_NM = 1 / 60;
const ORIGIN: LonLat = { lon: 21.1, lat: 35.1 };
/** A point `nm` nautical miles north of the origin. */
const north = (nm: number, from: LonLat = ORIGIN): LonLat => ({ lon: from.lon, lat: Number((from.lat + nm * LAT_PER_NM).toFixed(5)) });
const id = (prefix: "sp" | "hl" | "rg", n: number) => `${prefix}_01J9ZD${String(n).padStart(20, "0")}`;

function profile(attributes: Record<string, unknown>, provenance: Record<string, AttributeProvenance> = {}, patch: Partial<ProfileSnapshot> = {}): ProfileSnapshot {
  return {
    version: 1,
    validFrom: "2026-10-19",
    attributes,
    provenance,
    conflicts: [],
    gaps: [],
    sourcesCount: 2,
    documentsCount: 1,
    confidence: null,
    contentHash: "h",
    rulesVersion: "test",
    factSchemaVersion: "v2",
    ...patch,
  };
}

function poi(n: number, o: { importance?: unknown; position?: LonLat; name?: string; attributes?: Record<string, unknown>; profile?: Partial<ProfileSnapshot> | null } = {}): PoiSource {
  return {
    geoObjectId: `g${n}`,
    publicId: id("hl", n),
    category: "food",
    name: o.name ?? "Taverna Nikos",
    position: o.position ?? ORIGIN,
    osmId: `node/${n}`,
    wikidataId: null,
    profile:
      o.profile === null
        ? null
        : profile(
            { "derived.importance": o.importance ?? 2, ...o.attributes },
            { "derived.importance": provenanceEntry("derived", { confidence: 1 }) },
            o.profile,
          ),
    summary: null,
    sources: [],
  };
}

const spot = (n: number, position: LonLat, patch: Partial<HighlightSpot> = {}): HighlightSpot => ({
  id: id("sp", n),
  position,
  mergedInto: null,
  excluded: false,
  ...patch,
});

describe("mapHighlights", () => {
  it("reports the forbidden-domain links of delivered highlights only (ruling M6-D-R2)", () => {
    const navily = { url: "https://fr.navily.com/poi/1", docType: "forum" as const, observedAt: "2026-07-01" };
    const delivered = { ...poi(1), sources: [navily, { url: "https://example.org/a", docType: "trip_report" as const, observedAt: "2026-06-01" }] };
    const dropped = { ...poi(2, { profile: null }), sources: [navily] };
    const out = mapHighlights([delivered, dropped], [spot(1, north(3))], ctx);
    expect(out.highlights.map((h) => h.sources)).toEqual([[{ url: "https://example.org/a", kind: "tripReport", observedAt: "2026-06-01" }]]);
    expect(out.forbiddenSources).toEqual([{ id: id("hl", 1), urls: [navily.url] }]);
  });

  it("importance 2 gives radius 10 nm and spots sorted by distance", () => {
    const spots = [spot(1, north(9)), spot(2, north(11)), spot(3, north(3))];
    const { highlights, dropped } = mapHighlights([poi(1, { importance: 2 })], spots, ctx);
    expect(dropped).toEqual([]);
    expect(highlights).toHaveLength(1);
    expect(highlights[0]!.importance).toBe(2);
    expect(highlights[0]!.spotIds).toEqual([id("sp", 3), id("sp", 1)]);
    // importance 1 (5 nm) keeps only the near spot
    expect(mapHighlights([poi(1, { importance: 1 })], spots, ctx).highlights[0]!.spotIds).toEqual([id("sp", 3)]);
  });

  it("equal distances sort by spot id and the list stops at highlights.maxSpotIds", () => {
    const spots = [spot(7, north(1)), spot(5, north(1)), spot(6, north(0.5))];
    expect(mapHighlights([poi(1)], spots, ctx).highlights[0]!.spotIds).toEqual([id("sp", 6), id("sp", 5), id("sp", 7)]);
    const capped = mapHighlights([poi(1)], spots, { ...ctx, cfg: { ...cfg, highlights: { maxSpotIds: 2 } } }).highlights[0]!;
    expect(capped.spotIds).toEqual([id("sp", 6), id("sp", 5)]);
  });

  it("merged and excluded spots never count (ruling M6-P5)", () => {
    const spots = [spot(1, north(1), { mergedInto: id("sp", 3) }), spot(2, north(2), { excluded: true }), spot(3, north(4))];
    expect(mapHighlights([poi(1)], spots, ctx).highlights[0]!.spotIds).toEqual([id("sp", 3)]);
  });

  it("a highlight losing its only spot is dropped and the spot loses the highlight id", () => {
    const before = [spot(1, north(3))];
    const first = mapHighlights([poi(1)], before, ctx);
    expect(highlightIdsBySpot(first.highlights, before).get(id("sp", 1))).toEqual([id("hl", 1)]);

    // the spot is excluded in the next build
    const after = [spot(1, north(3), { excluded: true })];
    const second = mapHighlights([poi(1)], after, ctx);
    expect(second.highlights).toEqual([]);
    expect(second.dropped).toEqual([{ id: id("hl", 1), reason: "no_spot_in_radius" }]);
    expect(highlightIdsBySpot(second.highlights, after).get(id("sp", 1))).toEqual([]);
  });

  it("highlightIdsBySpot inverts spotIds by distance and gives an excluded spot none", () => {
    const spots = [spot(1, ORIGIN), spot(2, north(0.5), { excluded: true })];
    const near = poi(1, { position: north(1) });
    const far = poi(2, { position: north(4), name: "Kloster" });
    const { highlights } = mapHighlights([far, near], spots, ctx);
    const bySpot = highlightIdsBySpot(highlights, spots);
    expect(bySpot.get(id("sp", 1))).toEqual([id("hl", 1), id("hl", 2)]);
    expect(bySpot.get(id("sp", 2))).toEqual([]);
    // even a hand-built highlight naming an excluded spot leaves the excluded spot without highlights
    const forced = highlightIdsBySpot([{ ...highlights[0]!, spotIds: [id("sp", 2)] }], spots);
    expect(forced.get(id("sp", 2))).toEqual([]);
  });

  it("two 'Taverna Nikos' 300 m apart merge into the more important one", () => {
    const a = poi(2, { importance: 2, position: ORIGIN });
    const b = poi(1, { importance: 3, position: north(300 / 1852), name: "TAVERNA  Nikos!" });
    const spots = [spot(1, north(-2)), spot(2, north(14))];
    const { highlights, dropped } = mapHighlights([a, b], spots, ctx);
    expect(highlights.map((h) => h.id)).toEqual([id("hl", 1)]);
    expect(dropped).toEqual([{ id: id("hl", 2), reason: "duplicate", into: id("hl", 1) }]);
    // the union of both spot lists, re-sorted by distance to the kept highlight
    expect(highlights[0]!.spotIds).toEqual([id("sp", 1), id("sp", 2)]);
  });

  it("equal importance keeps the smaller id; 600 m apart or another name stays separate", () => {
    // spot 2 lies 9.9 nm south of hl 2 only: within its 10 nm, outside hl 1's
    const spots = [spot(1, north(1)), spot(2, north(-9.9))];
    const same = mapHighlights([poi(2), poi(1, { position: north(300 / 1852) })], spots, ctx);
    expect(same.dropped).toEqual([{ id: id("hl", 2), reason: "duplicate", into: id("hl", 1) }]);
    expect(same.highlights[0]!.spotIds).toEqual([id("sp", 1), id("sp", 2)]);
    const apart = mapHighlights([poi(2), poi(1, { position: north(600 / 1852) })], spots, ctx);
    expect(apart.highlights).toHaveLength(2);
    const other = mapHighlights([poi(2), poi(1, { name: "Taverna Maria" })], spots, ctx);
    expect(other.highlights).toHaveLength(2);
  });

  it("highlight season months come from open season notes", () => {
    const notes = [
      { kind: "open", months: [7, 6] },
      { kind: "closed", months: [1, 2] },
      { kind: "open", months: [8, 7] },
    ];
    const spots = [spot(1, north(1))];
    const h = mapHighlights([poi(1, { attributes: { season_notes: notes } })], spots, ctx).highlights[0]!;
    expect(h.season).toEqual({ months: [6, 7, 8] });
    expect(mapHighlights([poi(1, { attributes: { season_notes: [{ kind: "closed", months: [1] }] } })], spots, ctx).highlights[0]!.season).toBeNull();
    expect(mapHighlights([poi(1)], spots, ctx).highlights[0]!.season).toBeNull();
  });

  it("score confidence: profile confidence, else the exists attribute, else poiConfidence (ruling M6-P7)", () => {
    const spots = [spot(1, north(1))];
    const conf = (p: PoiSource) => mapHighlights([p], spots, ctx).highlights[0]!.score.confidence;
    expect(conf(poi(1, { profile: { confidence: 0.81 } }))).toBe(0.81);
    const withExists = poi(1, { attributes: { exists: true } });
    withExists.profile!.provenance["exists"] = provenanceEntry("text", { confidence: 0.55, observedAt: "2025-05-02" });
    expect(conf(withExists)).toBe(0.55);
    expect(conf(poi(1))).toBe(consolidation.poiConfidence);
    const h = mapHighlights([withExists], spots, ctx).highlights[0]!;
    expect(h.score).toEqual({ confidence: 0.55, sourcesCount: 2, lastObserved: "2025-05-02" });
  });

  it("drops a POI without profile, without importance or without a name", () => {
    const spots = [spot(1, north(1))];
    const { highlights, dropped } = mapHighlights(
      [poi(1, { profile: null }), poi(2, { attributes: { "derived.importance": null } }), poi(3, { importance: 6 }), poi(4, { name: " " })],
      spots,
      ctx,
    );
    expect(highlights).toEqual([]);
    expect(dropped).toEqual([
      { id: id("hl", 1), reason: "no_profile" },
      { id: id("hl", 2), reason: "no_importance" },
      { id: id("hl", 3), reason: "no_importance" },
      { id: id("hl", 4), reason: "no_name" },
    ]);
  });

  it("a POI with exists: false is not delivered (ruling M6-C-R1); exists: true or unknown is", () => {
    const spots = [spot(1, north(1))];
    const { highlights, dropped } = mapHighlights(
      [poi(1, { attributes: { exists: false } }), poi(2, { attributes: { exists: true }, position: north(0, { lon: 21.2, lat: 35.1 }) }), poi(3, { name: "Kafeneio" })],
      spots,
      ctx,
    );
    expect(dropped).toEqual([{ id: id("hl", 1), reason: "not_existing" }]);
    expect(highlights.map((h) => h.id)).toEqual([id("hl", 2), id("hl", 3)]);
  });

  it("maps fields to the contract: category, region, refs, sources without upload://, summary", () => {
    const src = poi(1, { position: { lon: 21.1000049, lat: 35.1000051 }, profile: { confidence: 0.2 } });
    src.wikidataId = "Q42";
    src.summary = "Taverne direkt am Steg.";
    src.sources = [
      { url: "upload://abc", docType: "pilot_guide", observedAt: "2025-01-01" },
      { url: "https://example-reise.de/nikos", docType: "travel_guide", observedAt: "2024-03-01" },
    ];
    const region = id("rg", 1);
    const { highlights } = mapHighlights([src], [spot(1, north(1))], { ...ctx, regionIdFor: () => region });
    const h = highlights[0]!;
    expect(h).toMatchObject({
      id: id("hl", 1),
      name: "Taverna Nikos",
      category: "food",
      position: { lon: 21.1, lat: 35.10001 },
      regionId: region,
      externalRefs: { googlePlaceId: null, osmId: "node/1", wikidataId: "Q42" },
      sources: [{ url: "https://example-reise.de/nikos", kind: "travelGuide", observedAt: "2024-03-01" }],
      summary: { de: "Taverne direkt am Steg. (wenig belegt)" },
    });
    expect(highlightSchema.safeParse({ ...h, profileVersion: 1, validFrom: "2026-10-19" }).error?.issues).toBeUndefined();
  });
});
