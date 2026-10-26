import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { geomFromGeoJson } from "@/lib/db/geometry";
import type { Db } from "@/lib/db/client";
import { geoObjects, placeWebsites, places } from "@/lib/db/schema";
import { currentPlaceWebsite } from "@/lib/domain/places/websites";
import { withRollback } from "@/test/db";

async function newPlace(tx: Db) {
  const geom = geomFromGeoJson({ type: "Point", coordinates: [23.5, 37.5] });
  const [g] = await tx.insert(geoObjects).values({ type: "harbour", origin: "import", geom }).returning({ id: geoObjects.id });
  const [p] = await tx.insert(places).values({ geoObjectId: g!.id, kind: "marina", position: geom }).returning({ id: places.id });
  return { geoObjectId: g!.id, placeId: p!.id };
}

describe("place_websites schema", () => {
  it("the current website is the newest row", async () => {
    await withRollback(async (tx) => {
      const { geoObjectId, placeId } = await newPlace(tx);
      expect(await currentPlaceWebsite(tx, placeId)).toBeNull();
      await tx
        .insert(placeWebsites)
        .values({ placeId, geoObjectId, url: "https://a.example/", urlNormalized: "https://a.example/", origin: "osm", bound: false, createdAt: new Date("2026-01-01") });
      await tx
        .insert(placeWebsites)
        .values({ placeId, geoObjectId, url: "https://b.example/", urlNormalized: "https://b.example/", origin: "wikidata", bound: true, createdAt: new Date("2026-02-01") });
      expect((await currentPlaceWebsite(tx, placeId))?.url).toBe("https://b.example/");
    });
  });

  it("accepts place_website for source_origin and serp_level", async () => {
    await withRollback(async (tx) => {
      const r = await tx.execute<{ o: string; l: string }>(sql`select 'place_website'::source_origin as o, 'place_website'::serp_level as l`);
      expect(r.rows[0]).toEqual({ o: "place_website", l: "place_website" });
    });
  });
});
