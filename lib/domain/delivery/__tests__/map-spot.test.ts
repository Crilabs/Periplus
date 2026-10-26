import { describe, expect, it } from "vitest";
import type { SpotBody } from "@/contract/v2";
import { spotSchema } from "@/contract/v2";
import { loadConfig } from "@/lib/config";
import type { BerthStateFact, BerthStateNearby, BerthStateValue } from "@/lib/db/schema/research-state";
import { provenanceEntry } from "@/test/consolidation";
import { spotACore } from "@/test/fixtures/delivery/subdivision";
import { factPublicId } from "../map-facts";
import { mapSpot, SPOT_FIELDS, type SpotWarning } from "../map-spot";
import type { NearbyObject, SpotSource } from "../types";
import { aggregateProvenance, combineSource, ORIGIN, type ProvenanceOrigin } from "../vocab";

const cfg = loadConfig("config").delivery;
const FACT_ID = "01a15602-0000-7000-8000-000000000001";
const FACT_2 = "01a15602-0000-7000-8000-000000000002";
const FACT_3 = "01a15602-0000-7000-8000-000000000003";
const FACT_4 = "01a15602-0000-7000-8000-000000000004";
const RG = "rg_01J9ZD00000000000000000001";
const TAVERNA = "hl_01J9ZD00000000000000000001";
const SHOP = "hl_01J9ZD00000000000000000002";
const MILITARY = "restricted:military:01a15602-0000-7000-8000-0000000000cc";
const UPDATED = new Date("2026-10-20T08:00:00Z");

const coreValue = (value: unknown, patch: Partial<BerthStateValue> = {}): BerthStateValue => ({
  value,
  confidence: 0.8,
  origin: "computed",
  observedAt: "2026-10-01",
  factIds: [],
  ...patch,
});

const fact = (patch: Partial<BerthStateFact> = {}): BerthStateFact => ({
  factId: FACT_2,
  subject: "berth",
  subjectName: null,
  subjectCategory: null,
  statement: "Strong gusts come down the valley in the afternoon.",
  observedAt: "2025-06-10",
  tone: "negative",
  safety: false,
  mentions: 2,
  ...patch,
});

const object = (patch: Partial<NearbyObject> = {}): NearbyObject => ({
  geoObjectId: "g-taverna",
  publicId: TAVERNA,
  name: "Taverna Vathi",
  names: [
    { lang: "el", name: "Ταβέρνα Βαθύ", script: "greek" },
    { lang: "en", name: "Taverna Vathi", script: "latin" },
  ],
  position: { lon: 21.13, lat: 35.1283334 },
  ...patch,
});
const nearbyEntry = (patch: Partial<BerthStateNearby> = {}): BerthStateNearby => ({ geoObjectId: "g-taverna", category: "food", distanceM: 1852.4, access: "foot", ...patch });

/** Spot A of the delivery fixture as the loader returns it: its state (core, gaps, facts, landing, nearby) with `patch` applied. */
function spotA(
  o: {
    core?: Record<string, BerthStateValue>;
    drop?: string[];
    state?: Partial<NonNullable<SpotSource["state"]>> | null;
    src?: Partial<SpotSource>;
  } = {},
): SpotSource {
  const core: Record<string, BerthStateValue> = { ...spotACore(FACT_ID), ...o.core };
  for (const key of o.drop ?? []) delete core[key];
  return {
    placeId: "p",
    geoObjectId: "g",
    publicId: "sp_01J9ZD00000000000000000001",
    kind: "anchorage",
    status: "confirmed",
    statusReason: null,
    position: { lon: 21.1300004, lat: 35.1449996 },
    anchor: { lon: 21.130104, lat: 35.144501, confidence: 0.3 },
    name: "Vathi Bay",
    names: [
      { lang: "el", name: "Όρμος Βαθύ", script: "greek" },
      { lang: "en", name: "Vathi Bay", script: "latin" },
    ],
    osmId: "way/123456789",
    wikidataId: null,
    state:
      o.state === null
        ? null
        : { placeId: "p", core, gaps: ["prices"], facts: [], landing: [], nearby: [nearbyEntry()], runId: null, updatedAt: UPDATED, ...o.state },
    nearbyObjects: [object()],
    ownWebsiteDomain: "marina.example",
    independentSources: 1,
    popularity: 0.55,
    images: [],
    ...o.src,
  };
}

const ctx: { regionId: string | null; cfg: typeof cfg } = { regionId: RG, cfg };

function mappedWithWarnings(src: SpotSource = spotA(), c: Partial<typeof ctx> = {}): { spot: SpotBody; asOf: string | null; warnings: SpotWarning[] } {
  const result = mapSpot(src, { ...ctx, ...c });
  if (!("spot" in result)) throw new Error(`omitted: ${result.omitted}`);
  return result;
}

function mapped(src: SpotSource = spotA(), c: Partial<typeof ctx> = {}): SpotBody {
  return mappedWithWarnings(src, c).spot;
}

const parses = (spot: SpotBody, asOf: string | null = "2026-10-20") => spotSchema.safeParse({ ...spot, asOf }).error?.issues;
const excludedC = (o: Parameters<typeof spotA>[0] = {}) => spotA({ ...o, src: { status: "no_anchoring", statusReason: MILITARY, ...o.src } });
const marina = (core: Record<string, BerthStateValue> = {}) => spotA({ core: { occupancy: coreValue({ "7": "full", "8": "full" }, { origin: "text", factIds: [FACT_ID] }), ...core }, src: { kind: "marina" } });

/** One case per contract field (`SPOT_FIELDS`); the Record type makes a missing field a compile error. */
const FIELD_CASES: Record<keyof SpotBody, () => void> = {
  id: () => expect(mapped().id).toBe("sp_01J9ZD00000000000000000001"),
  kind: () => {
    expect(mapped().kind).toBe("anchorage");
    expect(mapped(spotA({ src: { kind: "mooring_field" } })).kind).toBe("mooringField");
  },
  berthable: () => {
    // the state's rule value (derived from kind and status, spec 17)
    expect(mapped().berthable).toBe(true);
    expect(mapped().provenance["berthable"]).toMatchObject({ source: "computed", confidence: 1 });
    expect(mapped(spotA({ core: { berthable: coreValue(false, { origin: "text" }) } })).berthable).toBe(false);
    expect(mapped(spotA({ drop: ["berthable"] })).berthable).toBeNull();
  },
  contact: () => {
    expect(mapped().contact).toBeNull();
    for (const url of ["javascript:alert(1)", "ftp://marina.example/x", "upload://doc"]) {
      expect(mapped(spotA({ core: { contact: coreValue({ vhf: null, phone: null, url }) } })).contact, url).toBeNull();
      expect(mapped(spotA({ core: { contact: coreValue({ vhf: "71", phone: null, url }) } })).contact, url).toEqual({ vhf: "71", phone: null, url: null });
    }
    expect(mapped(spotA({ core: { contact: coreValue({ vhf: "71", phone: "+30 22980 12345", url: "https://marina.example" }) } })).contact).toEqual({
      vhf: "71",
      phone: "+30 22980 12345",
      url: "https://marina.example",
    });
    expect(mapped(spotA({ core: { contact: coreValue({ vhf: null, phone: null, url: null }) } })).contact).toBeNull();
    // F1: only the url of the place's own bound website (registrable domain); any other is dropped with a warning
    const withUrl = (url: string, own: string | null) =>
      mappedWithWarnings(spotA({ core: { contact: coreValue({ vhf: "71", phone: null, url }) }, src: { ownWebsiteDomain: own } }));
    expect(withUrl("https://www.marina.example/en/contact", "marina.example")).toMatchObject({ spot: { contact: { vhf: "71", url: "https://www.marina.example/en/contact" } }, warnings: [] });
    for (const [url, own] of [["https://blog.example/marina-review", "marina.example"], ["https://marina.example", null], ["https://notmarina.example", "marina.example"]] as const) {
      expect(withUrl(url, own), url).toMatchObject({ spot: { contact: { vhf: "71", phone: null, url: null } }, warnings: [{ code: "contact_url_foreign" }] });
    }
    expect(mappedWithWarnings(spotA({ core: { contact: coreValue({ vhf: null, phone: null, url: "https://blog.example/x" }) } })).spot.contact).toBeNull();
  },
  name: () => expect(mapped().name).toBe("Vathi Bay"),
  names: () => {
    expect(mapped().names).toEqual(spotA().names);
    expect(mapped(spotA({ src: { names: [] } })).names).toBeUndefined();
  },
  position: () => expect(mapped().position).toEqual({ lat: 35.145, lon: 21.13 }),
  anchorPosition: () => {
    expect(mapped().anchorPosition).toEqual({ lat: 35.1445, lon: 21.1301, confidence: 0.3, source: "computed" });
    expect(mapped().provenance["anchorPosition"]).toEqual({ source: "computed", confidence: 0.3, observedAt: null });
  },
  shelter: () => expect(mapped().shelter.sectors.NW).toBe(0.95),
  depth: () => {
    expect(mapped().depth).toEqual({ min: 2, max: 14, anchoring: { min: 4, max: 8 }, confidence: 0.8, source: "computed" });
    expect(mapped(spotA({ drop: ["depth.min", "depth.max", "depth.anchoring_min", "depth.anchoring_max"] })).depth).toBeUndefined();
    const partial = mapped(spotA({ drop: ["depth.min", "depth.max"], core: { "depth.anchoring_min": coreValue(4, { origin: "text", confidence: 0.4 }) } }));
    expect(partial.depth).toEqual({ min: null, max: null, anchoring: { min: 4, max: 8 }, confidence: 0.4, source: "computed+text" });
  },
  seabed: () => expect(mapped().seabed).toEqual([{ type: "sand", share: 0.7 }, { type: "weed", share: 0.3 }]),
  holding: () => {
    expect(mapped().holding).toBe("good");
    expect(mapped(spotA({ core: { holding: coreValue("moderate") } })).holding).toBe("fair");
    expect(mapped(spotA({ drop: ["holding"] })).holding).toBe("unknown");
  },
  limits: () => {
    expect(mapped().limits).toEqual({ maxDraft: null, maxLength: null, capacity: 8 });
    expect(mapped(spotA({ core: { max_draft: coreValue(2.5), max_length: coreValue(15) } })).limits).toEqual({ maxDraft: 2.5, maxLength: 15, capacity: 8 });
  },
  mooring: () => {
    expect(mapped().mooring).toEqual({ types: ["anchor", "lineAshore"], buoys: 0, lineAshoreRequired: false });
    const more = mapped(spotA({ core: { "mooring.types": coreValue(["pontoon", "stern_to", "buoy"]), "mooring.buoys": coreValue({ present: true, count: 12, paid: true }) } }));
    expect(more.mooring).toEqual({ types: ["buoy", "sternTo"], buoys: 12, lineAshoreRequired: false });
    const unknownCount = mapped(spotA({ core: { "mooring.buoys": coreValue({ present: true, count: null, paid: null }) } }));
    expect(unknownCount.mooring!.buoys).toBeNull();
    expect(mapped(spotA({ drop: ["mooring.types", "mooring.buoys", "mooring.line_ashore_required"] })).mooring).toBeUndefined();
  },
  services: () => {
    // the taverna (food, on foot) from the things on land, in an open season; the rest from the state
    expect(mapped().services).toEqual({
      water: "no",
      electricity: "unknown",
      fuel: "unknown",
      showers: "unknown",
      shop: "unknown",
      taverna: "seasonal",
      wifi: "unknown",
      dinghyLanding: "unknown",
    });
  },
  berth: () => {
    expect(mapped().berth).toEqual({ status: "unknown", months: [], sourcesCount: 0, bookable: null });
    expect(mapped(marina()).berth).toEqual({ status: "seasonFull", months: [7, 8], sourcesCount: 1, bookable: null });
    // the independent sources of the confirmation, not the facts behind occupancy
    expect(mapped({ ...marina(), independentSources: 3 }).berth!.sourcesCount).toBe(3);
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
  score: () => {
    // the mean confidence of the 22 non-rule core values; the confirmation's independent sources, the newest text date
    expect(mapped().score).toEqual({ confidence: 0.77, popularity: 0.55, quietness: null, sourcesCount: 1, lastObserved: "2025-06-10" });
    // many facts do not raise the count; only the confirmation's sources do
    const withFacts = mapped(spotA({ state: { facts: [fact({ factId: FACT_2, observedAt: "2026-09-01", memberIds: [FACT_2, FACT_3] })] } }));
    expect(withFacts.score).toMatchObject({ sourcesCount: 1, lastObserved: "2026-09-01" });
    expect(mapped(spotA({ src: { independentSources: 4 } })).score.sourcesCount).toBe(4);
    // a spot without a state (excluded) has none, and no popularity
    expect(mapped(excludedC({ state: null, src: { popularity: 0.9 } })).score.popularity).toBe(0);
    expect(mapped(excludedC({ state: null, src: { independentSources: 4 } })).score.sourcesCount).toBe(0);
    // popularity is the loader's value, rounded to 3 decimals
    expect(mapped(spotA({ src: { popularity: 0.123456 } })).score.popularity).toBe(0.123);
  },
  externalRefs: () => expect(mapped().externalRefs).toEqual({ googlePlaceIds: {}, osmId: "way/123456789", wikidataId: null }),
  images: () => {
    expect(mapped().images).toBeUndefined();
    const image = { id: "i", slot: "title", sortOrder: 0, rank: 3, kind: "ai_illustration" as const, fileKey: "k", width: 1536, height: 1024, alt: "KI-Illustration: Bucht", light: "midday" as const, observedAt: null, license: "periplus", attribution: "x", camera: null };
    expect(mapped(spotA({ src: { images: [image] } })).images).toEqual([
      { kind: "ai_illustration", slot: "title", file: "images/sp_01J9ZD00000000000000000001-title.jpg", width: 1536, height: 1024, alt: { de: "KI-Illustration: Bucht" }, light: "midday", observedAt: null, license: "periplus", attribution: "x", camera: null },
    ]);
  },
  provenance: () =>
    expect(Object.keys(mapped().provenance).sort()).toEqual(
      [
        "anchorPosition",
        "berthable",
        "depth",
        "hazards",
        "holding",
        "limits",
        "mooring",
        "occupancy",
        "seabed",
        "seasonNote",
        "services.taverna",
        "services.water",
        "shelter",
      ].sort(),
    ),
  regionId: () => {
    expect(mapped().regionId).toBe(RG);
    expect(mapped(spotA(), { regionId: null }).regionId).toBeNull();
  },
  mergedInto: () => expect(mapped().mergedInto).toBeNull(),
  gaps: () => {
    expect(mapped().gaps).toEqual(["prices"]);
    expect(mapped(spotA({ state: { gaps: ["prices", "contact"] } })).gaps).toEqual(["contact", "prices"]);
    expect(mapped(excludedC({ state: null })).gaps).toEqual([]);
  },
  facts: () => {
    expect(mapped().facts).toEqual([]);
    expect(mapped(spotA({ state: { facts: [fact({ safety: true })] } })).facts).toEqual([
      { id: factPublicId(FACT_2), subject: { kind: "spot" }, text: "Strong gusts come down the valley in the afternoon.", observedAt: "2025-06-10", tone: "negative", safety: true, mentions: 2 },
    ]);
  },
  landingPoints: () => {
    expect(mapped().landingPoints).toEqual([]);
    const landing = [
      { kind: "beach" as const, lon: 21.1305123, lat: 35.1452, geoObjectId: null, description: null },
      { kind: "text" as const, lon: null, lat: null, geoObjectId: null, description: "Dinghy landing at the small pier" },
    ];
    expect(mapped(spotA({ state: { landing } })).landingPoints).toEqual([
      { kind: "beach", position: { lat: 35.1452, lon: 21.13051 } },
      { kind: "text", description: "Dinghy landing at the small pier" },
    ]);
  },
  nearby: () => {
    expect(mapped().nearby).toEqual([
      {
        id: TAVERNA,
        category: "food",
        name: "Taverna Vathi",
        names: object().names,
        position: { lat: 35.12833, lon: 21.13 },
        distanceM: 1852,
        access: "foot",
      },
    ]);
  },
};

describe("mapSpot", () => {
  it.each(Object.keys(SPOT_FIELDS) as Array<keyof SpotBody>)("maps the contract field %s", (field) => {
    expect(FIELD_CASES[field], `no test case for ${field}`).toBeTypeOf("function");
    expect(SPOT_FIELDS[field].note.length).toBeGreaterThan(0);
    FIELD_CASES[field]();
  });

  it("the field table covers exactly the contract fields", () => {
    const contractFields = Object.keys(spotSchema.shape).filter((k) => k !== "asOf");
    expect(Object.keys(SPOT_FIELDS).sort()).toEqual(contractFields.sort());
  });

  it("a complete state gives a valid contract spot, asOf the state's date", () => {
    const { spot, asOf } = mappedWithWarnings(spotA({ state: { facts: [fact({ safety: true })] } }));
    expect(asOf).toBe("2026-10-20");
    expect(parses(spot, asOf)).toBeUndefined();
  });

  it("carries no source, no quote and no profile or version fields", () => {
    const s = mapped(spotA({ state: { facts: [fact()] } }));
    for (const key of ["sources", "summary", "highlightIds", "highlightLevels", "profileVersion", "validFrom"]) expect(key in s, key).toBe(false);
    expect(JSON.stringify(s)).not.toMatch(/https?:|upload:/);
    expect(JSON.stringify(s)).not.toContain(FACT_ID);
  });

  it("without a state the spot is omitted as no_state", () => {
    expect(mapSpot(spotA({ state: null }), ctx)).toEqual({ omitted: "no_state" });
  });

  it("a state without a shelter sector or without the anchor of an anchorage or mooring field is omitted as incomplete_core", () => {
    expect(mapSpot(spotA({ drop: ["shelter.W"] }), ctx)).toEqual({ omitted: "incomplete_core" });
    expect(mapSpot(spotA({ src: { anchor: null } }), ctx)).toEqual({ omitted: "incomplete_core" });
    expect(mapSpot(spotA({ src: { anchor: null, kind: "mooring_field" } }), ctx)).toEqual({ omitted: "incomplete_core" });
    // a harbour's position is its position: no anchor needed, none delivered
    const harbour = mapped(spotA({ src: { anchor: null, kind: "port" } }));
    expect(harbour.anchorPosition).toBeUndefined();
    expect(mapped(marina()).anchorPosition).toBeUndefined();
    expect(mapped(marina()).provenance["anchorPosition"]).toBeUndefined();
    expect(mapSpot(marina({}), ctx)).toHaveProperty("spot");
  });

  it("a spot without a valid name is omitted as no_name (ruling M6-B-R1)", () => {
    expect(mapSpot(spotA({ src: { name: "" } }), ctx)).toEqual({ omitted: "no_name" });
    expect(mapSpot(spotA({ src: { name: "  " } }), ctx)).toEqual({ omitted: "no_name" });
  });

  it("an excluded spot without a valid name is delivered as 'Ankerplatz ohne Namen' with a warning (ruling M6-C-R1)", () => {
    const { spot, warnings } = mappedWithWarnings(excludedC({ src: { name: "  " } }));
    expect(spot.name).toBe("Ankerplatz ohne Namen");
    expect(spot.exclude).toMatchObject({ excluded: true, reason: "military" });
    expect(warnings).toContainEqual({ code: "fallback_name" });
    expect(parses(spot)).toBeUndefined();
    // also without a state
    expect(mappedWithWarnings(excludedC({ state: null, src: { name: "" } })).spot.name).toBe("Ankerplatz ohne Namen");
  });

  it("no_anchoring is delivered as excluded, without a state: shelter 0 with the note, no asOf, valid (I-2)", () => {
    const { spot, asOf, warnings } = mappedWithWarnings(excludedC({ state: null }));
    expect(spot.exclude).toEqual({ excluded: true, reason: "military", detail: "Militärisches Sperrgebiet (ausgeschlossen – keine Schutzwerte)" });
    expect(spot.shelter).toEqual({ sectors: { N: 0, NE: 0, E: 0, SE: 0, S: 0, SW: 0, W: 0, NW: 0 }, swell: 0, source: ORIGIN.rule });
    expect(spot.score).toEqual({ confidence: 0, popularity: 0, quietness: null, sourcesCount: 0, lastObserved: null });
    expect(spot.provenance).toEqual({ anchorPosition: { source: "computed", confidence: 0.3, observedAt: null } });
    expect(spot).toMatchObject({ gaps: [], facts: [], landingPoints: [], nearby: [], berthable: null });
    expect(asOf).toBeNull();
    expect(warnings).toEqual([]);
    expect(parses(spot, asOf)).toBeUndefined();
  });

  it("the reason of an excluded spot comes from the place status (I-1)", () => {
    expect(mapped(excludedC()).exclude).toEqual({ excluded: true, reason: "military", detail: "Militärisches Sperrgebiet" });
    const review = mapped(spotA({ src: { status: "no_anchoring", statusReason: "review" } }));
    expect(review.exclude).toEqual({ excluded: true, reason: "anchoringProhibited", detail: "Ankerverbot" });
    const firing = mapped(spotA({ src: { status: "no_anchoring", statusReason: "restricted:firing_area:01a15602-0000-7000-8000-0000000000aa" } }));
    expect(firing.exclude).toEqual({ excluded: true, reason: "military", detail: "Militärisches Sperrgebiet" });
  });

  it("an excluded spot with a shelter gap is delivered, the missing sector 0; a confirmed one is omitted (I-2)", () => {
    const spot = mapped(excludedC({ drop: ["shelter.W"] }));
    expect(spot.shelter.sectors).toEqual({ N: 0.9, NE: 0.8, E: 0.4, SE: 0.1, S: 0.2, SW: 0.7, W: 0, NW: 0.95 });
    expect(spot.shelter.source).toBe("computed+text");
    expect(spot.exclude.detail).toBe("Militärisches Sperrgebiet (ausgeschlossen – keine Schutzwerte)");
    expect(parses(spot)).toBeUndefined();
    // excluded by a year-round text ban only: delivered too
    const banned = spotA({ drop: ["shelter.W"], core: { prohibitions: coreValue([{ kind: "anchoring", months: null }], { origin: "text" }) } });
    expect(mapped(banned).exclude).toMatchObject({ excluded: true, reason: "anchoringProhibited" });
    expect(mapSpot(spotA({ drop: ["shelter.W"] }), ctx)).toEqual({ omitted: "incomplete_core" });
  });

  it("a computed cable area adds the hazard cable (M-1)", () => {
    const cableArea = { kind: "cable", restrictedAreaId: "01a15602-0000-7000-8000-0000000000dd", sourceRef: null, share: 0.1, anchoringBan: false };
    const s = mapped(spotA({ core: { prohibitions: coreValue([cableArea], { confidence: 0.9 }) } }));
    expect(s.hazards).toEqual([
      { kind: "cable", text: "Kabel" },
      { kind: "rock", text: "Fels: Petra" },
    ]);
    expect(s.provenance["hazards"]).toMatchObject({ source: "text", confidence: 0.7 });
    expect(s.exclude.excluded).toBe(false);
    // a military area is no hazard (it is in coast.geojson)
    expect(mapped(spotA({ core: { prohibitions: coreValue([{ ...cableArea, kind: "military" }]) } })).hazards).toEqual([{ kind: "rock", text: "Fels: Petra" }]);
  });

  it("an anchoring ban naming all twelve months is year-round (M-2); a year-round ban excludes with its provenance", () => {
    const months = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
    const s = mapped(spotA({ core: { prohibitions: coreValue([{ kind: "anchoring", months }], { origin: "text", confidence: 0.6 }) } }));
    expect(s.exclude).toEqual({ excluded: true, reason: "anchoringProhibited", detail: "Ankerverbot" });
    expect(s.provenance["exclude"]).toMatchObject({ source: "text", confidence: 0.6 });
    expect(s.seasonNote).toEqual([{ months: [6, 7, 8, 9], text: "Geöffnet" }]);
    // a seasonal ban is a season note, no exclusion
    const seasonal = mapped(spotA({ core: { prohibitions: coreValue([{ kind: "anchoring", months: [7, 8] }, { kind: "fishing", months: null }]) } }));
    expect(seasonal.exclude.excluded).toBe(false);
    expect(seasonal.seasonNote).toEqual([
      { months: [6, 7, 8, 9], text: "Geöffnet" },
      { months: [7, 8], text: "Ankerverbot" },
    ]);
  });

  it("hazards: an unknown kind is delivered as other (M-3), a ferry lane adds ferryTraffic", () => {
    const s = mapped(spotA({ core: { hazards: coreValue([{ kind: "sandbank", name: "Ammos" }, { kind: "mystery", name: null }, { kind: "rock", name: "Petra" }, { kind: "fish_farm", name: null }]) } }));
    expect(s.hazards).toEqual([
      { kind: "fishFarm", text: "Fischfarm" },
      { kind: "other", text: "Gefahr" },
      { kind: "other", text: "Gefahr: Ammos" },
      { kind: "rock", text: "Fels: Petra" },
    ]);
    const ferry = mapped(spotA({ core: { prohibitions: coreValue([{ kind: "ferry_lane", restrictedAreaId: "01a15602-0000-7000-8000-0000000000bb", sourceRef: null, share: 0.2, anchoringBan: false }]) } }));
    expect(ferry.hazards).toContainEqual({ kind: "ferryTraffic", text: "Fährkorridor in der Nähe" });
    expect(mapped(spotA({ drop: ["hazards"] })).hazards).toBeUndefined();
  });

  it("berthable comes from the state; a port is not berthable; the result validates", () => {
    const port = mapped(spotA({ src: { kind: "port" }, core: { berthable: coreValue(false, { origin: "rule", confidence: 1 }) } }));
    expect(port).toMatchObject({ kind: "port", berthable: false, contact: null });
    expect(parses(port)).toBeUndefined();
    const withContact = mapped(spotA({ core: { contact: coreValue({ vhf: "71", phone: null, url: "https://marina.example" }, { origin: "text" }) } }));
    expect(parses(withContact)).toBeUndefined();
  });

  it("shelter: eight sectors and swell, source computed+text when one sector is text-corrected", () => {
    expect(mapped().shelter).toEqual({ sectors: { N: 0.9, NE: 0.8, E: 0.4, SE: 0.1, S: 0.2, SW: 0.7, W: 0.9, NW: 0.95 }, swell: 0.5, source: "computed+text" });
    // without swell protection: the minimum of the sectors
    expect(mapped(spotA({ drop: ["swell_protection"] })).shelter.swell).toBe(0.1);
  });

  it("services: shop and taverna come from the things on land reached on foot (E5), the others from the state", () => {
    const shop: NearbyObject = object({ geoObjectId: "g-shop", publicId: SHOP, name: "Mini Market", names: [] });
    const state = (nearby: BerthStateNearby[]) => ({ nearby });
    const src = (nearby: BerthStateNearby[], core: Record<string, BerthStateValue> = {}, drop: string[] = []) =>
      spotA({ state: state(nearby), core, drop, src: { nearbyObjects: [object(), shop] } });
    // supply and bakery on foot: shop; seasonal in an open season
    for (const category of ["supply", "bakery"] as const) {
      expect(mapped(src([nearbyEntry({ geoObjectId: "g-shop", category })])).services).toMatchObject({ shop: "seasonal", taverna: "unknown" });
    }
    expect(mapped(src([nearbyEntry({ geoObjectId: "g-shop", category: "supply" })], {}, ["season_notes"])).services).toMatchObject({ shop: "yes" });
    // reached only by transport: unknown
    expect(mapped(src([nearbyEntry({ geoObjectId: "g-shop", category: "supply", access: "transport" })])).services).toMatchObject({ shop: "unknown" });
    // another category is no shop and no taverna
    expect(mapped(src([nearbyEntry({ category: "beach" })])).services).toMatchObject({ shop: "unknown", taverna: "unknown" });
    // the taverna's year-round yes without an open note; its provenance is computed
    const year = mapped(src([nearbyEntry()], {}, ["season_notes"]));
    expect(year.services!.taverna).toBe("yes");
    expect(year.provenance["services.taverna"]).toEqual({ source: "computed", confidence: 1, observedAt: null });
    // a nearby entry without a public id is no shop
    const noId = mapped(spotA({ src: { nearbyObjects: [object({ publicId: null })] } }));
    expect(noId.services!.taverna).toBe("unknown");
    // the other services from the state; fuel true, water false
    expect(mapped(src([], { "services.fuel": coreValue({ present: true }) })).services).toMatchObject({ fuel: "yes", water: "no", electricity: "unknown", wifi: "unknown" });
  });

  it("berth of a marina full in Jul and Aug is seasonFull [7, 8]", () => {
    expect(mapped(marina()).berth).toMatchObject({ status: "seasonFull", months: [7, 8] });
    expect(mapped(marina({ occupancy: coreValue({ "6": "moderate", "7": "empty" }) })).berth!.status).toBe("usuallySpace");
    expect(mapped(spotA({ src: { kind: "port" }, drop: ["occupancy"] })).berth).toEqual({ status: "unknown", months: [], sourcesCount: 0, bookable: null });
  });

  it("provenance.shelter takes text when any sector is text, the minimum confidence and the latest date", () => {
    const s = mapped(spotA({ core: { "shelter.SE": coreValue(0.1, { confidence: 0.3, observedAt: "2026-10-05" }) } }));
    expect(s.provenance["shelter"]).toEqual({ source: "text", confidence: 0.3, observedAt: "2026-10-05" });
    expect(s.provenance["services.water"]).toEqual({ source: "text", confidence: 0.7, observedAt: "2025-06-10" });
  });

  it("facts: the safety fact is marked; a landside fact points at its nearby entry by name, else carries the name (E3)", () => {
    const state = {
      facts: [
        fact({ factId: FACT_4, statement: "Gusts at the headland.", safety: true, observedAt: "2025-08-01" }),
        fact({ factId: FACT_2, subject: "landside", subjectName: "taverna vathi", subjectCategory: "food", statement: "Good grilled fish.", tone: "positive", observedAt: "2025-06-10" }),
        fact({ factId: FACT_3, subject: "landside", subjectName: "Kafeneio Kosta", subjectCategory: "food", statement: "Open all day.", tone: null, observedAt: "2024-05-01" }),
      ],
    };
    const { spot, warnings } = mappedWithWarnings(spotA({ state }));
    expect(spot.facts.map((f) => [f.subject, f.safety, f.text])).toEqual([
      [{ kind: "spot" }, true, "Gusts at the headland."],
      [{ kind: "landside", id: TAVERNA, name: null }, false, "Good grilled fish."],
      [{ kind: "landside", id: null, name: "Kafeneio Kosta" }, false, "Open all day."],
    ]);
    expect(warnings).toEqual([]);
    expect(parses(spot)).toBeUndefined();
    // a landside fact is never a spot fact: its subject names the object, and a safety flag stays on it
    const landsideSafety = mapped(spotA({ state: { facts: [fact({ subject: "landside", subjectName: "Kafeneio Kosta", safety: true })] } }));
    expect(landsideSafety.facts[0]).toMatchObject({ subject: { kind: "landside" }, safety: true });
  });

  it("warns about a nearby entry without a public id and a landside fact without a name; both are left out", () => {
    const { spot, warnings } = mappedWithWarnings(
      spotA({
        state: { nearby: [nearbyEntry(), nearbyEntry({ geoObjectId: "g-gone", category: "supply" })], facts: [fact({ subject: "landside", subjectName: null })] },
        src: { nearbyObjects: [object(), object({ geoObjectId: "g-nameless", publicId: null, name: "Ohne ID" })] },
      }),
    );
    expect(spot.nearby.map((n) => n.id)).toEqual([TAVERNA]);
    expect(spot.facts).toEqual([]);
    expect(warnings).toEqual([
      { code: "nearby_without_id", geoObjectId: "g-gone" },
      { code: "fact_without_subject", factId: FACT_2 },
    ]);
    // a dropped safety fact is reported louder
    const safety = mappedWithWarnings(spotA({ state: { facts: [fact({ subject: "landside", subjectName: null, safety: true })] } }));
    expect(safety.warnings).toEqual([{ code: "safety_fact_without_subject", factId: FACT_2 }]);
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
