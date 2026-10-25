import { describe, expect, it } from "vitest";
import { highlightSchema } from "@/contract/v3_0";
import { getConsolidationConfig, loadConfig } from "@/lib/config";
import type { AttributeProvenance, ProfileSnapshot } from "@/lib/domain/consolidation/types";
import { provenanceEntry } from "@/test/consolidation";
import { highlightIdsBySpot, mapHighlights, type HighlightSpot } from "../map-highlight";
import type { LonLat, PoiSource } from "../types";

const cfg = loadConfig("config").delivery;
const consolidation = getConsolidationConfig();
const ctx = { cfg, poiConfidence: consolidation.poiConfidence, regionIdFor: () => null };

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

/** `selectedBy`: [spot number, distance km] of the places selecting the POI; default spot 1 at 1 km. */
function poi(
  n: number,
  o: {
    importance?: unknown;
    position?: LonLat;
    name?: string;
    attributes?: Record<string, unknown>;
    profile?: Partial<ProfileSnapshot> | null;
    selectedBy?: Array<[number, number]>;
  } = {},
): PoiSource {
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
    images: [],
    selectedBy: (o.selectedBy ?? [[1, 1]]).map(([spotN, distanceKm]) => ({ placeGeoObjectId: `p${spotN}`, distanceKm })),
  };
}

const spot = (n: number, position: LonLat, patch: Partial<HighlightSpot> = {}): HighlightSpot => ({
  id: id("sp", n),
  geoObjectId: `p${n}`,
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
    expect(out.dropped).toEqual([{ id: id("hl", 2), reason: "no_profile" }]);
    expect(out.highlights.map((h) => h.sources)).toEqual([[{ url: "https://example.org/a", kind: "tripReport", observedAt: "2026-06-01" }]]);
    expect(out.forbiddenSources).toEqual([{ id: id("hl", 1), urls: [navily.url] }]);
  });

  it("highlight spotIds are the selecting spots by distance (spec 16)", () => {
    // spot 4 lies next to the POI but does not select it; the importance plays no part
    const spots = [spot(1, north(9)), spot(2, north(11)), spot(3, north(3)), spot(4, north(0.1))];
    const selectedBy: Array<[number, number]> = [[1, 16.7], [2, 20.4], [3, 5.6]];
    const { highlights, dropped, selectors } = mapHighlights([poi(1, { importance: 1, selectedBy })], spots, ctx);
    expect(dropped).toEqual([]);
    expect(highlights).toHaveLength(1);
    expect(highlights[0]!.importance).toBe(1);
    expect(highlights[0]!.spotIds).toEqual([id("sp", 3), id("sp", 1), id("sp", 2)]);
    expect(selectors.get(id("hl", 1))).toEqual([id("sp", 3), id("sp", 1), id("sp", 2)]);
  });

  it("equal distances sort by spot id and the list stops at highlights.maxSpotIds", () => {
    const spots = [spot(7, north(1)), spot(5, north(1)), spot(6, north(0.5))];
    const selectedBy: Array<[number, number]> = [[7, 1.8], [5, 1.8], [6, 0.9]];
    expect(mapHighlights([poi(1, { selectedBy })], spots, ctx).highlights[0]!.spotIds).toEqual([id("sp", 6), id("sp", 5), id("sp", 7)]);
    const capped = mapHighlights([poi(1, { selectedBy })], spots, { ...ctx, cfg: { ...cfg, highlights: { maxSpotIds: 2 } } });
    expect(capped.highlights[0]!.spotIds).toEqual([id("sp", 6), id("sp", 5)]);
    // the validation's selectors are not capped
    expect(capped.selectors.get(id("hl", 1))).toEqual([id("sp", 6), id("sp", 5), id("sp", 7)]);
  });

  it("excluded or merged selecting spot is left out (ruling M6-P5, spec 16 review focus 2)", () => {
    const spots = [spot(1, north(1), { mergedInto: id("sp", 3) }), spot(2, north(2), { excluded: true }), spot(3, north(4))];
    const selectedBy: Array<[number, number]> = [[1, 1.8], [2, 3.7], [3, 7.4]];
    const { highlights, selectors } = mapHighlights([poi(1, { selectedBy })], spots, ctx);
    expect(highlights[0]!.spotIds).toEqual([id("sp", 3)]);
    expect(selectors.get(id("hl", 1))).toEqual([id("sp", 3)]);
    // selected only by the merged and the excluded spot: not delivered
    const only = mapHighlights([poi(1, { selectedBy: [[1, 1.8], [2, 3.7]] })], spots, ctx);
    expect(only.highlights).toEqual([]);
    expect(only.dropped).toEqual([{ id: id("hl", 1), reason: "not_selected" }]);
  });

  it("two spots 30 m apart selecting one POI give one highlight with both ids by distance (review focus 3)", () => {
    const spots = [spot(1, north(1)), spot(2, north(1 + 30 / 1852))];
    const { highlights, dropped } = mapHighlights([poi(1, { position: north(2), selectedBy: [[1, 1.852], [2, 1.822]] })], spots, ctx);
    expect(dropped).toEqual([]);
    expect(highlights.map((h) => h.id)).toEqual([id("hl", 1)]);
    expect(highlights[0]!.spotIds).toEqual([id("sp", 2), id("sp", 1)]);
  });

  it("unselected POI is dropped with not_selected, before its missing profile", () => {
    const spots = [spot(1, north(1))];
    // no selection at all; selected only by a place that is no delivered spot
    const { highlights, dropped } = mapHighlights(
      [poi(1, { profile: null, selectedBy: [] }), poi(2, { selectedBy: [[9, 1]] })],
      spots,
      ctx,
    );
    expect(highlights).toEqual([]);
    expect(dropped).toEqual([
      { id: id("hl", 1), reason: "not_selected" },
      { id: id("hl", 2), reason: "not_selected" },
    ]);
  });

  it("a highlight losing its only spot is dropped and the spot loses the highlight id", () => {
    const before = [spot(1, north(3))];
    const first = mapHighlights([poi(1)], before, ctx);
    expect(highlightIdsBySpot(first.highlights, before).get(id("sp", 1))).toEqual([id("hl", 1)]);

    // the spot is excluded in the next build
    const after = [spot(1, north(3), { excluded: true })];
    const second = mapHighlights([poi(1)], after, ctx);
    expect(second.highlights).toEqual([]);
    expect(second.dropped).toEqual([{ id: id("hl", 1), reason: "not_selected" }]);
    expect(highlightIdsBySpot(second.highlights, after).get(id("sp", 1))).toEqual([]);
  });

  it("highlightIdsBySpot inverts spotIds in the spot's rank order and gives an excluded spot none", () => {
    const spots = [spot(1, ORIGIN), spot(2, north(0.5), { excluded: true })];
    const near = poi(1, { position: north(1), selectedBy: [[1, 1.8], [2, 1]] });
    const far = poi(2, { position: north(4), name: "Kloster", selectedBy: [[1, 7.4], [2, 6.5]] });
    const { highlights } = mapHighlights([far, near], spots, ctx);
    // the spot ranks the far one first (its selection order), not the near one
    const ranked = [{ ...spots[0]!, ranked: [id("hl", 2), id("hl", 1)] }, spots[1]!];
    const bySpot = highlightIdsBySpot(highlights, ranked);
    expect(bySpot.get(id("sp", 1))).toEqual([id("hl", 2), id("hl", 1)]);
    // without a ranking (no derived.highlights): by id
    expect(highlightIdsBySpot(highlights, spots).get(id("sp", 1))).toEqual([id("hl", 1), id("hl", 2)]);
    expect(bySpot.get(id("sp", 2))).toEqual([]);
    // even a hand-built highlight naming an excluded spot leaves the excluded spot without highlights
    const forced = highlightIdsBySpot([{ ...highlights[0]!, spotIds: [id("sp", 2)] }], spots);
    expect(forced.get(id("sp", 2))).toEqual([]);
  });

  it("two 'Taverna Nikos' 300 m apart merge into the more important one", () => {
    const a = poi(2, { importance: 2, position: ORIGIN, selectedBy: [[2, 25.9]] });
    const b = poi(1, { importance: 3, position: north(300 / 1852), name: "TAVERNA  Nikos!", selectedBy: [[1, 4.0]] });
    const spots = [spot(1, north(-2)), spot(2, north(14))];
    const { highlights, dropped } = mapHighlights([a, b], spots, ctx);
    expect(highlights.map((h) => h.id)).toEqual([id("hl", 1)]);
    expect(dropped).toEqual([{ id: id("hl", 2), reason: "duplicate", into: id("hl", 1) }]);
    // the union of both spot lists, re-sorted by distance; the selectors carry the duplicate's spots too
    expect(highlights[0]!.spotIds).toEqual([id("sp", 1), id("sp", 2)]);
  });

  it("equal importance keeps the smaller id; 600 m apart or another name stays separate", () => {
    // spot 2 selects hl 2 only
    const spots = [spot(1, north(1)), spot(2, north(-9.9))];
    const same = mapHighlights([poi(2, { selectedBy: [[1, 1.8], [2, 18.3]] }), poi(1, { position: north(300 / 1852) })], spots, ctx);
    expect(same.dropped).toEqual([{ id: id("hl", 2), reason: "duplicate", into: id("hl", 1) }]);
    expect(same.highlights[0]!.spotIds).toEqual([id("sp", 1), id("sp", 2)]);
    expect(same.selectors.get(id("hl", 1))).toEqual([id("sp", 1), id("sp", 2)]);
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
