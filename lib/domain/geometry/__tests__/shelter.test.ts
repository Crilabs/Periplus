import { describe, expect, it } from "vitest";
import { loadConfig } from "@/lib/config";
import { SECTORS, type Sector } from "@/lib/domain/facts/schema-types";
import { opening, rayShelter, sectorFetch, sectorRayIndices, shelterFromFetch, swellProtection } from "../shelter";

const cfg = loadConfig("config").geometry;

/** 72 rays of `fetchM`, with the given ray indices overridden. */
function rays(fetchM: number, overrides: Record<number, number> = {}): number[] {
  return Array.from({ length: cfg.fetch.rayCount }, (_, i) => overrides[i] ?? fetchM);
}

const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);

describe("rayShelter", () => {
  it("is 1 up to fMin, 0 from fMax and log-scaled in between", () => {
    expect(rayShelter(300, cfg.shelter)).toBe(1);
    expect(rayShelter(100, cfg.shelter)).toBe(1);
    expect(rayShelter(20000, cfg.shelter)).toBe(0);
    expect(rayShelter(50000, cfg.shelter)).toBe(0);
    expect(rayShelter(500, cfg.shelter)).toBeCloseTo(0.8784, 3);
    expect(rayShelter(400, cfg.shelter)).toBeCloseTo(0.9315, 3);
  });
});

describe("sectorRayIndices", () => {
  it("returns the 9 rays within ±22.5° of the sector centre", () => {
    expect(sectorRayIndices("N", cfg.fetch)).toEqual([68, 69, 70, 71, 0, 1, 2, 3, 4]);
    expect(sectorRayIndices("S", cfg.fetch)).toEqual(range(32, 40));
    expect(sectorRayIndices("NW", cfg.fetch)).toEqual(range(59, 67));
  });

  it("covers every ray with the 8 sectors, the boundary rays counted twice", () => {
    const counts = new Map<number, number>();
    for (const s of SECTORS) for (const i of sectorRayIndices(s, cfg.fetch)) counts.set(i, (counts.get(i) ?? 0) + 1);
    expect(counts.size).toBe(72);
    expect([...counts.values()].reduce((a, b) => a + b)).toBe(72);
  });
});

describe("shelter, opening and swell", () => {
  it("one open sector: S rays (indices 32..40) 50 km, all others 400 m", () => {
    const r = rays(400, Object.fromEntries(range(32, 40).map((i) => [i, 50000])));
    const sectors = shelterFromFetch(r, cfg);
    expect(sectors.S).toBe(0);
    for (const s of SECTORS.filter((x) => x !== "S")) expect(Math.abs(sectors[s] - 0.9315), s).toBeLessThanOrEqual(0.001);
    expect(opening(r, cfg)).toEqual({ bearingDeg: 180, widthDeg: 45 });
    expect(swellProtection(r, sectors, cfg)).toBe(0);
  });

  it("weights the sector mean 0.7 and its minimum 0.3, rounded to 3 places", () => {
    // N sector: one ray at 20 km (shelter 0), eight at 300 m (shelter 1) → 0.7 × 8/9 + 0.3 × 0 = 0.6222…
    const sectors = shelterFromFetch(rays(300, { 0: 20000 }), cfg);
    expect(sectors.N).toBe(0.622);
    expect(sectors.E).toBe(1);
  });

  it("all rays 50 km → every sector 0, opening { null, 360 }, swell 0", () => {
    const r = rays(50000);
    const sectors = shelterFromFetch(r, cfg);
    for (const s of SECTORS) expect(sectors[s]).toBe(0);
    expect(opening(r, cfg)).toEqual({ bearingDeg: null, widthDeg: 360 });
    expect(swellProtection(r, sectors, cfg)).toBe(0);
  });

  it("no ray above 30 km → swell 0.9", () => {
    const r = rays(400, { 36: 30000, 10: 25000 });
    expect(swellProtection(r, shelterFromFetch(r, cfg), cfg)).toBe(0.9);
  });

  it("swell takes the least sheltered sector reaching the longest fetch", () => {
    // Ray 2 (10°) is 40 km: it is in sector N only. Ray 36 (180°) also 40 km, in S only.
    const r = rays(400, { 2: 40000, 36: 40000 });
    const sectors: Record<Sector, number> = { ...shelterFromFetch(r, cfg), N: 0.5, S: 0.4 };
    expect(swellProtection(r, sectors, cfg)).toBe(0.4);
  });

  it("swell is reduced when the rays above 10 km span more than 60°", () => {
    // 13 rays of 40 km (indices 12..24 = 65°): NE, E and SE all reach 40 km; E is the least sheltered.
    const r = rays(400, Object.fromEntries(range(12, 24).map((i) => [i, 40000])));
    const sectors: Record<Sector, number> = { ...shelterFromFetch(r, cfg), NE: 0.6, E: 0.3, SE: 0.5 };
    expect(swellProtection(r, sectors, cfg)).toBe(0.15);
    // 12 rays (60°) are not wider than 60° → no reduction.
    const r12 = rays(400, Object.fromEntries(range(12, 23).map((i) => [i, 40000])));
    expect(swellProtection(r12, sectors, cfg)).toBe(0.3);
  });

  it("two opposite open rays (0° and 180°) → opening bearing null, width 10", () => {
    expect(opening(rays(400, { 0: 5000, 36: 5000 }), cfg)).toEqual({ bearingDeg: null, widthDeg: 10 });
  });

  it("opening with no open ray is { null, 0 }; a ray at exactly 2 km is not open", () => {
    expect(opening(rays(400, { 5: 2000 }), cfg)).toEqual({ bearingDeg: null, widthDeg: 0 });
  });

  it("opening bearing wraps around north", () => {
    expect(opening(rays(400, { 70: 5000, 71: 5000, 0: 5000 }), cfg)).toEqual({ bearingDeg: 355, widthDeg: 15 });
    expect(opening(rays(400, { 71: 5000, 0: 5000, 1: 5000 }), cfg)).toEqual({ bearingDeg: 0, widthDeg: 15 });
  });

  it("sectorFetch is the rounded mean of the sector's 9 rays", () => {
    const fetch = sectorFetch(rays(400, { 68: 1000, 4: 1001, 5: 99999 }), cfg);
    // N: 7 × 400 + 1000 + 1001 = 4801 → 533.44 → 533
    expect(fetch.N).toBe(533);
    // NE (indices 5..13): 8 × 400 + 99999 = 103199 → 11466.56 → 11467
    expect(fetch.NE).toBe(11467);
    expect(fetch.S).toBe(400);
  });

  it("rejects a ray array of the wrong length", () => {
    expect(() => shelterFromFetch([400, 400], cfg)).toThrow(/72/);
  });
});
