import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import type { Db } from "@/lib/db/client";
import { places } from "@/lib/db/schema";
import { geomFromGeoJson } from "@/lib/db/geometry";
import type { PlaceStatus } from "@/lib/db/schema";
import { insertProfile } from "@/test/consolidation";
import { withRollback } from "@/test/db";
import { insertNamedObject, insertTestSubdivision, insertTestTile } from "@/test/text";
import { popularityForPlaces } from "../popularity";

// synthetic places around 21.0° E / 35.2° N; one degree of latitude is 60 nm
const LON = 21.0;
const LAT = 35.2;

async function todayOf(tx: Db): Promise<string> {
  const { rows } = await tx.execute<{ d: string }>(sql`select current_date::text as d`);
  return rows[0]!.d;
}

async function seedPlace(
  tx: Db,
  subdivisionId: string,
  nmNorth: number,
  sources: number,
  status: PlaceStatus = "confirmed",
  at: { lon: number; lat: number } = { lon: LON, lat: LAT },
): Promise<string> {
  const lat = at.lat + nmNorth / 60;
  const LON = at.lon;
  const geoObjectId = await insertNamedObject(tx, { type: "bay", names: [{ name: "Test bay" }], lon: LON, lat, subdivisionId });
  const { rows } = await tx.execute<{ id: string }>(sql`select tile_id_for(ST_SetSRID(ST_MakePoint(${LON}, ${lat}), 4326)) as id`);
  await insertTestTile(tx, rows[0]!.id);
  await tx.insert(places).values({ geoObjectId, kind: "anchorage", status, position: geomFromGeoJson({ type: "Point", coordinates: [LON, lat] }) });
  await insertProfile(tx, geoObjectId, {}, {}, { sourcesCount: sources });
  return geoObjectId;
}

describe("popularityForPlaces", () => {
  it("normalises within 50 nm across subdivisions", async () => {
    await withRollback(async (tx) => {
      const x = await insertTestSubdivision(tx, "XT-POP-X", [20, 34, 22, 36]);
      const y = await insertTestSubdivision(tx, "XT-POP-Y", [20, 34, 22, 36]);
      const a = await seedPlace(tx, x.id, 0, 2);
      const b = await seedPlace(tx, y.id, 30, 8);
      const c = await seedPlace(tx, x.id, -80, 4);
      const p = await popularityForPlaces(tx, [a, b, c], await todayOf(tx), 50);
      expect(p.get(a)).toBeCloseTo(Math.log(3) / Math.log(9));
      expect(p.get(b)).toBeCloseTo(1);
      expect(p.get(c)).toBeCloseTo(1);
    });
  });

  it("a place without sources gets 0, a candidate place no value", async () => {
    await withRollback(async (tx) => {
      const x = await insertTestSubdivision(tx, "XT-POP-X", [20, 34, 22, 36]);
      const a = await seedPlace(tx, x.id, 0, 0);
      const b = await seedPlace(tx, x.id, 10, 5);
      const cand = await seedPlace(tx, x.id, 5, 50, "candidate");
      const p = await popularityForPlaces(tx, [a, b, cand], await todayOf(tx), 50);
      expect(p.get(a)).toBe(0);
      expect(p.get(b)).toBeCloseTo(1); // the candidate does not count towards the maximum
      expect(p.has(cand)).toBe(false);
    });
  });

  it("the longitude prefilter widens with latitude: 49 nm east-west at 69° N still counts, 51 nm does not", async () => {
    await withRollback(async (tx) => {
      const x = await insertTestSubdivision(tx, "XT-POP-N", [19, 68, 26, 70]);
      const lat = 69;
      const degPerNm = 1 / 60 / Math.cos((lat * Math.PI) / 180);
      const a = await seedPlace(tx, x.id, 0, 1, "confirmed", { lon: 21, lat });
      const near = await seedPlace(tx, x.id, 0, 8, "confirmed", { lon: 21 + 49 * degPerNm, lat });
      const far = await seedPlace(tx, x.id, 0, 99, "confirmed", { lon: 21 - 51 * degPerNm, lat });
      const p = await popularityForPlaces(tx, [a], await todayOf(tx), 50);
      expect(p.get(a)).toBeCloseTo(Math.log(2) / Math.log(9));
      expect(near).not.toBe(far);
    });
  });
});
