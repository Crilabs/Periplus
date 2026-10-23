import { and, eq, inArray, isNull } from "drizzle-orm";
import { getConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { documents, documentVersions, geoNames, places, researchRouteStops } from "@/lib/db/schema";
import { normalizeName } from "@/lib/domain/gazetteer/names";
import { registrableDomain } from "@/lib/domain/sources/urls";

/*
 * Names that the anchored discovery gave an unnamed bay (`origin research`, plan N2 task 5) are provisional: never
 * preferred, and not used to search for the place or to match other pages' berths and stops to it, until the same
 * normalized name for the same geo object came from route stops of at least `discovery.corroboratingDomains`
 * different registrable domains. Pages already linked to the place through a route stop still find it under the name (unit text).
 */

/** Ids of the valid `research` names of the objects that are not corroborated yet. */
export async function provisionalNameIds(
  db: Db,
  geoObjectIds: string[],
  minDomains: number = getConfig().research.discovery.corroboratingDomains,
): Promise<Set<string>> {
  const out = new Set<string>();
  if (geoObjectIds.length === 0) return out;
  const names = await db
    .select({ id: geoNames.id, geoObjectId: geoNames.geoObjectId, normalized: geoNames.nameNormalized })
    .from(geoNames)
    .where(and(inArray(geoNames.geoObjectId, geoObjectIds), eq(geoNames.origin, "research"), isNull(geoNames.validTo)));
  if (names.length === 0) return out;
  const stops = await db
    .select({ geoObjectId: places.geoObjectId, name: researchRouteStops.name, url: documents.url })
    .from(researchRouteStops)
    .innerJoin(places, eq(places.id, researchRouteStops.placeId))
    .innerJoin(documentVersions, eq(documentVersions.id, researchRouteStops.documentVersionId))
    .innerJoin(documents, eq(documents.id, documentVersions.documentId))
    .where(inArray(places.geoObjectId, [...new Set(names.map((n) => n.geoObjectId))]));
  const domains = new Map<string, Set<string>>();
  for (const s of stops) {
    const key = `${s.geoObjectId}:${normalizeName(s.name)}`;
    (domains.get(key) ?? domains.set(key, new Set()).get(key)!).add(registrableDomain(s.url));
  }
  for (const n of names) {
    if ((domains.get(`${n.geoObjectId}:${n.normalized}`)?.size ?? 0) < minDomains) out.add(n.id);
  }
  return out;
}
