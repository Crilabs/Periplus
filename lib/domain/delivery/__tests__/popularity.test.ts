import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { getConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { places } from "@/lib/db/schema";
import type { PlaceStatus } from "@/lib/db/schema";
import { geomFromGeoJson } from "@/lib/db/geometry";
import { withRollback } from "@/test/db";
import { signalPage } from "@/test/research-signals";
import { insertNamedObject, insertTestSubdivision, insertTestTile } from "@/test/text";
import { popularity, popularityForPlaces, popularityFromCounts } from "../popularity";

// synthetic places around 21.0 E / 35.2 N; one degree of latitude is 60 nm
const LON = 21.0;
const LAT = 35.2;

async function todayOf(tx: Db): Promise<string> {
  const { rows } = await tx.execute<{ d: string }>(sql`select current_date::text as d`);
  return rows[0]!.d;
}

/** A place `nmNorth` of the origin with `sources` independent sources (one page each of its own domain). */
async function seedPlace(
  tx: Db,
  subdivisionId: string,
  nmNorth: number,
  sources: number,
  status: PlaceStatus = "confirmed",
  at: { lon: number; lat: number } = { lon: LON, lat: LAT },
): Promise<{ geoObjectId: string; placeId: string }> {
  const lat = at.lat + nmNorth / 60;
  const geoObjectId = await insertNamedObject(tx, { type: "bay", names: [{ name: "Test bay" }], lon: at.lon, lat, subdivisionId });
  const { rows } = await tx.execute<{ id: string }>(sql`select tile_id_for(ST_SetSRID(ST_MakePoint(${at.lon}, ${lat}), 4326)) as id`);
  await insertTestTile(tx, rows[0]!.id);
  const [place] = await tx
    .insert(places)
    .values({ geoObjectId, kind: "anchorage", status, position: geomFromGeoJson({ type: "Point", coordinates: [at.lon, lat] }) })
    .returning({ id: places.id });
  const placeId = place!.id;
  for (let i = 0; i < sources; i++) {
    await signalPage(tx, getConfig(), { placeId, objectId: geoObjectId }, { domain: `src-${i}-${placeId.slice(0, 8)}.example`, quote: `Unique words ${i} about ${placeId} at anchor` });
  }
  return { geoObjectId, placeId };
}

describe("popularity", () => {
  it("is 1 for the neighbourhood maximum and log-normalised below; 0 without sources", () => {
    expect(popularity(3, 15)).toBeCloseTo(0.5, 3);
    expect(popularity(15, 15)).toBe(1);
    expect(popularity(0, 15)).toBe(0);
    expect(popularity(0, 0)).toBe(0);
  });

  it("popularityFromCounts takes the maximum over the members, the place included; a member without a count is 0", () => {
    const nb = [
      { geoObjectId: "g1", placeId: "p1", members: [{ placeId: "p1", kind: "anchorage" as const }, { placeId: "p2", kind: "anchorage" as const }, { placeId: "p3", kind: "anchorage" as const }] },
    ];
    const v = popularityFromCounts(nb, new Map([["p1", 3], ["p2", 15]]));
    expect(v.get("g1")).toBeCloseTo(0.5, 3);
  });
});

describe("popularityForPlaces", () => {
  it("counts the independent sources of the confirmation, normalised within 50 nm across subdivisions", async () => {
    await withRollback(async (tx) => {
      const x = await insertTestSubdivision(tx, "XT-POP-X", [20, 34, 22, 36]);
      const y = await insertTestSubdivision(tx, "XT-POP-Y", [20, 34, 22, 36]);
      const a = await seedPlace(tx, x.id, 0, 2);
      const b = await seedPlace(tx, y.id, 30, 8);
      const c = await seedPlace(tx, x.id, -80, 4);
      const p = await popularityForPlaces(tx, [a, b, c].map((o) => o.geoObjectId), await todayOf(tx), 50);
      expect(p.get(a.geoObjectId)).toBeCloseTo(Math.log(3) / Math.log(9));
      expect(p.get(b.geoObjectId)).toBeCloseTo(1);
      expect(p.get(c.geoObjectId)).toBeCloseTo(1);
    });
  });

  it("two pages of one domain are one source; a place without evidence gets 0, a candidate no value and no weight", async () => {
    await withRollback(async (tx) => {
      const x = await insertTestSubdivision(tx, "XT-POP-X", [20, 34, 22, 36]);
      const a = await seedPlace(tx, x.id, 0, 0);
      const b = await seedPlace(tx, x.id, 10, 0);
      for (const quote of ["First crew words about the northern corner", "Second crew words about the sandy beach"]) {
        await signalPage(tx, getConfig(), { placeId: b.placeId, objectId: b.geoObjectId }, { domain: "one-domain.example", quote });
      }
      const cand = await seedPlace(tx, x.id, 5, 5, "candidate");
      const p = await popularityForPlaces(tx, [a, b, cand].map((o) => o.geoObjectId), await todayOf(tx), 50);
      expect(p.get(a.geoObjectId)).toBe(0);
      expect(p.get(b.geoObjectId)).toBeCloseTo(1); // one source is the maximum; the candidate's five do not count
      expect(p.has(cand.geoObjectId)).toBe(false);
    });
  });

  it("known counts are used as given and not loaded again", async () => {
    await withRollback(async (tx) => {
      const x = await insertTestSubdivision(tx, "XT-POP-X", [20, 34, 22, 36]);
      const a = await seedPlace(tx, x.id, 0, 1);
      const b = await seedPlace(tx, x.id, 10, 3);
      const p = await popularityForPlaces(tx, [a.geoObjectId], await todayOf(tx), 50, new Map([[a.placeId, 1], [b.placeId, 8]]));
      expect(p.get(a.geoObjectId)).toBeCloseTo(Math.log(2) / Math.log(9));
    });
  });

  it("the longitude prefilter widens with latitude: 49 nm east-west at 69 N still counts, 51 nm does not", async () => {
    await withRollback(async (tx) => {
      const x = await insertTestSubdivision(tx, "XT-POP-N", [19, 68, 26, 70]);
      const lat = 69;
      const degPerNm = 1 / 60 / Math.cos((lat * Math.PI) / 180);
      const a = await seedPlace(tx, x.id, 0, 1, "confirmed", { lon: 21, lat });
      await seedPlace(tx, x.id, 0, 8, "confirmed", { lon: 21 + 49 * degPerNm, lat });
      await seedPlace(tx, x.id, 0, 99, "confirmed", { lon: 21 - 51 * degPerNm, lat });
      const p = await popularityForPlaces(tx, [a.geoObjectId], await todayOf(tx), 50);
      expect(p.get(a.geoObjectId)).toBeCloseTo(Math.log(2) / Math.log(9));
    });
  });
});
