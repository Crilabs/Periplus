import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { regionSchema } from "@/contract/v3_0";
import { loadConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { withRollback } from "@/test/db";
import { seedDeliverySubdivision } from "@/test/fixtures/delivery/subdivision";
import { loadSubdivisionScope } from "../load";
import { assignRegions, mapRegion, namedRegions, REGION_TYPE, regionIdAt } from "../map-region";
import type { RegionSource } from "../types";

const cfg = loadConfig("config").delivery;
const MARGIN = cfg.regions.memberMarginNm;
const id = (prefix: "sp" | "rg", n: number) => `${prefix}_01J9ZD${String(n).padStart(20, "0")}`;

const square = (w: number, s: number, e: number, n: number): GeoJSON.Polygon => ({
  type: "Polygon",
  coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]],
});

function region(n: number, o: Partial<RegionSource> = {}): RegionSource {
  return {
    geoObjectId: `g${n}`,
    publicId: id("rg", n),
    type: "island",
    name: `Region ${n}`,
    names: [],
    polygon: null,
    center: { lon: 21.1, lat: 35.1 },
    radiusNm: 2,
    areaKm2: null,
    parentGeoObjectIds: [],
    ...o,
  };
}

// archipelago 21.0–21.4 × 35.0–35.3 (≈ 1200 km²) holding the island 21.05–21.2 × 35.05–35.15 (≈ 150 km²)
const archipelago = region(2, { type: "archipelago", polygon: square(21.0, 35.0, 21.4, 35.3), areaKm2: 1200, radiusNm: 12 });
const island = region(1, { polygon: square(21.05, 35.05, 21.2, 35.15), areaKm2: 150, radiusNm: 5, parentGeoObjectIds: ["g2"] });
const onIsland = { id: id("sp", 1), position: { lon: 21.1, lat: 35.1 } };
const onArchipelago = { id: id("sp", 2), position: { lon: 21.3, lat: 35.25 } };
const outside = { id: id("sp", 3), position: { lon: 22, lat: 36 } };

describe("assignRegions", () => {
  it("a spot inside an island inside an archipelago belongs to the island; the archipelago lists both", () => {
    const { regionIdBySpot, spotIdsByRegion } = assignRegions([onArchipelago, onIsland, outside], [archipelago, island], MARGIN);
    expect(regionIdBySpot.get(onIsland.id)).toBe(island.publicId);
    expect(regionIdBySpot.get(onArchipelago.id)).toBe(archipelago.publicId);
    expect(regionIdBySpot.get(outside.id)).toBeNull();
    expect(spotIdsByRegion.get(archipelago.publicId)).toEqual([onIsland.id, onArchipelago.id]);
    expect(spotIdsByRegion.get(island.publicId)).toEqual([onIsland.id]);
  });

  it("a region known as a point contains what lies within its radius but never wins over a polygon region (ruling M6-E-R2)", () => {
    const point = region(3, { type: "gulf", center: { lon: 21.3, lat: 35.25 }, radiusNm: 2 });
    const { regionIdBySpot, spotIdsByRegion } = assignRegions([onArchipelago, onIsland], [archipelago, point], MARGIN);
    // its circle (π · 3.7² ≈ 43 km²) is smaller than the archipelago, but a point has no area to compare
    expect(regionIdBySpot.get(onArchipelago.id)).toBe(archipelago.publicId);
    expect(spotIdsByRegion.get(point.publicId)).toEqual([onArchipelago.id]);
    expect(regionIdAt([archipelago, point], MARGIN)({ lon: 21.1, lat: 35.1 })).toBe(archipelago.publicId);
    // a point archipelago around an island polygon: the island
    const pointArchipelago = region(4, { type: "archipelago", center: { lon: 21.1, lat: 35.1 }, radiusNm: 2 });
    expect(regionIdAt([pointArchipelago, island], MARGIN)(onIsland.position)).toBe(island.publicId);
    // outside every polygon: the smallest point region holding it, then the smaller id
    const wide = region(5, { type: "gulf", center: { lon: 21.3, lat: 35.25 }, radiusNm: 5 });
    const twin = region(6, { type: "gulf", center: { lon: 21.3, lat: 35.25 }, radiusNm: 2 });
    expect(regionIdAt([wide, twin, point], MARGIN)({ lon: 21.3, lat: 35.25 })).toBe(point.publicId);
    expect(regionIdAt([wide, twin], MARGIN)({ lon: 21.3, lat: 35.25 })).toBe(twin.publicId);
  });

  it("a polygon region without area (0 km²) does not compete by size either", () => {
    const flat = region(7, { type: "channel", polygon: square(21.29, 35.24, 21.31, 35.26), areaKm2: 0, radiusNm: 0.1 });
    expect(regionIdAt([flat, archipelago], MARGIN)(onArchipelago.position)).toBe(archipelago.publicId);
    expect(regionIdAt([flat], MARGIN)(onArchipelago.position)).toBe(flat.publicId);
  });

  it("a spot in an island's bay, within memberMarginNm of its land polygon, belongs to the island (ruling M6-C-R1)", () => {
    expect(MARGIN).toBe(0.5);
    // 0.3 nm north of the island's north coast (35.15): in the water of its bay, inside the archipelago
    const inBay = { id: id("sp", 4), position: { lon: 21.1, lat: 35.155 } };
    // 0.9 nm north of it: in the archipelago only
    const offshore = { id: id("sp", 5), position: { lon: 21.1, lat: 35.165 } };
    // 0.4 nm east of a lone rock outside the archipelago
    const rock = region(7, { polygon: square(21.6, 35.5, 21.61, 35.51), areaKm2: 1, radiusNm: 0.5 });
    const nearRock = { id: id("sp", 6), position: { lon: 21.618, lat: 35.505 } };
    const { regionIdBySpot, spotIdsByRegion } = assignRegions([inBay, offshore, nearRock], [archipelago, island, rock], MARGIN);
    expect(regionIdBySpot.get(inBay.id)).toBe(island.publicId);
    expect(regionIdBySpot.get(offshore.id)).toBe(archipelago.publicId);
    expect(regionIdBySpot.get(nearRock.id)).toBe(rock.publicId);
    expect(spotIdsByRegion.get(island.publicId)).toEqual([inBay.id]);
    expect(spotIdsByRegion.get(archipelago.publicId)).toEqual([inBay.id, offshore.id]);
    // two islands within the margin: the smaller one wins
    const islet = region(8, { polygon: square(21.1, 35.156, 21.101, 35.157), areaKm2: 0.01, radiusNm: 0.1 });
    expect(regionIdAt([archipelago, island, islet], MARGIN)(inBay.position)).toBe(islet.publicId);
    // a point region takes no margin: only its radius
    const point = region(9, { type: "gulf", polygon: null, center: { lon: 22, lat: 36 }, radiusNm: 1 });
    expect(regionIdAt([point], MARGIN)({ lon: 22, lat: 36 + 1.2 / 60 })).toBeNull();
  });
});

describe("mapRegion", () => {
  const publicIds = new Map([
    ["g1", island.publicId],
    ["g2", archipelago.publicId],
  ]);

  it("region parent is the nearest delivered ancestor, else null", () => {
    expect(mapRegion(island, { regionPublicIds: publicIds, spotIds: [] }).parentId).toBe(archipelago.publicId);
    // an ancestor not in the package (ended, no region kind, an administrative unit) is skipped
    const deep = region(4, { parentGeoObjectIds: ["ended", "g2", "admin"] });
    expect(mapRegion(deep, { regionPublicIds: publicIds, spotIds: [] }).parentId).toBe(archipelago.publicId);
    expect(mapRegion(archipelago, { regionPublicIds: publicIds, spotIds: [] }).parentId).toBeNull();
    expect(mapRegion(region(5, { parentGeoObjectIds: ["ended", "admin"] }), { regionPublicIds: publicIds, spotIds: [] }).parentId).toBeNull();
  });

  it("coast_section maps to type coast", () => {
    expect(REGION_TYPE.coast_section).toBe("coast");
    expect(REGION_TYPE.island).toBe("island");
    expect(mapRegion(region(6, { type: "coast_section" }), { regionPublicIds: publicIds, spotIds: [] }).type).toBe("coast");
  });

  it("maps rounding, sorted spot ids and a radius of at least 0.1 nm", () => {
    const src = region(1, {
      polygon: square(21.05, 35.05, 21.2, 35.15),
      center: { lon: 21.1234567, lat: 35.1234544 },
      radiusNm: 0.04,
      names: [{ lang: "en", name: "Nisida" }],
    });
    const body = mapRegion(src, { regionPublicIds: publicIds, spotIds: [id("sp", 9), id("sp", 1)] });
    expect(body).toMatchObject({
      id: id("rg", 1),
      name: "Region 1",
      names: [{ lang: "en", name: "Nisida" }],
      center: { lon: 21.12346, lat: 35.12345 },
      radiusNm: 0.1,
      spotIds: [id("sp", 1), id("sp", 9)],
    });
    expect(body.polygon).toEqual(src.polygon);
    expect(regionSchema.safeParse({ ...body, profileVersion: 1, validFrom: "2026-10-19" }).error?.issues).toBeUndefined();
  });

  it("a region has no facts and no character (no profiles any more), no polygon or names unless known", () => {
    const bare = mapRegion(region(1), { regionPublicIds: publicIds, spotIds: [] });
    expect(bare).not.toHaveProperty("facts");
    expect(bare).not.toHaveProperty("character");
    expect(bare).not.toHaveProperty("polygon");
    expect(bare).not.toHaveProperty("names");
  });

  it("a region without a valid name is left out with a warning", () => {
    const { regions, dropped } = namedRegions([region(1), region(2, { name: "" }), region(3, { name: "  " })]);
    expect(regions.map((r) => r.publicId)).toEqual([id("rg", 1)]);
    expect(dropped).toEqual([
      { id: id("rg", 2), reason: "no_name" },
      { id: id("rg", 3), reason: "no_name" },
    ]);
  });
});

async function dbToday(tx: Db): Promise<string> {
  const { rows } = await tx.execute<{ today: string }>(sql`select current_date::text as today`);
  return rows[0]!.today;
}

describe("regions of the delivery fixture", () => {
  it("map from the loader to contract regions: the island under the archipelago, the archipelago at the top (its parent is the admin region)", async () => {
    await withRollback(async (tx) => {
      const f = await seedDeliverySubdivision(tx);
      const scope = await loadSubdivisionScope(tx, f.subdivisionId, cfg, await dbToday(tx));
      const { regions } = namedRegions(scope.regions);
      const spots = scope.spots.map((s) => ({ id: s.publicId, position: s.position }));
      const { regionIdBySpot, spotIdsByRegion } = assignRegions(spots, regions, MARGIN);
      const publicIds = new Map(regions.map((r) => [r.geoObjectId, r.publicId]));
      const bodies = regions.map((r) =>
        mapRegion(r, { regionPublicIds: publicIds, spotIds: spotIdsByRegion.get(r.publicId) ?? [] }),
      );
      const islandBody = bodies.find((b) => b.id === f.islandPublicId)!;
      const archipelagoBody = bodies.find((b) => b.id === f.archipelagoPublicId)!;
      expect(islandBody).toMatchObject({
        type: "island",
        parentId: f.archipelagoPublicId,
      });
      // A lies in the bay notch, outside the island's land polygon but within memberMarginNm of it (ruling M6-C-R1)
      expect(regionIdBySpot.get(f.places.A.publicId!)).toBe(f.islandPublicId);
      expect(islandBody.spotIds).toContain(f.places.A.publicId!);
      expect(archipelagoBody.parentId).toBeNull();
      for (const b of bodies) expect(regionSchema.safeParse({ ...b, profileVersion: 1, validFrom: "2026-10-19" }).error?.issues).toBeUndefined();
    });
  });
});
