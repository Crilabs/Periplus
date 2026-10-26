import { and, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import { geoNames, geoObjects, reviewTasks, tiles, type GeoObjectType } from "@/lib/db/schema";
import { validAt } from "@/lib/db/valid-at";
import { tilesInBbox, type Bbox } from "@/lib/domain/tiles";

const REQUIRED_LANGUAGES = ["de", "en", "el"];
const CHECKED_TYPES: GeoObjectType[] = ["island", "islet", "settlement", "bay"];

export type GazetteerCheck = {
  tilesWithCoast: number;
  missing: Array<{ id: string; type: GeoObjectType; name: string; languages: string[] }>;
  openCandidateTasks: number;
};

/**
 * Acceptance check of the gazetteer inside `tileBbox`: every valid island, islet, settlement and named bay
 * whose centroid lies in the box needs one valid name each in de, en and el (`missing` lists the gaps with
 * the languages they do have), plus the number of valid coast tiles and open `place_candidate` tasks (places and pairs, not area-scoped:
 * the queue must be empty for acceptance).
 */
export async function checkGazetteer(db: Db, tileBbox: Bbox): Promise<GazetteerCheck> {
  const [west, south, east, north] = tileBbox;
  const inBox = sql`ST_Intersects(${geoObjects.centroid}, ST_MakeEnvelope(${west}, ${south}, ${east}, ${north}, 4326))`;

  const objects = await db
    .select({ id: geoObjects.id, type: geoObjects.type })
    .from(geoObjects)
    .where(and(validAt(geoObjects), inArray(geoObjects.type, CHECKED_TYPES), inBox));
  const names = objects.length
    ? await db
        .select({ geoObjectId: geoNames.geoObjectId, name: geoNames.name, language: geoNames.language, isPreferred: geoNames.isPreferred })
        .from(geoNames)
        .where(and(validAt(geoNames), inArray(geoNames.geoObjectId, objects.map((o) => o.id))))
    : [];

  const byObject = new Map<string, typeof names>();
  for (const n of names) byObject.set(n.geoObjectId, [...(byObject.get(n.geoObjectId) ?? []), n]);

  const missing: GazetteerCheck["missing"] = [];
  for (const o of objects) {
    const own = byObject.get(o.id) ?? [];
    // An unnamed bay is not an anchorage candidate: only named bays are checked.
    if (o.type === "bay" && own.length === 0) continue;
    const languages = [...new Set(own.map((n) => n.language))].sort();
    if (REQUIRED_LANGUAGES.every((l) => languages.includes(l))) continue;
    const label = own.find((n) => n.isPreferred) ?? own[0];
    missing.push({ id: o.id, type: o.type, name: label?.name ?? "(ohne Namen)", languages });
  }
  missing.sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));

  const [coast] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(tiles)
    .where(and(validAt(tiles), eq(tiles.hasCoast, true), inArray(tiles.id, tilesInBbox(tileBbox))));
  const [open] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(reviewTasks)
    .where(and(eq(reviewTasks.kind, "place_candidate"), eq(reviewTasks.status, "open")));

  return { tilesWithCoast: coast!.n, missing, openCandidateTasks: open!.n };
}
