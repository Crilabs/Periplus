import { sql } from "drizzle-orm";
import type { SpotsFile } from "@/contract/v3_0";
import type { Archive } from "@/lib/adapters/s3";
import type { Db } from "@/lib/db/client";
import { validAtAlias } from "@/lib/domain/timeline";
import { readJsonFile, validDelivery } from "../read";
import type { LonLat } from "../types";
import { isHomeMarina } from "./load";

/*
 * The home marinas a client can offer (spec 18): the marinas of the current valid `spots.json` of every active
 * subdivision, by the same rule as `resolveHomeMarina`. The list of one package never changes, so it is cached in
 * process (the latest delivery per subdivision). With a bbox only the subdivisions whose polygon intersects it are
 * read. A package that cannot be read throws, as everywhere in delivery reading.
 */

export type HomeMarina = { id: string; name: string; position: LonLat; subdivision: string };
export type Bbox = [number, number, number, number];

/** Subdivision id → its latest delivery and that delivery's home marinas. */
const cache = new Map<string, { deliveryId: string; marinas: HomeMarina[] }>();

/** `w,s,e,n` in degrees with `w ≤ e`, `s ≤ n`, longitudes within ±180 and latitudes within ±90; null otherwise. */
export function parseBbox(value: string): Bbox | null {
  const parts = value.split(",");
  if (parts.length !== 4 || parts.some((p) => p.trim() === "")) return null;
  const [w, s, e, n] = parts.map(Number) as Bbox;
  if (![w, s, e, n].every(Number.isFinite)) return null;
  if (w > e || s > n || w < -180 || e > 180 || s < -90 || n > 90) return null;
  return [w, s, e, n];
}

/** The home marinas of every active valid subdivision, optionally inside `bbox` (`[west, south, east, north]`), sorted by id. */
export async function listHomeMarinas(db: Db, archive: Archive, bbox?: Bbox): Promise<HomeMarina[]> {
  const area = bbox ? sql`and ST_Intersects(s.geom, ST_MakeEnvelope(${bbox[0]}, ${bbox[1]}, ${bbox[2]}, ${bbox[3]}, 4326))` : sql``;
  const { rows } = await db.execute<{ id: string; public_id: string }>(sql`
    select s.id, s.public_id from subdivisions s
    where s.status = 'active' and ${validAtAlias("s")} ${area}
    order by s.key, s.id
  `);
  const out: HomeMarina[] = [];
  for (const sub of rows) {
    const delivery = await validDelivery(db, sub.id);
    if (!delivery) continue;
    let hit = cache.get(sub.id);
    if (hit?.deliveryId !== delivery.id) {
      const marinas = (await readJsonFile<SpotsFile>(archive, delivery, "spots.json")).spots
        .filter(isHomeMarina)
        .map((s) => ({ id: s.id, name: s.name, position: s.position, subdivision: sub.public_id }));
      hit = { deliveryId: delivery.id, marinas };
      cache.set(sub.id, hit);
    }
    out.push(...hit.marinas);
  }
  const inside = bbox ? out.filter((m) => m.position.lon >= bbox[0] && m.position.lon <= bbox[2] && m.position.lat >= bbox[1] && m.position.lat <= bbox[3]) : out;
  return inside.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
