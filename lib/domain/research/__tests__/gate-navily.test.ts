import { describe, expect, it } from "vitest";
import { getConfig } from "@/lib/config";
import type { PlaceStatus } from "@/lib/db/schema";
import type { LonLat } from "@/lib/domain/geometry/water";
import type { NavilySpot } from "@/lib/domain/quality/navily-sample";
import type { BerthStateNearby } from "@/lib/db/schema/research-state";
import { evaluateGate, type GateState } from "@/lib/domain/research/gate-navily";
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
const run = (places: In[], spots: NavilySpot[], decisions: Record<string, "berth" | "not_berth"> = {}, inArea?: (p: LonLat) => boolean) =>
  evaluateGate({ thresholds: [2, 3, 4, 5], places, spots, decisions: new Map(Object.entries(decisions)), inArea }, cfg);
const berthState = (core: Record<string, number | boolean | object>, nearby: BerthStateNearby[] = []): GateState => ({
  core: Object.fromEntries(Object.entries(core).map(([k, value]) => [k, { value, confidence: 0.8, origin: "computed" as const, observedAt: null, factIds: [] }])),
  nearby,
});
const withState = (p: In, state: GateState | null): In => ({ ...p, state });
const row = (r: ReturnType<typeof run>, n: number) => r.rows.find((x) => x.threshold === n)!;

describe("evaluateGate", () => {
  it("a confirmed place on a spot of its kind is correct", () => {
    const r = run([place("p1", ["Alpha"], AT)], [spot({ name: "Alpha" })]);
    expect(row(r, 2)).toEqual({ threshold: 2, confirmed: 1, correct: 1, wrongKind: 0, wrongPosition: 0, wrongShelter: 0, wrongProhibited: 0, conflicts: 0, decidedNotBerth: 0, correctness: 1, coverage: 1 });
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
    expect(row(r, 4)).toEqual({ threshold: 4, confirmed: 0, correct: 0, wrongKind: 0, wrongPosition: 0, wrongShelter: 0, wrongProhibited: 0, conflicts: 0, decidedNotBerth: 0, correctness: null, coverage: 0 });
    expect(row(r, 3).correctness).toBe(1);
  });

  it("only the places confirmed at a threshold are matched at it", () => {
    const places = [place("p1", ["Alpha"], AT, { confirmedUpTo: 5 }), place("p2", ["Beta"], north(3000), { confirmedUpTo: 2 })];
    const r = run(places, [spot({ name: "Alpha" })]);
    expect([2, 3, 4, 5].map((n) => row(r, n).confirmed)).toEqual([2, 1, 1, 1]);
    expect(r.conflicts.get(2)).toEqual(["p2"]);
    expect(r.conflicts.get(3)).toEqual([]);
  });

  it("a confirmed bay matched by name to a harbour spot is wrongKind, not correct", () => {
    const r = run([place("p1", ["Gamma"], AT)], [spot({ name: "Gamma", kind: "port" })]);
    expect(row(r, 2)).toMatchObject({ confirmed: 1, correct: 0, wrongKind: 1, conflicts: 0, correctness: 0 });
    expect(r.misses.get(2)).toEqual([]);
  });

  it("a spot of another kind matched by distance only (name below nameMin) is a conflict, not wrongKind (revised ruling)", () => {
    const r = run([place("p1", ["Beta"], north(100))], [spot({ name: "Gamma", kind: "port" })]);
    expect(row(r, 2)).toMatchObject({ confirmed: 1, correct: 0, wrongKind: 0, conflicts: 1 });
    expect(r.conflicts.get(2)).toEqual(["p1"]);
    expect(r.errors.get(2)).toEqual([]);
    const decided = run([place("p1", ["Beta"], north(100))], [spot({ name: "Gamma", kind: "port" })], { p1: "berth" });
    expect(row(decided, 2)).toMatchObject({ correct: 1, conflicts: 0, wrongKind: 0 });
  });

  it("a spot of unknown kind is a conflict even when the name matches (revised ruling)", () => {
    const r = run([place("p1", ["Gamma"], AT)], [spot({ name: "Gamma", kind: null })]);
    expect(row(r, 2)).toMatchObject({ confirmed: 1, correct: 0, wrongKind: 0, conflicts: 1 });
    expect(r.conflicts.get(2)).toEqual(["p1"]);
  });

  it("a matched spot of its kind farther than gate.maxPositionDeviationM is a position error; within it correct", () => {
    expect(cfg.research.gate.maxPositionDeviationM).toBe(150);
    const far = run([place("p1", ["Alpha"], north(300))], [spot({ name: "Alpha" })]);
    expect(row(far, 2)).toMatchObject({ confirmed: 1, correct: 0, wrongPosition: 1, conflicts: 0, correctness: 0 });
    expect(far.errors.get(2)).toEqual([{ placeId: "p1", kind: "position", spotIndex: 0, distanceM: expect.closeTo(300, 0) }]);
    expect(far.misses.get(2)).toEqual([]);
    const near = run([place("p1", ["Alpha"], north(140))], [spot({ name: "Alpha" })]);
    expect(row(near, 2)).toMatchObject({ correct: 1, wrongPosition: 0 });
    // a human "berth" does not clear a position error
    expect(row(run([place("p1", ["Alpha"], north(300))], [spot({ name: "Alpha" })], { p1: "berth" }), 2)).toMatchObject({ correct: 0, wrongPosition: 1 });
  });

  it("spots outside the area (the buffer) are matched, but never counted as misses", () => {
    const inside = (p: LonLat) => p.lat <= AT.lat + 0.001;
    const edge = spot({ name: "Alpha", ...north(140) });
    const r = run([place("p1", ["Alpha"], north(100))], [edge, spot({ name: "Delta", ...north(5000) })], {}, inside);
    expect(row(r, 2)).toMatchObject({ confirmed: 1, correct: 1, conflicts: 0 });
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

  it("lists the error places per threshold: wrong kind with its spot, not_berth without one", () => {
    const places = [place("w", ["Gamma"], AT), place("n", ["B"], north(6000)), place("ok", ["Alpha"], north(9000))];
    const spots = [spot({ name: "Gamma", kind: "port" }), spot({ name: "Alpha", ...north(9000) })];
    const r = run(places, spots, { n: "not_berth" });
    expect(r.errors.get(2)).toEqual([
      { placeId: "w", kind: "wrong_kind", spotIndex: 0, distanceM: expect.any(Number) },
      { placeId: "n", kind: "not_berth", spotIndex: null, distanceM: null },
    ]);
    expect(r.errors.get(5)!.map((e) => e.placeId)).toEqual(["w", "n"]);
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

describe("evaluateGate core values", () => {
  const confirmed = (state: GateState | null) => [withState(place("p1", ["Alpha"], AT), state)];

  it("a sector delivered as clearly protected (0.9) that the reference list lacks is a shelter error and breaks correctness", () => {
    const r = run(confirmed(berthState({ "shelter.N": 0.9 })), [spot({ name: "Alpha", prot: ["S", "SW"] })]);
    expect(row(r, 2)).toMatchObject({ confirmed: 1, correct: 0, wrongShelter: 1, conflicts: 0, correctness: 0 });
    expect(r.errors.get(2)).toEqual([{ placeId: "p1", kind: "shelter", spotIndex: 0, distanceM: 0 }]);
  });

  it("the list is read case-insensitively: a listed sector is no error", () => {
    const r = run(confirmed(berthState({ "shelter.N": 0.9 })), [spot({ name: "Alpha", prot: ["n"] })]);
    expect(row(r, 2)).toMatchObject({ correct: 1, wrongShelter: 0 });
  });

  it("0.6 against the same list is a deviation, no error", () => {
    const r = run(confirmed(berthState({ "shelter.N": 0.6 })), [spot({ name: "Alpha", prot: ["S"] })]);
    expect(row(r, 2)).toMatchObject({ correct: 1, wrongShelter: 0 });
    expect(r.errors.get(2)).toEqual([]);
    expect(r.core.get(2)!["shelter.N"]).toEqual({ match: 0, deviation: 1, gap: 0, notAtNavily: 0, noState: 0 });
  });

  it("a reference without a protection list: no shelter comparison, no error", () => {
    const r = run(confirmed(berthState({ "shelter.N": 0.95 })), [spot({ name: "Alpha", prot: null })]);
    expect(row(r, 2)).toMatchObject({ correct: 1, wrongShelter: 0 });
    expect(r.core.get(2)!["shelter.N"]).toMatchObject({ notAtNavily: 1, deviation: 0 });
  });

  it("a confirmed place without a state counts as no state, no crash, still correct", () => {
    const r = run(confirmed(null), [spot({ name: "Alpha", prot: ["S"], water: true })]);
    expect(row(r, 2)).toMatchObject({ correct: 1 });
    const c = r.core.get(2)!;
    expect(c["services.water"]).toEqual({ match: 0, deviation: 0, gap: 0, notAtNavily: 0, noState: 1 });
    expect(c.seabed.noState).toBe(1);
  });

  it("counts match, deviation, gap (own value missing) and not at reference per attribute", () => {
    const state = berthState(
      { "shelter.S": 0.9, "services.water": false, seabed: [{ type: "sand", share: 1 }], "mooring.buoys": { present: true } },
      [{ geoObjectId: "g", category: "supply", distanceM: 200, access: "foot" }],
    );
    const r = run(confirmed(state), [spot({ name: "Alpha", prot: ["S"], water: true, seabeds: [], shop: true, type: "anchorage" })]);
    const c = r.core.get(2)!;
    expect(c["shelter.S"].match).toBe(1);
    expect(c["shelter.N"]).toMatchObject({ gap: 1, match: 0 }); // the reference says N is open, we have no value
    expect(c["services.water"]).toMatchObject({ deviation: 1, match: 0 });
    expect(c.seabed).toMatchObject({ notAtNavily: 1 });
    expect(c["mooring.buoys"]).toMatchObject({ notAtNavily: 1 });
    expect(c["highlight.supply"]).toMatchObject({ match: 1 });
  });

  it("a missing own value where the reference has one is a gap, not a deviation (K4); supply comes from nearby on foot", () => {
    const state = berthState({}, [{ geoObjectId: "g", category: "bakery", distanceM: 300, access: "foot" }, { geoObjectId: "h", category: "supply", distanceM: 9000, access: "transport" }]);
    const r = run(confirmed(state), [spot({ name: "Alpha", prot: ["S"], water: true, shop: true })]);
    const c = r.core.get(2)!;
    expect(c["services.water"]).toMatchObject({ gap: 1, deviation: 0 });
    expect(c["highlight.supply"]).toMatchObject({ match: 1 });
    expect(c["shelter.S"]).toMatchObject({ gap: 1, deviation: 0 });
    for (const a of ["existence", "position", "depth", "highlight.food"] as const) expect(c[a]).toEqual({ match: 0, deviation: 0, gap: 0, notAtNavily: 0, noState: 0 });
  });

  describe("spot types and coverage", () => {
    it("a bay beside a prohibited spot is an error and never correct; the spot is no miss and not in the coverage", () => {
      expect(cfg.quality.navily.prohibitedTypes).toEqual(["prohibited"]);
      const r = run([place("p1", ["Alpha"], north(50))], [spot({ name: "Alpha", kind: null, type: "prohibited" })]);
      expect(row(r, 2)).toMatchObject({ confirmed: 1, correct: 0, wrongProhibited: 1, conflicts: 0, correctness: 0, coverage: null });
      expect(r.errors.get(2)).toEqual([{ placeId: "p1", kind: "prohibited", spotIndex: 0, distanceM: expect.closeTo(50, 0) }]);
      expect(r.misses.get(2)).toEqual([]);
    });

    it("a human berth decision does not clear a prohibited match", () => {
      const r = run([place("p1", ["Alpha"], north(50))], [spot({ name: "Alpha", type: "prohibited" })], { p1: "berth" });
      expect(row(r, 2)).toMatchObject({ correct: 0, wrongProhibited: 1 });
    });

    it("a marina beside a dry-berthing spot is a conflict, not a hit; the spot is not counted", () => {
      const r = run([place("p1", ["Alpha"], north(50), { kind: "marina" })], [spot({ name: "Alpha", kind: "port", type: "dry-berthing" })]);
      expect(row(r, 2)).toMatchObject({ confirmed: 1, correct: 0, wrongProhibited: 0, conflicts: 1, correctness: 0, coverage: null });
      expect(r.conflicts.get(2)).toEqual(["p1"]);
      expect(r.misses.get(2)).toEqual([]);
      expect(r.core.get(2)!.seabed).toEqual({ match: 0, deviation: 0, gap: 0, notAtNavily: 0, noState: 0 });
    });

    it("a prohibited or dry-berthing spot without a place is not in the miss list", () => {
      const r = run(
        [place("p1", ["Alpha"], AT)],
        [spot({ name: "Alpha" }), spot({ name: "Delta", ...north(5000), type: "prohibited" }), spot({ name: "Echo", ...north(8000), type: "dry-berthing" }), spot({ name: "Foxtrot", ...north(11000) })],
      );
      expect(r.misses.get(2)).toEqual([{ spotIndex: 3, reason: "no_candidate", placeId: null }]);
      expect(row(r, 2).coverage).toBeCloseTo(0.5);
    });

    it("coverage is per threshold: correctly matched spots over spots in the area", () => {
      const places = [place("p1", ["Alpha"], AT, { confirmedUpTo: 5 }), place("p2", ["Beta"], north(5000), { confirmedUpTo: 2 })];
      const spots = [spot({ name: "Alpha" }), spot({ name: "Beta", ...north(5000) }), spot({ name: "Gamma", ...north(9000) }), spot({ name: "Delta", ...north(12000) })];
      const r = run(places, spots);
      expect(row(r, 2).coverage).toBeCloseTo(0.5);
      expect(row(r, 3).coverage).toBeCloseTo(0.25);
    });

    it("an error match does not cover its spot; spots outside the area do not count", () => {
      const inside = (p: LonLat) => p.lat <= AT.lat + 0.1;
      const r = run([place("p1", ["Alpha"], north(300))], [spot({ name: "Alpha" }), spot({ name: "Far", ...north(30_000) })], {}, inside);
      expect(row(r, 2)).toMatchObject({ wrongPosition: 1, coverage: 0 });
      const ok = run([place("p1", ["Alpha"], AT)], [spot({ name: "Alpha" }), spot({ name: "Far", ...north(30_000) })], {}, inside);
      expect(row(ok, 2).coverage).toBe(1);
    });
  });

  it("the gate no longer reads the old profiles", async () => {
    const { readFile } = await import("node:fs/promises");
    expect(await readFile("lib/domain/research/gate-report.ts", "utf8")).not.toContain("latestProfiles");
  });
});
