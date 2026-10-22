import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { geomFromGeoJson } from "@/lib/db/geometry";
import type { Db } from "@/lib/db/client";
import { geoObjects, placeWebsites, places } from "@/lib/db/schema";
import { currentPlaceWebsite } from "@/lib/domain/places/websites";
import { withRollback } from "@/test/db";

async function rejectionMessage(tx: Db, run: (tx: Db) => Promise<unknown>): Promise<string> {
  try {
    await tx.transaction(async (sp) => {
      await run(sp);
    });
  } catch (e) {
    const err = e as Error;
    return `${err.message} ${(err.cause as Error | undefined)?.message ?? ""}`;
  }
  throw new Error("expected promise to reject");
}

async function newPlace(tx: Db) {
  const geom = geomFromGeoJson({ type: "Point", coordinates: [23.5, 37.5] });
  const [g] = await tx.insert(geoObjects).values({ type: "harbour", origin: "import", geom }).returning({ id: geoObjects.id });
  const [p] = await tx.insert(places).values({ geoObjectId: g!.id, kind: "marina", position: geom }).returning({ id: places.id });
  return { geoObjectId: g!.id, placeId: p!.id };
}

describe("place_websites schema", () => {
  it("is append-only and the current website is the newest row", async () => {
    await withRollback(async (tx) => {
      const { geoObjectId, placeId } = await newPlace(tx);
      expect(await currentPlaceWebsite(tx, placeId)).toBeNull();
      const [a] = await tx
        .insert(placeWebsites)
        .values({ placeId, geoObjectId, url: "https://a.example/", urlNormalized: "https://a.example/", origin: "osm", bound: false, createdAt: new Date("2026-01-01") })
        .returning({ id: placeWebsites.id });
      await tx
        .insert(placeWebsites)
        .values({ placeId, geoObjectId, url: "https://b.example/", urlNormalized: "https://b.example/", origin: "wikidata", bound: true, createdAt: new Date("2026-02-01") });
      expect((await currentPlaceWebsite(tx, placeId))?.url).toBe("https://b.example/");

      const update = await rejectionMessage(tx, (sp) => sp.update(placeWebsites).set({ bound: true }).where(eq(placeWebsites.id, a!.id)));
      expect(update).toContain("place_websites is append-only");
      const del = await rejectionMessage(tx, (sp) => sp.delete(placeWebsites).where(eq(placeWebsites.id, a!.id)));
      expect(del).toContain("place_websites is append-only");
      const trunc = await rejectionMessage(tx, (sp) => sp.execute(sql`TRUNCATE place_websites`));
      expect(trunc).toContain("place_websites is append-only");
    });
  });

  it("accepts place_website for source_origin and serp_level", async () => {
    await withRollback(async (tx) => {
      const r = await tx.execute<{ o: string; l: string }>(sql`select 'place_website'::source_origin as o, 'place_website'::serp_level as l`);
      expect(r.rows[0]).toEqual({ o: "place_website", l: "place_website" });
    });
  });
});
