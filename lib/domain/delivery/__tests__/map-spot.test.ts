import { describe, expect, it } from "vitest";
import type { SpotBody } from "@/contract";
import { spotSchema } from "@/contract/v1";
import { loadConfig } from "@/lib/config";
import { excludeValue } from "@/lib/domain/consolidation/exclude";
import type { AttributeProvenance, ProfileSnapshot, ProvenanceOrigin } from "@/lib/domain/consolidation/types";
import { provenanceEntry } from "@/test/consolidation";
import { SPOT_A_ATTRIBUTES, SPOT_A_SUMMARY, spotAProvenance } from "@/test/fixtures/delivery/area";
import { mapSpot, SPOT_FIELDS, type SpotWarning } from "../map-spot";
import type { SpotSource } from "../types";
import { aggregateProvenance, combineSource, ORIGIN } from "../vocab";

const cfg = loadConfig("config").delivery;
const FACT_ID = "01a15602-0000-7000-8000-000000000001";
/** The quote of the fixture's text fact (test/consolidation.ts); it must never reach a contract object. */
const QUOTE = "good holding in sand";
const HL = "hl_01J9ZD00000000000000000001";
const RG = "rg_01J9ZD00000000000000000001";

function profile(attributes: Record<string, unknown>, provenance: Record<string, AttributeProvenance>, patch: Partial<ProfileSnapshot> = {}): ProfileSnapshot {
  return {
    version: 1,
    validFrom: "2026-10-19",
    attributes,
    provenance,
    conflicts: [],
    gaps: [],
    sourcesCount: 3,
    documentsCount: 1,
    confidence: 0.72,
    contentHash: "h",
    rulesVersion: "test",
    factSchemaVersion: "v2",
    ...patch,
  };
}

/** Spot A of the delivery fixture as the loader returns it, with `patch` applied to its attributes. */
function spotA(
  o: {
    attributes?: Record<string, unknown>;
    drop?: string[];
    provenance?: Record<string, AttributeProvenance>;
    profile?: Partial<ProfileSnapshot>;
    src?: Partial<SpotSource>;
  } = {},
): SpotSource {
  const attributes: Record<string, unknown> = { ...SPOT_A_ATTRIBUTES, anchor_position: { lon: 21.130104, lat: 35.144501 }, ...o.attributes };
  const provenance: Record<string, AttributeProvenance> = { ...spotAProvenance(FACT_ID), ...o.provenance };
  for (const key of o.drop ?? []) {
    delete attributes[key];
    delete provenance[key];
  }
  return {
    placeId: "p",
    geoObjectId: "g",
    publicId: "sp_01J9ZD00000000000000000001",
    kind: "anchorage",
    status: "confirmed",
    statusReason: null,
    position: { lon: 21.1300004, lat: 35.1449996 },
    name: "Vathi Bay",
    names: [
      { lang: "el", name: "Όρμος Βαθύ", script: "greek" },
      { lang: "en", name: "Vathi Bay", script: "latin" },
    ],
    osmId: "way/123456789",
    wikidataId: null,
    profile: profile(attributes, provenance, o.profile),
    summary: SPOT_A_SUMMARY,
    popularity: 0.55,
    sources: [
      { url: "https://example-toernbericht.de/vathi", docType: "trip_report", observedAt: "2025-06-10" },
      { url: "https://example-revierfuehrer.com/vathi", docType: "pilot_guide", observedAt: "2024-01-01" },
    ],
    ...o.src,
  };
}

const ctx: { regionId: string | null; highlightIds: string[]; cfg: typeof cfg } = { regionId: RG, highlightIds: [HL], cfg };

function mappedWithWarnings(src: SpotSource = spotA(), c: Partial<typeof ctx> = {}): { spot: SpotBody; warnings: SpotWarning[] } {
  const result = mapSpot(src, { ...ctx, ...c });
  if (!("spot" in result)) throw new Error(`omitted: ${result.omitted}`);
  return result;
}

function mapped(src: SpotSource = spotA(), c: Partial<typeof ctx> = {}): SpotBody {
  return mappedWithWarnings(src, c).spot;
}

const parses = (spot: SpotBody) => spotSchema.safeParse({ ...spot, profileVersion: 1, validFrom: "2026-10-19" }).error?.issues;
const MILITARY = "restricted:military:01a15602-0000-7000-8000-0000000000cc";
const SECTOR_KEYS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"].map((s) => `shelter.${s}`);

const marina = (attributes: Record<string, unknown> = {}) =>
  spotA({ attributes: { "place.kind": "marina", ...attributes }, src: { kind: "marina" } });

/** One case per contract field (`SPOT_FIELDS`); the Record type makes a missing field a compile error. */
const FIELD_CASES: Record<keyof SpotBody, () => void> = {
  id: () => expect(mapped().id).toBe("sp_01J9ZD00000000000000000001"),
  kind: () => expect(mapped().kind).toBe("anchorage"),
  name: () => expect(mapped().name).toBe("Vathi Bay"),
  names: () => {
    expect(mapped().names).toEqual(spotA().names);
    expect(mapped(spotA({ src: { names: [] } })).names).toBeUndefined();
  },
  position: () => expect(mapped().position).toEqual({ lat: 35.145, lon: 21.13 }),
  anchorPosition: () => expect(mapped().anchorPosition).toEqual({ lat: 35.1445, lon: 21.1301, confidence: 0.6, source: "computed" }),
  shelter: () => expect(mapped().shelter.sectors.NW).toBe(0.95),
  depth: () => {
    expect(mapped().depth).toEqual({ min: 2, max: 14, anchoring: { min: 4, max: 8 }, confidence: 0.8, source: "computed" });
    const none = mapped(spotA({ drop: ["depth.min", "depth.max", "depth.anchoring_min", "depth.anchoring_max"] }));
    expect(none.depth).toBeUndefined();
    const partial = mapped(spotA({ drop: ["depth.min", "depth.max"], provenance: { "depth.anchoring_min": provenanceEntry("text", { confidence: 0.4 }) } }));
    expect(partial.depth).toEqual({ min: null, max: null, anchoring: { min: 4, max: 8 }, confidence: 0.4, source: "computed+text" });
  },
  seabed: () => expect(mapped().seabed).toEqual([{ type: "sand", share: 0.7 }, { type: "weed", share: 0.3 }]),
  holding: () => {
    expect(mapped().holding).toBe("good");
    expect(mapped(spotA({ attributes: { holding: "moderate" } })).holding).toBe("fair");
    expect(mapped(spotA({ drop: ["holding"] })).holding).toBe("unknown");
  },
  limits: () => {
    expect(mapped().limits).toEqual({ maxDraft: null, maxLength: null, capacity: 8 });
    expect(mapped(spotA({ attributes: { max_draft: 2.5, max_length: 15 } })).limits).toEqual({ maxDraft: 2.5, maxLength: 15, capacity: 8 });
  },
  mooring: () => {
    expect(mapped().mooring).toEqual({ types: ["anchor", "lineAshore"], buoys: 0, lineAshoreRequired: false });
    const more = mapped(spotA({ attributes: { "mooring.types": ["pontoon", "stern_to", "buoy"], "mooring.buoys": { present: true, count: 12, paid: true } } }));
    expect(more.mooring).toEqual({ types: ["buoy", "sternTo"], buoys: 12, lineAshoreRequired: false });
    const unknownCount = mapped(spotA({ attributes: { "mooring.buoys": { present: true, count: null, paid: null } } }));
    expect(unknownCount.mooring!.buoys).toBeNull();
    expect(mapped(spotA({ drop: ["mooring.types", "mooring.buoys", "mooring.line_ashore_required"] })).mooring).toBeUndefined();
  },
  services: () =>
    expect(mapped().services).toEqual({
      water: "no",
      electricity: "unknown",
      fuel: "unknown",
      showers: "unknown",
      shop: "unknown",
      taverna: "seasonal",
      wifi: "unknown",
      dinghyLanding: "yes",
    }),
  berth: () => {
    expect(mapped().berth).toEqual({ status: "unknown", months: [], sourcesCount: 0, bookable: null });
    expect(mapped(marina()).berth).toEqual({ status: "seasonFull", months: [7, 8], sourcesCount: 1, bookable: null });
  },
  occupancy: () => {
    expect(mapped().occupancy).toEqual([
      { month: 7, level: "full" },
      { month: 8, level: "full" },
      { month: 9, level: "moderate" },
    ]);
    expect(mapped(spotA({ drop: ["occupancy"] })).occupancy).toBeUndefined();
  },
  exclude: () => expect(mapped().exclude).toEqual({ excluded: false, reason: null, detail: null }),
  hazards: () => expect(mapped().hazards).toEqual([{ kind: "rock", text: "Fels: Petra" }]),
  seasonNote: () => expect(mapped().seasonNote).toEqual([{ months: [6, 7, 8, 9], text: "Geöffnet" }]),
  score: () =>
    expect(mapped().score).toEqual({ confidence: 0.72, popularity: 0.55, quietness: 0.8, sourcesCount: 3, lastObserved: "2025-06-10" }),
  highlightIds: () => {
    expect(mapped().highlightIds).toEqual([HL]);
    expect(mapped(spotA(), { highlightIds: [] }).highlightIds).toEqual([]);
  },
  externalRefs: () => expect(mapped().externalRefs).toEqual({ googlePlaceIds: {}, osmId: "way/123456789", wikidataId: null }),
  summary: () => {
    expect(mapped().summary).toEqual({ de: SPOT_A_SUMMARY });
    expect(mapped(spotA({ src: { summary: null } })).summary).toBeUndefined();
  },
  sources: () =>
    expect(mapped().sources).toEqual([
      { url: "https://example-toernbericht.de/vathi", kind: "tripReport", observedAt: "2025-06-10" },
      { url: "https://example-revierfuehrer.com/vathi", kind: "pilotGuide", observedAt: "2024-01-01" },
    ]),
  provenance: () =>
    expect(Object.keys(mapped().provenance).sort()).toEqual(
      [
        "anchorPosition",
        "depth",
        "exclude",
        "hazards",
        "limits",
        "mooring",
        "occupancy",
        "seabed",
        "seasonNote",
        "services.dinghyLanding",
        "services.taverna",
        "services.water",
        "shelter",
        "holding",
      ].sort(),
    ),
  regionId: () => {
    expect(mapped().regionId).toBe(RG);
    expect(mapped(spotA(), { regionId: null }).regionId).toBeNull();
  },
  mergedInto: () => expect(mapped().mergedInto).toBeNull(),
};

describe("mapSpot", () => {
  it.each(Object.keys(SPOT_FIELDS) as Array<keyof SpotBody>)("maps the contract field %s", (field) => {
    expect(FIELD_CASES[field], `no test case for ${field}`).toBeTypeOf("function");
    expect(SPOT_FIELDS[field].note.length).toBeGreaterThan(0);
    FIELD_CASES[field]();
  });

  it("the field table covers exactly the contract fields", () => {
    const contractFields = Object.keys(spotSchema.shape).filter((k) => k !== "profileVersion" && k !== "validFrom");
    expect(Object.keys(SPOT_FIELDS).sort()).toEqual(contractFields.sort());
  });

  it("the Teil-B-like spot A parses as a contract spot", () => {
    const spot = { ...mapped(), profileVersion: 1, validFrom: "2026-10-19" };
    expect(spotSchema.safeParse(spot).error?.issues).toBeUndefined();
  });

  it("without a profile the spot is omitted as no_profile", () => {
    expect(mapSpot({ ...spotA(), profile: null }, ctx)).toEqual({ omitted: "no_profile" });
  });

  it("a spot without a valid name is omitted as no_name (ruling M6-B-R1)", () => {
    expect(mapSpot(spotA({ src: { name: "" } }), ctx)).toEqual({ omitted: "no_name" });
    expect(mapSpot(spotA({ src: { name: "  " } }), ctx)).toEqual({ omitted: "no_name" });
  });

  it("an excluded spot without a valid name is delivered as 'Ankerplatz ohne Namen' with a warning (ruling M6-C-R1)", () => {
    const { spot, warnings } = mappedWithWarnings(spotA({ src: { name: "  ", status: "no_anchoring", statusReason: MILITARY } }));
    expect(spot.name).toBe("Ankerplatz ohne Namen");
    expect(spot.exclude).toMatchObject({ excluded: true, reason: "military" });
    expect(warnings).toContainEqual({ code: "fallback_name" });
    expect(parses(spot)).toBeUndefined();
    // also without a profile
    const bare = mappedWithWarnings({ ...spotA({ src: { name: "", status: "no_anchoring", statusReason: MILITARY } }), profile: null });
    expect(bare.spot.name).toBe("Ankerplatz ohne Namen");
  });

  it("a zero-filled excluded spot names the rule's origin as its shelter source (ruling M6-B-R3)", () => {
    const { spot } = mappedWithWarnings({ ...spotA({ src: { status: "no_anchoring", statusReason: MILITARY } }), profile: null });
    expect(spot.shelter.source).toBe(ORIGIN.rule);
    // a sector of its own provenance names that one
    const gap = mapped(spotA({ drop: ["shelter.W"], src: { status: "no_anchoring", statusReason: MILITARY } }));
    expect(gap.shelter.source).toBe("computed+text");
  });

  it("a profile exclude false with place status no_anchoring is excluded, reason from the status (I-1)", () => {
    // the admin's no_anchoring decision is newer than the last consolidation
    const military = mapped(spotA({ src: { status: "no_anchoring", statusReason: MILITARY } }));
    expect(military.exclude).toEqual({ excluded: true, reason: "military", detail: "Militärisches Sperrgebiet" });
    const review = mapped(spotA({ src: { status: "no_anchoring", statusReason: "review" } }));
    expect(review.exclude).toEqual({ excluded: true, reason: "anchoringProhibited", detail: "Ankerverbot" });
    // the profile's reason comes first
    const both = spotA({ attributes: { exclude: { excluded: true, reason: "cable", detail: null } }, src: { status: "no_anchoring", statusReason: MILITARY } });
    expect(mapped(both).exclude.reason).toBe("cable");
    // a stale excluded profile on a confirmed place stays excluded (safe direction)
    expect(mapped(spotA({ attributes: { exclude: { excluded: true, reason: "military", detail: null } } })).exclude.excluded).toBe(true);
  });

  it("an excluded spot without a profile is delivered with shelter 0 and the note (I-2)", () => {
    const { spot, warnings } = mappedWithWarnings({ ...spotA({ src: { status: "no_anchoring", statusReason: MILITARY } }), profile: null });
    expect(spot.exclude).toEqual({ excluded: true, reason: "military", detail: "Militärisches Sperrgebiet (ausgeschlossen – keine Schutzwerte)" });
    expect(spot.shelter).toEqual({ sectors: { N: 0, NE: 0, E: 0, SE: 0, S: 0, SW: 0, W: 0, NW: 0 }, swell: 0, source: "computed" });
    expect(spot.score).toEqual({ confidence: 0, popularity: 0.55, quietness: null, sourcesCount: 0, lastObserved: null });
    expect(spot.provenance).toEqual({});
    expect(warnings).toEqual([]);
    expect(parses(spot)).toBeUndefined();
  });

  it("an excluded spot with a shelter gap is delivered, the missing sector 0; a confirmed one is omitted (I-2)", () => {
    const gap = { drop: ["shelter.W"], src: { status: "no_anchoring" as const, statusReason: MILITARY } };
    const spot = mapped(spotA(gap));
    expect(spot.shelter.sectors).toEqual({ N: 0.9, NE: 0.8, E: 0.4, SE: 0.1, S: 0.2, SW: 0.7, W: 0, NW: 0.95 });
    expect(spot.shelter.source).toBe("computed+text");
    expect(spot.exclude.detail).toBe("Militärisches Sperrgebiet (ausgeschlossen – keine Schutzwerte)");
    expect(parses(spot)).toBeUndefined();
    // excluded by a year-round text ban only: delivered too
    const banned = spotA({ drop: ["shelter.W"], attributes: { prohibitions: [{ kind: "anchoring", months: null }] } });
    expect(mapped(banned).exclude).toMatchObject({ excluded: true, reason: "anchoringProhibited" });
    // a sector without provenance is a gap for a confirmed spot
    const unproven = spotA();
    delete unproven.profile!.provenance["shelter.W"];
    expect(mapSpot(unproven, ctx)).toEqual({ omitted: "shelter_incomplete" });
  });

  it("an excluded spot with a sector without provenance keeps the value and warns", () => {
    const src = spotA({ src: { status: "no_anchoring", statusReason: MILITARY } });
    for (const key of SECTOR_KEYS) delete src.profile!.provenance[key];
    delete src.profile!.provenance["swell_protection"];
    const { spot, warnings } = mappedWithWarnings(src);
    expect(spot.shelter).toEqual({ sectors: { N: 0.9, NE: 0.8, E: 0.4, SE: 0.1, S: 0.2, SW: 0.7, W: 0.9, NW: 0.95 }, swell: 0.5, source: "computed" });
    expect(spot.exclude.detail).toBe("Militärisches Sperrgebiet");
    expect(warnings).toEqual([{ code: "missing_provenance", field: "shelter" }]);
  });

  it("a value without provenance drops anchorPosition and depth with a warning (M-6)", () => {
    const src = spotA();
    delete src.profile!.provenance["anchor_position"];
    delete src.profile!.provenance["depth.max"];
    const { spot, warnings } = mappedWithWarnings(src);
    expect(spot.anchorPosition).toBeUndefined();
    expect(spot.depth).toBeUndefined();
    expect(spot.provenance["anchorPosition"]).toBeUndefined();
    expect(spot.provenance["depth"]).toBeUndefined();
    expect(warnings).toEqual([
      { code: "missing_provenance", field: "anchorPosition" },
      { code: "missing_provenance", field: "depth" },
    ]);
    expect(mappedWithWarnings().warnings).toEqual([]);
  });

  it("a computed cable area adds the hazard cable (M-1)", () => {
    const cableArea = { kind: "cable", restrictedAreaId: "01a15602-0000-7000-8000-0000000000dd", sourceRef: null, share: 0.1, anchoringBan: false };
    const s = mapped(spotA({ attributes: { prohibitions: [cableArea] }, provenance: { prohibitions: provenanceEntry("computed", { confidence: 0.9 }) } }));
    expect(s.hazards).toEqual([
      { kind: "cable", text: "Kabel" },
      { kind: "rock", text: "Fels: Petra" },
    ]);
    expect(s.provenance["hazards"]).toMatchObject({ source: "text", confidence: 0.7 });
    expect(s.exclude.excluded).toBe(false);
    // a military area is no hazard (it is in coast.geojson)
    const military = { ...cableArea, kind: "military" };
    expect(mapped(spotA({ attributes: { prohibitions: [military] } })).hazards).toEqual([{ kind: "rock", text: "Fels: Petra" }]);
  });

  it("an anchoring ban naming all twelve months is year-round (M-2)", () => {
    const months = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
    const s = mapped(spotA({ attributes: { prohibitions: [{ kind: "anchoring", months }] } }));
    expect(s.exclude).toEqual({ excluded: true, reason: "anchoringProhibited", detail: "Ankerverbot" });
    expect(s.seasonNote).toEqual([{ months: [6, 7, 8, 9], text: "Geöffnet" }]);
  });

  it("a hazard of an unknown kind is delivered as other, never dropped (M-3)", () => {
    const s = mapped(spotA({ attributes: { hazards: [{ kind: "sandbank", name: "Ammos" }, { kind: "mystery", name: null }] } }));
    expect(s.hazards).toEqual([
      { kind: "other", text: "Gefahr" },
      { kind: "other", text: "Gefahr: Ammos" },
    ]);
  });

  it("kind mooring_field maps to mooringField", () => {
    expect(mapped(spotA({ attributes: { "place.kind": "mooring_field" } })).kind).toBe("mooringField");
    // without the identity key the place row's kind counts
    expect(mapped(spotA({ drop: ["place.kind"], src: { kind: "mooring_field" } })).kind).toBe("mooringField");
  });

  it("shelter: eight sectors and swell, source computed+text when one sector is text-corrected", () => {
    expect(mapped().shelter).toEqual({ sectors: { N: 0.9, NE: 0.8, E: 0.4, SE: 0.1, S: 0.2, SW: 0.7, W: 0.9, NW: 0.95 }, swell: 0.5, source: "computed+text" });
    // without swell protection: the minimum of the sectors
    expect(mapped(spotA({ drop: ["swell_protection"] })).shelter.swell).toBe(0.1);
  });

  it("a missing sector omits the spot as shelter_incomplete", () => {
    expect(mapSpot(spotA({ drop: ["shelter.W"] }), ctx)).toEqual({ omitted: "shelter_incomplete" });
  });

  it("a marina has no anchorPosition", () => {
    expect(mapped(marina()).anchorPosition).toBeUndefined();
    expect(mapped(marina()).provenance["anchorPosition"]).toBeUndefined();
    expect(mapped(spotA({ drop: ["anchor_position"] })).anchorPosition).toBeUndefined();
  });

  it("taverna yes with an 'open' season note becomes seasonal; missing services are unknown", () => {
    const s = mapped(spotA({ attributes: { "highlight.supply": { present: true, names: [] }, "services.fuel": true } }));
    expect(s.services).toMatchObject({ taverna: "seasonal", shop: "seasonal", fuel: "yes", electricity: "unknown" });
    const allYear = mapped(spotA({ drop: ["derived.season"] }));
    expect(allYear.services!.taverna).toBe("yes");
    const none = mapped(spotA({ attributes: { "highlight.food": { present: false, names: [] } } }));
    expect(none.services!.taverna).toBe("no");
  });

  it("berth of a marina full in Jul and Aug is seasonFull [7, 8]", () => {
    expect(mapped(marina()).berth).toMatchObject({ status: "seasonFull", months: [7, 8] });
    expect(mapped(marina({ occupancy: { "6": "moderate", "7": "empty" } })).berth!.status).toBe("usuallySpace");
    expect(mapped(spotA({ attributes: { "place.kind": "port" }, drop: ["occupancy"] })).berth).toEqual({ status: "unknown", months: [], sourcesCount: 0, bookable: null });
  });

  it("no_anchoring with status reason firing_area is excluded as military with German detail", () => {
    const statusReason = "restricted:firing_area:01a15602-0000-7000-8000-0000000000aa";
    const src = spotA({ attributes: { exclude: excludeValue("no_anchoring", statusReason) }, src: { status: "no_anchoring", statusReason } });
    expect(mapped(src).exclude).toEqual({ excluded: true, reason: "military", detail: "Militärisches Sperrgebiet" });
    // a profile without the identity key falls back to the place's status
    const noKey = spotA({ drop: ["exclude"], src: { status: "no_anchoring", statusReason } });
    expect(mapped(noKey).exclude).toEqual({ excluded: true, reason: "military", detail: "Militärisches Sperrgebiet" });
  });

  it("a year-round anchoring prohibition excludes as anchoringProhibited", () => {
    const banned = mapped(spotA({ attributes: { prohibitions: [{ kind: "anchoring", months: null }] }, provenance: { prohibitions: provenanceEntry("text", { confidence: 0.6 }) } }));
    expect(banned.exclude).toEqual({ excluded: true, reason: "anchoringProhibited", detail: "Ankerverbot" });
    expect(banned.provenance["exclude"]).toMatchObject({ source: "text", confidence: 0.6 });
    // a seasonal ban is a season note, no exclusion
    const seasonal = mapped(spotA({ attributes: { prohibitions: [{ kind: "anchoring", months: [7, 8] }, { kind: "fishing", months: null }] } }));
    expect(seasonal.exclude.excluded).toBe(false);
    expect(seasonal.seasonNote).toEqual([
      { months: [6, 7, 8, 9], text: "Geöffnet" },
      { months: [7, 8], text: "Ankerverbot" },
    ]);
  });

  it("hazard rock 'Petra' becomes { kind: 'rock', text: 'Fels: Petra' }", () => {
    const s = mapped(
      spotA({
        attributes: {
          hazards: [{ kind: "swell", name: null }, { kind: "rock", name: "Petra" }, { kind: "fish_farm", name: null }],
          prohibitions: [{ kind: "ferry_lane", restrictedAreaId: "01a15602-0000-7000-8000-0000000000bb", sourceRef: null, share: 0.2, anchoringBan: false }],
        },
      }),
    );
    expect(s.hazards).toEqual([
      { kind: "ferryTraffic", text: "Fährkorridor in der Nähe" },
      { kind: "fishFarm", text: "Fischfarm" },
      { kind: "rock", text: "Fels: Petra" },
      { kind: "swellEntry", text: "Schwell läuft ein" },
    ]);
    expect(mapped(spotA({ drop: ["hazards"] })).hazards).toBeUndefined();
  });

  it("confidence 0.25 appends 'wenig belegt' to the summary", () => {
    expect(mapped(spotA({ profile: { confidence: 0.25 } })).summary).toEqual({ de: `${SPOT_A_SUMMARY} (wenig belegt)` });
    expect(mapped(spotA({ profile: { confidence: 0.25 }, src: { summary: "Kaum Angaben, wenig belegt." } })).summary).toEqual({ de: "Kaum Angaben, wenig belegt." });
    expect(mapped(spotA({ profile: { confidence: null }, src: { summary: null } })).summary).toEqual({ de: "Wenig belegt." });
    expect(mapped(spotA({ profile: { confidence: null } })).score.confidence).toBe(0);
  });

  it("a navily.com source is dropped and kinds are camelCase", () => {
    const s = mapped(
      spotA({
        src: {
          sources: [
            { url: "https://www.navily.com/port/vathi", docType: "forum", observedAt: "2026-07-01" },
            { url: "upload://" + "a".repeat(64), docType: "pilot_guide", observedAt: "2026-06-01" },
            { url: "https://maps.google.com/?q=vathi", docType: "other", observedAt: "2026-05-01" },
            { url: "https://example.org/reise", docType: "travel_guide", observedAt: "2025-01-01" },
            { url: "https://example.org/bericht", docType: "trip_report", observedAt: "2026-04-01" },
          ],
        },
      }),
    );
    expect(s.sources).toEqual([
      { url: "https://example.org/bericht", kind: "tripReport", observedAt: "2026-04-01" },
      { url: "https://example.org/reise", kind: "travelGuide", observedAt: "2025-01-01" },
    ]);
    // the values of such a document must not ship: the mapper reports its links to the validation (ruling M6-D-R2)
    const result = mapSpot(
      spotA({
        src: {
          sources: [
            { url: "https://www.navily.com/port/vathi", docType: "forum", observedAt: "2026-07-01" },
            { url: "https://navily.com./port/vathi", docType: "forum", observedAt: "2026-07-01" },
            { url: "https://example.org/bericht", docType: "trip_report", observedAt: "2026-04-01" },
          ],
        },
      }),
      ctx,
    );
    expect("spot" in result && result.forbiddenSources).toEqual(["https://navily.com./port/vathi", "https://www.navily.com/port/vathi"]);
    expect(mapSpot(spotA(), ctx)).toMatchObject({ forbiddenSources: [] });
    const many = Array.from({ length: cfg.spots.maxSources + 5 }, (_, i) => ({ url: `https://example.org/${i}`, docType: "forum" as const, observedAt: "2026-01-01" }));
    expect(mapped(spotA({ src: { sources: many } })).sources).toHaveLength(cfg.spots.maxSources);
    expect(mapped(spotA({ src: { sources: [] } })).sources).toBeUndefined();
  });

  it("provenance.shelter takes text when any sector is text, the minimum confidence and the latest date", () => {
    const s = mapped(spotA({ provenance: { "shelter.SE": provenanceEntry("computed", { confidence: 0.3, observedAt: "2026-10-05" }) } }));
    expect(s.provenance["shelter"]).toEqual({ source: "text", confidence: 0.3, observedAt: "2026-10-05" });
    expect(s.provenance["anchorPosition"]).toEqual({ source: "computed", confidence: 0.6, observedAt: "2026-10-01" });
    expect(s.provenance["services.taverna"]).toEqual({ source: "text", confidence: 0.7, observedAt: "2025-06-10" });
  });

  it("never copies a quote: no field of the mapped spot contains a fact quote", () => {
    const s = mapped(spotA({ provenance: { holding: provenanceEntry("text", { factIds: [FACT_ID], conflictKey: QUOTE }) } }));
    expect(JSON.stringify(s)).not.toContain(QUOTE);
    expect(JSON.stringify(s)).not.toContain(FACT_ID);
  });
});

describe("delivery vocabulary", () => {
  it.each(Object.entries(ORIGIN))("origin %s maps to the contract source %s", (origin, source) => {
    const expected: Record<ProvenanceOrigin, string> = {
      computed: "computed",
      rule: "computed",
      gazetteer: "computed",
      derived: "computed",
      text: "text",
      observed: "observed",
      review: "review",
    };
    expect(source).toBe(expected[origin as ProvenanceOrigin]);
  });

  it("combineSource joins the distinct contract origins in contract order", () => {
    expect(combineSource(["text", "rule", "computed", "text"])).toBe("computed+text");
    expect(combineSource(["review", "observed", "derived"])).toBe("computed+observed+review");
    expect(() => combineSource([])).toThrow();
  });

  it("aggregateProvenance: review before observed before text before computed, minimum confidence, latest date", () => {
    expect(
      aggregateProvenance([
        provenanceEntry("computed", { confidence: 0.9, observedAt: "2026-10-01" }),
        provenanceEntry("observed", { confidence: 0.4, observedAt: null }),
        provenanceEntry("text", { confidence: 0.7, observedAt: "2026-06-01" }),
      ]),
    ).toEqual({ source: "observed", confidence: 0.4, observedAt: "2026-10-01" });
    expect(aggregateProvenance([provenanceEntry("gazetteer", { confidence: 1 })])).toEqual({ source: "computed", confidence: 1, observedAt: null });
  });
});
