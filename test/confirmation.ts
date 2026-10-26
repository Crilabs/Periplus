import { eq } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import { geoObjects, places, type PlaceKind, type PlaceStatus } from "@/lib/db/schema";
import { insertPlace } from "@/test/consolidation";

/*
 * Fixtures for the confirmation by evidence (spec 17): places of a kind and status. Meant for `withRollback`; objects at 21.0° E / 35.2° N.
 */

/** A place of `kind` and `status` (default a candidate anchorage) on a new bay, with OSM `tags`. */
export async function placeOf(
  tx: Db,
  o: { kind?: PlaceKind; status?: PlaceStatus; tags?: Record<string, string>; publicId?: string | null } = {},
): Promise<{ objectId: string; placeId: string }> {
  const p = await insertPlace(tx, { status: o.status ?? "candidate" });
  await tx.update(places).set({ kind: o.kind ?? "anchorage", publicId: o.publicId ?? null }).where(eq(places.id, p.placeId));
  if (o.tags) await tx.update(geoObjects).set({ tags: o.tags }).where(eq(geoObjects.id, p.objectId));
  return p;
}
