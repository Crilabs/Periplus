import { describe, expect, it } from "vitest";
import { getConsolidationConfig } from "@/lib/config";
import type { AttributeProvenance, RuleResult } from "@/lib/domain/consolidation/types";
import { computed, text } from "@/test/fixtures/consolidation/scenarios";
import { profileConfidence } from "../confidence";
import { importanceOf, spotIdsWithin } from "../importance";
import { popularity } from "../popularity";
import { quietnessScore } from "../quietness";
import { observedMonths, seasonHints } from "../season";

const cfg = getConsolidationConfig();

describe("quietnessScore", () => {
  it("quietness renormalizes over known parts", () => {
    // (0.3·1 + 0.2·0.5 + 0.2·0.25 + 0.2·1) / 0.9
    expect(quietnessScore({ settlementDistanceM: 2000, roadDistanceM: 500, occupancy: ["full", "moderate"], text: "quiet", ferry: null }, cfg).value).toBe(0.722);
    expect(quietnessScore({ settlementDistanceM: null, roadDistanceM: null, occupancy: ["unknown"], text: null, ferry: null }, cfg).value).toBeNull();
  });

  it("distances cap at 1, unknown months do not count, the parts are listed", () => {
    const r = quietnessScore({ settlementDistanceM: 5000, roadDistanceM: null, occupancy: ["unknown", "empty"], text: null, ferry: 0.3 }, cfg);
    expect(r.parts).toEqual({ settlement: 1, occupancy: 1, ferry: 0.3 });
    // (0.3·1 + 0.2·1 + 0.1·0.3) / 0.6
    expect(r.value).toBe(0.883);
  });
});

describe("quietnessScore minParts (M5-E-R2)", () => {
  it("one known part alone gives no value, two do", () => {
    const one = quietnessScore({ settlementDistanceM: null, roadDistanceM: null, occupancy: [], text: null, ferry: 0.2 }, cfg);
    expect(cfg.quietness.minParts).toBe(2);
    expect(one).toEqual({ value: null, parts: { ferry: 0.2 } });
    expect(quietnessScore({ settlementDistanceM: null, roadDistanceM: null, occupancy: [], text: "busy", ferry: null }, cfg).value).toBeNull();
    // (0.2·0.3 + 0.1·0.2) / 0.3
    expect(quietnessScore({ settlementDistanceM: null, roadDistanceM: null, occupancy: [], text: "busy", ferry: 0.2 }, cfg).value).toBe(0.267);
  });
});

describe("importanceOf", () => {
  const five = Array.from({ length: 5 }, (_, n) => ({ key: `source:${n}`, weight: 0.7 }));
  it.each([
    [{ sources: [], sitelinks: null, category: "food" }, 1, 5],
    [{ sources: [{ key: "a", weight: 1 }, { key: "b", weight: 1 }], sitelinks: null, category: "food" }, 3, 20],
    [{ sources: five, sitelinks: 60, category: "culture" }, 5, 50],
  ])("importance %#", (i, importance, radiusNm) => expect(importanceOf(i as never, cfg)).toMatchObject({ importance, radiusNm }));

  it("a source key counts once, with its largest weight", () => {
    const r = importanceOf({ sources: [{ key: "a", weight: 0.4 }, { key: "a", weight: 0.9 }], sitelinks: 15, category: "beach" }, cfg);
    // 0.9 + 1.5 + 0.5
    expect(r).toEqual({ importance: 3, score: 2.9, radiusNm: 20 });
  });

  it("sitelink points are capped", () => {
    expect(importanceOf({ sources: [], sitelinks: 500, category: "food" }, cfg).score).toBe(2);
  });
});

describe("spotIdsWithin", () => {
  it("spot ids inside the radius sorted by distance, ties by id, at most max", () => {
    const candidates = [
      { placeId: "sp_c", distanceNm: 4 },
      { placeId: "sp_a", distanceNm: 12 },
      { placeId: "sp_b", distanceNm: 4 },
      { placeId: "sp_d", distanceNm: 10 },
    ];
    expect(spotIdsWithin(candidates, 10, 50)).toEqual(["sp_b", "sp_c", "sp_d"]);
    expect(spotIdsWithin(candidates, 10, 2)).toEqual(["sp_b", "sp_c"]);
    expect(spotIdsWithin([], 50, 50)).toEqual([]);
  });
});

describe("seasonHints", () => {
  const result = (value: unknown, support = [text()]): RuleResult => ({ value, origin: "text", confidence: 0.7, observedAt: null, support, conflict: null });

  it("unites the months per kind of season_notes, sorted by kind", () => {
    const r = seasonHints({
      season_notes: result([
        { kind: "open", months: [7, 5, 6] },
        { kind: "crowded", months: [8] },
        { kind: "open", months: [6, 9] },
      ]),
    });
    expect(r).toEqual([
      { kind: "crowded", months: [8] },
      { kind: "open", months: [5, 6, 7, 9] },
    ]);
    expect(seasonHints({ season_notes: null })).toEqual([]);
    expect(seasonHints({ season_notes: result({ kind: "closed", months: [1, 2] }) })).toEqual([{ kind: "closed", months: [1, 2] }]);
  });

  it("observed months are the months of the supporting inputs with a known date", () => {
    const poi = computed({ observedAt: "2026-03-01", dateKnown: false, computationId: null, poiId: "poi-1" });
    const r = result(true, [text({ observedAt: "2025-08-03" }), text({ observedAt: "2026-07-01" }), text({ observedAt: "2024-08-30" }), poi]);
    expect(observedMonths(r)).toEqual([7, 8]);
  });
});

describe("profileConfidence", () => {
  const prov = (confidence: number): AttributeProvenance => ({
    origin: "computed",
    rule: "shelter",
    confidence,
    confidenceClass: "medium",
    observedAt: null,
    lastConfirmedAt: null,
    factIds: [],
    sourceKeys: [],
    computationIds: [],
    poiIds: [],
    expired: false,
    onlyGoneSources: false,
    conflictKey: null,
    observedMonths: [],
  });

  it("profile confidence weighs shelter, depth, seabed, exclusion and skips missing groups", () => {
    const all = {
      "shelter.N": prov(0.8),
      "shelter.S": prov(0.6),
      "depth.min": prov(0.5),
      "depth.max": prov(0.7),
      "depth.approach": prov(0.1),
      seabed: prov(0.4),
      prohibitions: prov(1),
      holding: prov(0.1),
    };
    // 0.4·0.7 + 0.25·0.6 + 0.2·0.4 + 0.15·1
    expect(profileConfidence(all, cfg)).toBe(0.66);
    // shelter and seabed only: (0.4·0.7 + 0.2·0.4) / 0.6
    expect(profileConfidence({ "shelter.N": prov(0.8), "shelter.S": prov(0.6), seabed: prov(0.4) }, cfg)).toBe(0.6);
    expect(profileConfidence({ holding: prov(0.9) }, cfg)).toBeNull();
  });

  it("the attributes of each group come from the config (final review M-3)", () => {
    const provenance = { "depth.min": prov(0.5), "depth.approach": prov(0.1) };
    expect(profileConfidence(provenance, cfg)).toBe(0.5);
    const wider = { ...cfg, profileConfidenceGroups: { ...cfg.profileConfidenceGroups, depth: ["depth.*"] } };
    expect(profileConfidence(provenance, wider)).toBe(0.3);
  });
});

describe("popularity", () => {
  it("popularity is 1 for the area maximum and log-normalized below", () => {
    expect(popularity(3, 15)).toBeCloseTo(0.5, 3);
    expect(popularity(15, 15)).toBe(1);
    expect(popularity(0, 15)).toBe(0);
    expect(popularity(0, 0)).toBe(0);
  });
});
