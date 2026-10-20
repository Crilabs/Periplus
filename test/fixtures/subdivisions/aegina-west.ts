import { sql } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import { geoObjects, subdivisions } from "@/lib/db/schema";
import { newPublicId } from "@/lib/domain/ids";
import type { Bbox } from "@/lib/domain/tiles";

/** Key of the test subdivision around the aegina-west fixtures (tile q025:813:510). */
export const AEGINA_WEST_KEY = "GR-AEGINA-WEST";
/** Its polygon box; the recorded Overpass/Wikidata fixtures were taken for exactly this box plus the buffer. */
export const AEGINA_WEST_BOX: Bbox = [23.25, 37.5, 23.5, 37.75];

const envelope = ([w, s, e, n]: Bbox) => sql`ST_Multi(ST_MakeEnvelope(${w}, ${s}, ${e}, ${n}, 4326))`;

/**
 * Inserts a country (`GR`), a first-level admin region and the subdivision `AEGINA_WEST_KEY` whose polygon is
 * `AEGINA_WEST_BOX`. `land_geom` is the box intersected with the land polygons present at this moment (null without
 * any), so import the land fixture first. The box lies inside the pilot box: run it in `withRollback`.
 */
export async function insertAeginaWest(
  db: Db,
  patch: Partial<typeof subdivisions.$inferInsert> = {},
): Promise<{ subdivisionId: string; regionId: string; countryId: string }> {
  const [w, s, e, n] = AEGINA_WEST_BOX;
  const [country] = await db
    .insert(geoObjects)
    .values({ type: "country", origin: "manual", tags: { country: "GR" }, geom: envelope([w - 0.5, s - 0.5, e + 0.5, n + 0.5]) })
    .returning({ id: geoObjects.id });
  const [region] = await db
    .insert(geoObjects)
    .values({
      type: "admin_region",
      origin: "manual",
      adminLevel: 5,
      tags: { country: "GR" },
      geom: envelope(AEGINA_WEST_BOX),
    })
    .returning({ id: geoObjects.id });
  const box = sql`ST_MakeEnvelope(${w}, ${s}, ${e}, ${n}, 4326)`;
  const [sub] = await db
    .insert(subdivisions)
    .values({
      publicId: newPublicId("sd"),
      key: AEGINA_WEST_KEY,
      country: "GR",
      geoObjectId: region!.id,
      geom: envelope(AEGINA_WEST_BOX),
      landGeom: sql`(select ST_Multi(ST_CollectionExtract(ST_Intersection(${box}, ST_UnaryUnion(ST_Collect(l.geom))), 3))
        from land_polygons l where l.geom && ${box} and ST_Intersects(l.geom, ${box}) having count(*) > 0)`,
      ...patch,
    })
    .returning({ id: subdivisions.id });
  return { subdivisionId: sub!.id, regionId: region!.id, countryId: country!.id };
}
