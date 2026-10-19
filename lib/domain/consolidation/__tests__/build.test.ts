import { describe, expect, it } from "vitest";
import { getConsolidationConfig } from "@/lib/config";
import { SECTORS } from "@/lib/domain/facts/schema-types";
import { type BuildProfileInput, buildProfile } from "@/lib/domain/consolidation/build";
import type { DerivedInputs, ProfileContext } from "@/lib/domain/consolidation/inputs";
import type { ConsolidationInput } from "@/lib/domain/consolidation/types";
import { computed, review, text, TODAY } from "@/test/fixtures/consolidation/scenarios";

/* buildProfile is pure: constructed inputs, context and derived inputs, no DB. */

const cfg = getConsolidationConfig();

function context(over: Partial<ProfileContext> = {}): ProfileContext {
  return {
    level: "place",
    place: { id: "place-1", kind: "anchorage", status: "confirmed", statusReason: null, position: { lon: 21.123456789, lat: 35.2 }, publicId: "sp_1" },
    identity: { name: "Kolona", parentId: "island-1", geometryHash: "hash-1" },
    tileCycleDays: 30,
    areaId: "area-1",
    documentsCount: 3,
    sourcesCount: 2,
    computationGaps: { anchor_area: "no_anchor_area" },
    resolutions: new Map(),
    decidedUncertainKeys: new Set(),
    openTasks: new Map(),
    ...over,
  };
}

const noDerived: DerivedInputs = { quietness: null, importance: null };

/** Days before TODAY as `YYYY-MM-DD`. */
const daysAgo = (n: number) => new Date(Date.parse(`${TODAY}T00:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10);

/** An anchorage: computed shelter, depth and seabed, a few texts, a POI and the quietness distances. */
function scenario(): BuildProfileInput {
  const comp = (attribute: string, value: unknown, confidence = 0.6) =>
    computed({ attribute, value, confidence, factId: `fact-${attribute}`, computationId: "comp-shelter", sourceKey: "computed:shelter", observedAt: "2026-09-01", lastConfirmedAt: "2026-09-01" });
  const inputs: ConsolidationInput[] = [
    ...SECTORS.map((s, n) => comp(`shelter.${s}`, roundish(0.2 + n * 0.1))),
    comp("swell_protection", 0.5),
    comp("depth.min", 2.5, 0.8),
    comp("depth.max", 9, 0.8),
    comp("seabed", [{ type: "sand", share: 1 }], 0.7),
    comp("prohibitions", [], 0.9),
    text({ attribute: "holding", value: "good", sourceKey: "source:guide", sourceWeight: 0.9, confidence: 0.9, observedAt: "2026-06-01" }),
    text({ attribute: "holding", value: "good", sourceKey: "source:forum", sourceWeight: 0.4, confidence: 0.6, observedAt: "2025-08-01" }),
    text({ attribute: "services.water", value: true, sourceKey: "source:guide", sourceWeight: 0.9, observedAt: "2026-07-14" }),
    text({ attribute: "occupancy", value: { "7": "full", "8": "moderate" }, sourceKey: "source:guide", sourceWeight: 0.9, observedAt: "2026-08-01" }),
    text({ attribute: "quietness", value: "quiet", sourceKey: "source:guide", sourceWeight: 0.9, observedAt: "2026-08-01" }),
    text({ attribute: "hazards", value: [{ kind: "rock", name: "Xera" }], sourceKey: "source:guide", sourceWeight: 0.9 }),
    text({ attribute: "hazards", value: [{ kind: "shoal", name: null }, { kind: "rock", name: "Xera" }], sourceKey: "source:forum", sourceWeight: 0.4 }),
    text({ attribute: "season_notes", value: { kind: "crowded", months: [8, 7] }, sourceKey: "source:guide", sourceWeight: 0.9 }),
    computed({ attribute: "highlight.food", value: { present: true, names: ["Nikos"] }, computationId: null, poiId: "poi-1", sourceKey: "gazetteer:osm", sourceWeight: 0.6, dateKnown: false, observedAt: "2024-05-01", lastConfirmedAt: "2024-05-01" }),
  ];
  return {
    inputs,
    context: context(),
    derived: { quietness: { settlementDistanceM: 2000, roadDistanceM: 500, ferry: null, computationId: "comp-quiet" }, importance: null },
    today: TODAY,
    cfg,
    schemaVersion: "v2",
    rulesVersion: "v1",
  };
}

function roundish(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/** A deterministic shuffle (mulberry32). */
function shuffle<T>(list: T[], seed: number): T[] {
  let s = seed >>> 0;
  const rand = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

describe("buildProfile", () => {
  it("a place profile has 8 shelter values, provenance per attribute and gaps with reasons", () => {
    const p = buildProfile(scenario());
    expect(SECTORS.map((s) => p.attributes[`shelter.${s}`])).toEqual([0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9]);
    for (const key of Object.keys(p.attributes)) expect(p.provenance[key], key).toBeDefined();
    expect(p.provenance["shelter.N"]).toMatchObject({
      origin: "computed",
      rule: "shelter",
      confidence: 0.6,
      confidenceClass: "medium",
      factIds: ["fact-shelter.N"],
      computationIds: ["comp-shelter"],
      lastConfirmedAt: "2026-09-01",
      expired: false,
    });
    expect(p.provenance["holding"]).toMatchObject({ origin: "text", rule: "holding", sourceKeys: ["source:forum", "source:guide"] });
    expect(p.provenance["services.water"]?.observedMonths).toEqual([7]);
    // a POI import date is no observation month
    expect(p.provenance["highlight.food"]).toMatchObject({ poiIds: ["poi-1"], observedMonths: [] });
    expect(p.gaps).toContainEqual({ attribute: "anchor_area", reason: "no_anchor_area" });
    expect(p.gaps).toContainEqual({ attribute: "max_draft", reason: "no_facts" });
    expect(p.gaps.map((g) => g.attribute)).not.toContain("holding");
    expect(p.support["holding"]).toEqual({ independent: 2, maxWeight: 0.9, factIds: p.provenance["holding"]!.factIds });
    expect(p.support["shelter.N"]).toMatchObject({ independent: 1, maxWeight: cfg.weights.computed });
    // 0.4 · shelter 0.6 + 0.25 · depth 0.8 + 0.2 · seabed 0.7 + 0.15 · exclusion (prohibitions) 0.9
    expect(p.confidence).toBe(0.715);
    expect(p).toMatchObject({ sourcesCount: 2, documentsCount: 3, rulesVersion: "v1", factSchemaVersion: "v2" });
    expect(p.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("identity fields come from the gazetteer with confidence 1", () => {
    const p = buildProfile(scenario());
    expect(p.attributes).toMatchObject({
      "geo.name": "Kolona",
      "geo.parent_id": "island-1",
      "geo.geometry_hash": "hash-1",
      "place.kind": "anchorage",
      "place.status": "confirmed",
      "place.position": { lon: 21.123457, lat: 35.2 },
      exclude: { excluded: false, reason: null },
    });
    expect(p.provenance["geo.name"]).toMatchObject({ origin: "gazetteer", rule: "identity", confidence: 1, confidenceClass: "high" });
    const banned = buildProfile({
      ...scenario(),
      context: context({ place: { ...context().place!, status: "no_anchoring", statusReason: "military" } }),
    });
    expect(banned.attributes["exclude"]).toEqual({ excluded: true, reason: "military" });
  });

  it("shuffled inputs give the same content hash", () => {
    const s = scenario();
    const base = buildProfile(s);
    for (let seed = 1; seed <= 20; seed++) {
      const shuffled = buildProfile({ ...s, inputs: shuffle(s.inputs, seed) });
      expect(shuffled.contentHash, `seed ${seed}`).toBe(base.contentHash);
      expect(shuffled).toEqual(base);
    }
  });

  it("a pending provenance or a changed fact id with the same value and class keeps the hash", () => {
    const s = scenario();
    const base = buildProfile(s);
    // a pending change under review lives in the open task, not in the profile (ruling M5-P8)
    const pending = buildProfile({ ...s, context: context({ openTasks: new Map([["uncertain_change:holding", { taskId: "t-1", key: "k-1" }]]) }) });
    expect(pending.contentHash).toBe(base.contentHash);
    const renamed = buildProfile({ ...s, inputs: s.inputs.map((i) => (i.attribute === "holding" ? { ...i, factId: `${i.factId}-new` } : i)) });
    expect(renamed.provenance["holding"]!.factIds).not.toEqual(base.provenance["holding"]!.factIds);
    expect(renamed.contentHash).toBe(base.contentHash);
    // a slightly different confidence in the same class keeps the hash, another class does not
    const weaker = (c: number) =>
      buildProfile({ ...s, inputs: s.inputs.map((i) => (i.attribute === "shelter.N" ? { ...i, confidence: c } : i)) });
    expect(weaker(0.62).contentHash).toBe(base.contentHash);
    expect(weaker(0.3).contentHash).not.toBe(base.contentHash);
  });

  it("a text attribute last confirmed 61 days ago in a 30-day tile is expired one class lower", () => {
    const at = (days: number) =>
      buildProfile({
        ...scenario(),
        inputs: [text({ attribute: "holding", value: "good", sourceWeight: 0.9, confidence: 0.9, observedAt: "2026-06-01", lastConfirmedAt: daysAgo(days) })],
      });
    const fresh = at(60);
    expect(fresh.provenance["holding"]).toMatchObject({ expired: false, confidenceClass: "high" });
    const old = at(61);
    expect(old.attributes["holding"]).toBe("good");
    expect(old.provenance["holding"]).toMatchObject({ expired: true, confidenceClass: "medium", confidence: 0.55, lastConfirmedAt: daysAgo(61) });
    expect(old.contentHash).not.toBe(fresh.contentHash);
  });

  it("computed attributes never expire, nor POI support or review decisions", () => {
    const long = daysAgo(400);
    const p = buildProfile({
      ...scenario(),
      inputs: [
        computed({ attribute: "shelter.N", value: 0.7, observedAt: long, lastConfirmedAt: long }),
        computed({ attribute: "highlight.food", value: { present: true, names: [] }, computationId: null, poiId: "poi-1", dateKnown: false, observedAt: long, lastConfirmedAt: long }),
        review({ attribute: "holding", value: "poor", observedAt: long, lastConfirmedAt: long }),
      ],
    });
    expect(p.provenance["shelter.N"]?.expired).toBe(false);
    expect(p.provenance["highlight.food"]?.expired).toBe(false);
    expect(p.provenance["holding"]).toMatchObject({ origin: "review", expired: false });
  });

  it("a conflict carries the resolution of a decided task", () => {
    const s = scenario();
    const inputs = [
      ...s.inputs.filter((i) => i.attribute !== "holding"),
      text({ attribute: "holding", value: "good", sourceKey: "source:a", sourceWeight: 0.6, observedAt: "2026-07-01" }),
      text({ attribute: "holding", value: "poor", sourceKey: "source:b", sourceWeight: 0.5, observedAt: "2026-07-02" }),
    ];
    const open = buildProfile({ ...s, inputs });
    expect(open.conflicts).toHaveLength(1);
    const key = open.conflicts[0]!.key;
    expect(open.conflicts[0]).toMatchObject({ attribute: "holding", resolution: null, a: { value: "good" }, b: { value: "poor" } });
    expect(open.provenance["holding"]?.conflictKey).toBe(key);

    const decided = buildProfile({ ...s, inputs, context: context({ resolutions: new Map([[key, "seasonal"]]) }) });
    expect(decided.conflicts[0]?.resolution).toBe("seasonal");
    expect(decided.contentHash).not.toBe(open.contentHash);
  });

  it("a poi profile has importance, radius and spot ids; a place has quietness", () => {
    const place = buildProfile(scenario());
    // settlement 1, road 0.5, occupancy July/August (full, moderate) 0.25, text quiet 1 → 0.722
    expect(place.attributes["derived.quietness"]).toBe(0.722);
    expect(place.provenance["derived.quietness"]).toMatchObject({ origin: "derived", rule: "derived", computationIds: ["comp-quiet"] });
    expect(place.attributes["derived.season"]).toEqual([{ kind: "crowded", months: [7, 8] }]);
    expect(place.attributes["derived.importance"]).toBeUndefined();

    const poi = buildProfile({
      inputs: [text({ attribute: "exists", value: true })],
      context: context({ level: "poi", place: null, computationGaps: {} }),
      derived: {
        quietness: null,
        importance: {
          sources: [{ key: "source:a", weight: 1 }, { key: "source:b", weight: 1 }],
          sitelinks: null,
          category: "food",
          spotCandidates: [
            { placeId: "sp_far", distanceNm: 30 },
            { placeId: "sp_b", distanceNm: 8 },
            { placeId: "sp_a", distanceNm: 8 },
          ],
        },
      },
      today: TODAY,
      cfg,
      schemaVersion: "v2",
      rulesVersion: "v1",
    });
    expect(poi.attributes).toMatchObject({ "derived.importance": 3, "derived.radius_nm": 20, "derived.spot_ids": ["sp_a", "sp_b"], exists: true });
    expect(poi.provenance["derived.importance"]).toMatchObject({ origin: "derived", sourceKeys: ["source:a", "source:b"] });
    expect(poi.attributes["derived.quietness"]).toBeUndefined();
    expect(poi.attributes["place.kind"]).toBeUndefined();
    expect(poi.confidence).toBeNull();
  });

  it("an anchorage does not list contact as a gap", () => {
    const anchorage = buildProfile({ ...scenario(), inputs: [] });
    expect(anchorage.gaps.map((g) => g.attribute)).not.toContain("contact");
    expect(anchorage.gaps.map((g) => g.attribute)).not.toContain("prices");
    const marina = buildProfile({ ...scenario(), inputs: [], context: context({ place: { ...context().place!, kind: "marina" } }) });
    expect(marina.gaps.map((g) => g.attribute)).toContain("contact");
  });

  it("a harbour without inputs gets the shelter floor from the rule, without support", () => {
    const marina = buildProfile({ ...scenario(), inputs: [], derived: noDerived, context: context({ place: { ...context().place!, kind: "marina" } }) });
    expect(SECTORS.map((s) => marina.attributes[`shelter.${s}`])).toEqual(SECTORS.map(() => 0.8));
    expect(marina.provenance["shelter.N"]).toMatchObject({ origin: "rule", factIds: [], lastConfirmedAt: null, expired: false });
    expect(marina.support["shelter.N"]).toEqual({ independent: 0, maxWeight: 0, factIds: [] });
    expect(marina.attributes["derived.quietness"]).toBeUndefined();
  });

  it("union entries keep their fact ids, an entry a review added cites the review fact", () => {
    const decision = review({ attribute: "hazards", value: [{ kind: "wreck", name: null }], observedAt: "2026-09-01" });
    const t1 = text({ attribute: "hazards", value: [{ kind: "rock", name: "Xera" }] });
    const p = buildProfile({ ...scenario(), inputs: [t1, decision] });
    expect(p.attributes["hazards"]).toEqual([
      { kind: "rock", name: "Xera" },
      { kind: "wreck", name: null },
    ]);
    const entries = p.provenance["hazards"]!.entryFactIds!;
    expect(Object.values(entries)).toEqual(expect.arrayContaining([[t1.factId], [decision.factId]]));
    expect(p.support["hazards"]).toMatchObject({ independent: 2, maxWeight: 1 });
  });

  it("only gone documents mark the value as no longer currently confirmed", () => {
    const gone = buildProfile({ ...scenario(), inputs: [text({ attribute: "holding", value: "good", gone: true })] });
    expect(gone.provenance["holding"]?.onlyGoneSources).toBe(true);
    const mixed = buildProfile({
      ...scenario(),
      inputs: [text({ attribute: "holding", value: "good", gone: true }), text({ attribute: "holding", value: "good", sourceKey: "source:b" })],
    });
    expect(mixed.provenance["holding"]?.onlyGoneSources).toBe(false);
  });
});
