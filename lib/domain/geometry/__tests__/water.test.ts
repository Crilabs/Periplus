import { sql } from "drizzle-orm";
import type { Geometry } from "geojson";
import { describe, expect, it } from "vitest";
import { loadConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { geomFromGeoJson } from "@/lib/db/geometry";
import { withRollback } from "@/test/db";
import { circle, difference, insertLand, lonLatOf, rect } from "@/test/geometry/synthetic";
import { resolveOrigin, waterArea, type LonLat } from "../water";

const cfg = loadConfig("config").geometry.water;

const point = (p: LonLat): Geometry => ({ type: "Point", coordinates: [p.lon, p.lat] });

/** Area in m² (EPSG:32634) of a WGS84 GeoJSON geometry. */
async function areaM2(tx: Db, g: Geometry): Promise<number> {
  const { rows } = await tx.execute<{ a: number }>(sql`select ST_Area(ST_Transform(${geomFromGeoJson(g)}, 32634)) as a`);
  return Number(rows[0]!.a);
}

/** WGS84 GeoJSON polygon of an EPSG:32634 WKT polygon. */
async function polygonOf(tx: Db, wkt: string): Promise<Geometry> {
  const { rows } = await tx.execute<{ g: Geometry }>(
    sql`select ST_AsGeoJSON(ST_Transform(ST_GeomFromText(${wkt}, 32634), 4326), 9)::json as g`,
  );
  return rows[0]!.g;
}

const within = (value: number, expected: number, share: number) =>
  expect(Math.abs(value / expected - 1), `${value} vs ${expected}`).toBeLessThanOrEqual(share);

describe("waterArea", () => {
  it("point bay → 600 m circle minus land; harbour point → 250 m circle (area π·250² ±2 %)", () =>
    withRollback(async (tx) => {
      // Land north of y = 0: a circle around (0, 0) keeps its southern half.
      await insertLand(tx, [rect(-5000, 0, 5000, 5000)]);
      const center = await lonLatOf(tx, 0, 0);
      const bay = await waterArea(tx, { geom: point(center), center, isHarbour: false }, cfg);
      expect(bay.source).toBe("circle");
      expect(bay.geometry).not.toBeNull();
      within(await areaM2(tx, bay.geometry!), (Math.PI * 600 ** 2) / 2, 0.02);
      within(bay.widthM, 600, 0.02); // inscribed circle of a half disc: diameter = radius
      expect(bay.key).toMatch(/^[0-9a-f]{32}$/);

      const harbourCenter = await lonLatOf(tx, 0, -2000);
      const harbour = await waterArea(tx, { geom: point(harbourCenter), center: harbourCenter, isHarbour: true }, cfg);
      expect(harbour.source).toBe("circle");
      within(await areaM2(tx, harbour.geometry!), Math.PI * 250 ** 2, 0.02);
      within(harbour.widthM, 500, 0.02);
    }));

  it("bay polygon minus land; polygon over 4 km² is cut to the 600 m circle", () =>
    withRollback(async (tx) => {
      await insertLand(tx, [rect(-5000, 0, 5000, 5000)]);
      const center = await lonLatOf(tx, 0, -100);

      const small = await waterArea(tx, { geom: await polygonOf(tx, rect(-500, -500, 500, 500)), center, isHarbour: false }, cfg);
      expect(small.source).toBe("polygon");
      within(await areaM2(tx, small.geometry!), 1000 * 500, 0.01);
      within(small.widthM, 500, 0.02);

      const large = await waterArea(tx, { geom: await polygonOf(tx, rect(-2000, -2000, 2000, 2000)), center, isHarbour: false }, cfg);
      expect(large.source).toBe("polygon");
      // 600 m circle around (0, -100) minus land north of y = 0: circle area minus the segment above y = 0.
      const r = 600;
      const h = 100;
      const segment = r * r * Math.acos(h / r) - h * Math.sqrt(r * r - h * h);
      within(await areaM2(tx, large.geometry!), Math.PI * r * r - segment, 0.02);

      // The same polygon gives the same key; a different one a different key.
      const again = await waterArea(tx, { geom: await polygonOf(tx, rect(-500, -500, 500, 500)), center, isHarbour: false }, cfg);
      expect(again.key).toBe(small.key);
      expect(large.key).not.toBe(small.key);
    }));

  it("water entirely on land → geometry null, key 'empty', resolveOrigin null", () =>
    withRollback(async (tx) => {
      await insertLand(tx, [rect(-5000, -5000, 5000, 5000)]);
      const center = await lonLatOf(tx, 0, 0);
      const water = await waterArea(tx, { geom: point(center), center, isHarbour: false }, cfg);
      expect(water).toEqual({ geometry: null, key: "empty", widthM: 0, source: "circle" });
      expect(await resolveOrigin(tx, { position: center, anchor: null, computedAnchor: null, water }, cfg)).toBeNull();
    }));

  it("an origin in the water stays where it is", () =>
    withRollback(async (tx) => {
      await insertLand(tx, [await difference(tx, rect(-5000, 0, 5000, 5000), await circle(tx, 0, 0, 500))]);
      const position = await lonLatOf(tx, 0, 100);
      const water = await waterArea(tx, { geom: point(position), center: position, isHarbour: false }, cfg);
      expect(await resolveOrigin(tx, { position, anchor: null, computedAnchor: null, water }, cfg)).toEqual({
        origin: position,
        source: "position",
      });
    }));
});
