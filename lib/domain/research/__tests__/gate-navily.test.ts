import { describe, expect, it } from "vitest";
import { getConfig } from "@/lib/config";
import type { PlaceStatus } from "@/lib/db/schema";
import type { LonLat } from "@/lib/domain/geometry/water";
import type { NavilySpot } from "@/lib/domain/quality/navily-sample";
import { evaluateGate } from "@/lib/domain/research/gate-navily";
import { ADMIN_SET_REASON, RESTRICTED_REASON, type Verdict } from "@/lib/domain/research/confirmation";

/* The gate evaluation (plan N3 task 2) is pure; only synthetic places and spots (never Navily data). */

const cfg = getConfig();
const AT: LonLat = { lon: 21.0, lat: 35.2 };
const north = (m: number): LonLat => ({ lon: AT.lon, lat: AT.lat + m / 111_195 });

const spot = (over: Partial<NavilySpot> = {}): NavilySpot => ({
  lat: AT.lat, lon: AT.lon, prot: null, seabeds: null, name: null, kind: "mooring", type: null, water: null, shop: null, ...over,
});
const verdict = (status: Verdict["status"], blockingSignalId: string | null = null): Verdict => ({
  status, reason: "r", independentSources: [], blockingSignalId, signalIds: [],
});

type In = Parameters<typeof evaluateGate>[0]["places"][number];
/** A place with the given verdict per threshold (a number: confirmed from there up to threshold 5). */
function place(placeId: string, names: string[], position: LonLat, o: { confirmedUpTo?: number; kind?: In["kind"]; status?: PlaceStatus; verdicts?: [number, Verdict][]; hasNames?: boolean; hasHits?: boolean; statusReason?: string | null } = {}): In {
  const verdicts = new Map<number, Verdict>(o.verdicts ?? [2, 3, 4, 5].map((n) => [n, verdict(n <= (o.confirmedUpTo ?? 5) ? "confirmed" : "candidate")] as [number, Verdict]));
  return {
    placeId, kind: o.kind ?? "anchorage", status: o.status ?? "candidate", statusReason: o.statusReason ?? null, position, anchorPosition: null, names, verdicts,
    hasNames: o.hasNames ?? names.length > 0, hasHits: o.hasHits ?? true,
  };
}
const run = (places: In[], spots: NavilySpot[], decisions: Record<string, "berth" | "not_berth"> = {}) =>
  evaluateGate({ thresholds: [2, 3, 4, 5], places, spots, decisions: new Map(Object.entries(decisions)) }, cfg);
const row = (r: ReturnType<typeof run>, n: number) => r.rows.find((x) => x.threshold === n)!;

describe("evaluateGate", () => {
  it("a confirmed place on a spot of its kind is correct", () => {
    const r = run([place("p1", ["Alpha"], AT)], [spot({ name: "Alpha" })]);
    expect(row(r, 2)).toEqual({ threshold: 2, confirmed: 1, correct: 1, wrongKind: 0, conflicts: 0, decidedNotBerth: 0, correctness: 1 });
    expect(r.conflicts.get(2)).toEqual([]);
    expect(r.misses.get(2)).toEqual([]);
  });

  it("400 m beside a spot of its kind with another name counts only by the matching rules, else it is a conflict (Review Focus)", () => {
    expect(cfg.quality.navily.nearRadiusM).toBeLessThan(400);
    const r = run([place("p1", ["Beta"], north(400))], [spot({ name: "Alpha" })]);
    expect(row(r, 2)).toMatchObject({ confirmed: 1, correct: 0, conflicts: 1, correctness: 0 });
    expect(r.conflicts.get(2)).toEqual(["p1"]);
  });

  it("two confirmed places sharing one spot: one correct, the other a conflict (Review Focus)", () => {
    const r = run([place("p1", ["Alpha"], AT), place("p2", ["Alpha"], north(50))], [spot({ name: "Alpha" })]);
    expect(row(r, 2)).toMatchObject({ confirmed: 2, correct: 1, conflicts: 1, correctness: 0.5 });
  });

  it("a spot without a candidate in reach is no_candidate, not too_few_sources (Review Focus)", () => {
    const r = run([place("p1", ["Alpha"], AT, { confirmedUpTo: 5 })], [spot({ name: "Alpha" }), spot({ name: "Delta", ...north(5000) })]);
    expect(r.misses.get(2)).toEqual([{ spotIndex: 1, reason: "no_candidate", placeId: null }]);
  });

  it("a threshold confirming nothing has correctness null, not 100 % (Review Focus)", () => {
    const r = run([place("p1", ["Alpha"], AT, { confirmedUpTo: 3 })], [spot({ name: "Alpha" })]);
    expect(row(r, 4)).toEqual({ threshold: 4, confirmed: 0, correct: 0, wrongKind: 0, conflicts: 0, decidedNotBerth: 0, correctness: null });
    expect(row(r, 3).correctness).toBe(1);
  });

  it("only the places confirmed at a threshold are matched at it", () => {
    const places = [place("p1", ["Alpha"], AT, { confirmedUpTo: 5 }), place("p2", ["Beta"], north(3000), { confirmedUpTo: 2 })];
    const r = run(places, [spot({ name: "Alpha" })]);
    expect([2, 3, 4, 5].map((n) => row(r, n).confirmed)).toEqual([2, 1, 1, 1]);
    expect(r.conflicts.get(2)).toEqual(["p2"]);
    expect(r.conflicts.get(3)).toEqual([]);
  });

  it("a confirmed bay matched only to a harbour spot is wrongKind, not correct", () => {
    const r = run([place("p1", ["Gamma"], AT)], [spot({ name: "Gamma", kind: "port" })]);
    expect(row(r, 2)).toMatchObject({ confirmed: 1, correct: 0, wrongKind: 1, conflicts: 0, correctness: 0 });
    expect(r.misses.get(2)).toEqual([]);
  });

  it("a human decision settles an unmatched place: berth is correct, not_berth is an error; undecided stays a conflict", () => {
    const places = [place("yes", ["Aa"], north(3000)), place("no", ["B"], north(6000)), place("open", ["C"], north(9000))];
    const r = run(places, [], { yes: "berth", no: "not_berth" });
    expect(row(r, 2)).toMatchObject({ confirmed: 3, correct: 1, decidedNotBerth: 1, conflicts: 1, wrongKind: 0 });
    expect(r.conflicts.get(2)).toEqual(["open"]);
  });

  it("wrongKind is an error whatever a human decided, and not a conflict", () => {
    const places = [place("a", ["Gamma"], AT), place("b", ["Gamma"], north(2000))];
    const spots = [spot({ name: "Gamma", kind: "port" }), spot({ name: "Gamma", kind: "port", ...north(2000) })];
    const r = run(places, spots, { a: "berth", b: "not_berth" });
    expect(row(r, 2)).toMatchObject({ confirmed: 2, correct: 0, decidedNotBerth: 0, wrongKind: 2, conflicts: 0 });
    expect(r.conflicts.get(2)).toEqual([]);
  });

  it("a rejected place with a not_berth decision stays in the count as an error", () => {
    const r = run([place("p1", ["Alpha"], AT, { status: "rejected" }), place("p2", ["Beta"], north(3000))], [spot({ name: "Alpha" })], { p1: "not_berth" });
    expect(row(r, 2)).toMatchObject({ confirmed: 2, correct: 0, decidedNotBerth: 1, conflicts: 1 });
    expect(row(r, 2).correctness).toBeLessThan(1);
  });

  describe("miss reasons", () => {
    const missOf = (candidate: In) => run([candidate], [spot({ name: "Alpha" })]).misses.get(2)!;

    it("an unnamed candidate", () => {
      expect(missOf(place("c", [], AT, { verdicts: [[2, verdict("candidate")]], hasNames: false }))).toEqual([{ spotIndex: 0, reason: "unnamed_candidate", placeId: "c" }]);
    });
    it("a named candidate without search hits", () => {
      expect(missOf(place("c", ["Alpha"], AT, { verdicts: [[2, verdict("candidate")]], hasHits: false }))).toEqual([{ spotIndex: 0, reason: "no_hits", placeId: "c" }]);
    });
    it("a candidate with one source", () => {
      expect(missOf(place("c", ["Alpha"], AT, { verdicts: [[2, verdict("candidate")]] }))).toEqual([{ spotIndex: 0, reason: "too_few_sources", placeId: "c" }]);
    });
    it("a candidate with a negative signal", () => {
      expect(missOf(place("c", ["Alpha"], AT, { verdicts: [[2, verdict("candidate", "s1")]] }))).toEqual([{ spotIndex: 0, reason: "negative", placeId: "c" }]);
      expect(missOf(place("c", ["Alpha"], AT, { verdicts: [[2, verdict("no_anchoring", "s1")]] }))).toEqual([{ spotIndex: 0, reason: "negative", placeId: "c" }]);
    });
    it("a place in a restricted area, one with another no_anchoring, and a rejected place", () => {
      expect(missOf(place("c", ["Alpha"], AT, { status: "no_anchoring", statusReason: "restricted:military:x", verdicts: [] }))).toEqual([{ spotIndex: 0, reason: "restricted", placeId: "c" }]);
      expect(missOf(place("c", ["Alpha"], AT, { status: "no_anchoring", statusReason: "Ankerverbot laut Behörde", verdicts: [] }))).toEqual([{ spotIndex: 0, reason: "negative", placeId: "c" }]);
      expect(missOf(place("c", ["Alpha"], AT, { verdicts: [[2, { ...verdict("no_anchoring"), reason: RESTRICTED_REASON }]] }))).toEqual([{ spotIndex: 0, reason: "restricted", placeId: "c" }]);
      expect(missOf(place("c", ["Alpha"], AT, { status: "rejected", verdicts: [] }))).toEqual([{ spotIndex: 0, reason: "rejected", placeId: "c" }]);
    });
    it("an admin-set candidate", () => {
      expect(missOf(place("c", ["Alpha"], AT, { verdicts: [[2, { ...verdict("candidate"), reason: ADMIN_SET_REASON }]] }))).toEqual([{ spotIndex: 0, reason: "admin", placeId: "c" }]);
    });
    it("a spot whose only candidate already has another spot is matched_elsewhere, not no_candidate", () => {
      const r = run([place("p1", ["Alpha"], AT)], [spot({ name: "Alpha" }), spot({ name: "Alpha", ...north(50) })]);
      expect(r.misses.get(2)).toEqual([{ spotIndex: 1, reason: "matched_elsewhere", placeId: "p1" }]);
    });
    it("the first candidate by matching order decides, not a farther one", () => {
      const r = run(
        [place("far", ["Alpha"], north(100), { verdicts: [[2, verdict("candidate")]], hasHits: false }), place("near", ["Alpha"], AT, { verdicts: [[2, verdict("candidate")]] })],
        [spot({ name: "Alpha" })],
      );
      expect(r.misses.get(2)).toEqual([{ spotIndex: 0, reason: "too_few_sources", placeId: "near" }]);
    });
  });
});
