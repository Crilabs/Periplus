import { sql } from "drizzle-orm";
import type { AppConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import type { PoiCategory } from "@/lib/db/schema";
import type { BerthStateLanding, BerthStateNearby } from "@/lib/db/schema/research-state";
import { freeFacts } from "./state-facts";

/*
 * What is reachable on land from a berth (spec 5.7, plan N4a task 5). The distance is the straight line times
 * `state.detourFactor` from the nearest positioned landing point. On foot: every POI but a landing object within
 * `footMaxM`. By transport: when a transport POI is within foot distance or a free fact proves bus or taxi at the
 * berth, the POIs of `transportCategories` up to `transportMaxM` with at least `transportMinSitelinks` Wikidata
 * sitelinks. Nearest first, at most `PER_CATEGORY` per category.
 */

const PER_CATEGORY = 10;

export type NearbyCandidate = { geoObjectId: string; category: PoiCategory; distanceM: number; sitelinks: number | null };

/**
 * Decides access per candidate. Foot first (a candidate within `footMaxM` is listed once, on foot); transport access
 * opens with a transport POI on foot or `transportFact`, then admits well known candidates of the configured
 * categories up to `transportMaxM`. Ordered by distance, then id; at most 10 per category. Pure.
 */
export function classifyNearby(candidates: NearbyCandidate[], state: AppConfig["research"]["state"], transportFact: boolean): BerthStateNearby[] {
  const onFoot = (c: NearbyCandidate) => c.distanceM <= state.footMaxM;
  const transportOpen = transportFact || candidates.some((c) => c.category === "transport" && onFoot(c));
  const listed: BerthStateNearby[] = [];
  for (const c of candidates) {
    if (c.category === "landing") continue;
    const entry = { geoObjectId: c.geoObjectId, category: c.category, distanceM: c.distanceM };
    if (onFoot(c)) {
      listed.push({ ...entry, access: "foot" });
    } else if (
      transportOpen &&
      c.distanceM <= state.transportMaxM &&
      state.transportCategories.includes(c.category) &&
      (c.sitelinks ?? 0) >= state.transportMinSitelinks
    ) {
      listed.push({ ...entry, access: "transport" });
    }
  }
  listed.sort((a, b) => a.distanceM - b.distanceM || (a.geoObjectId < b.geoObjectId ? -1 : 1));
  const perCategory = new Map<PoiCategory, number>();
  return listed.filter((n) => {
    const count = (perCategory.get(n.category) ?? 0) + 1;
    perCategory.set(n.category, count);
    return count <= PER_CATEGORY;
  });
}

/** Whether a free fact's subject category (trimmed, lower case) contains one of the `keywords` (lower case). Pure. */
export function hasTransportFact(facts: Array<{ subjectCategory: string | null }>, keywords: string[]): boolean {
  return facts.some((f) => {
    const category = f.subjectCategory?.trim().toLowerCase();
    return !!category && keywords.some((k) => category.includes(k.toLowerCase()));
  });
}

/** Whether a free fact of the place (done unit, active extractor, current version) proves bus, taxi or ferry there. */
export async function transportFactIn(db: Db, placeId: string, config: AppConfig): Promise<boolean> {
  return hasTransportFact(await freeFacts(db, placeId, config), config.research.state.transportKeywords);
}

/** The POIs around the positioned landing points and their access; without a positioned landing point, none. */
export async function reachable(
  db: Db,
  landing: BerthStateLanding[],
  config: AppConfig,
  opts: { transportFact: boolean },
): Promise<BerthStateNearby[]> {
  const state = config.research.state;
  const points = landing.flatMap((l) => (l.lon !== null && l.lat !== null ? [{ lon: l.lon, lat: l.lat }] : []));
  if (points.length === 0) return [];
  // the straight line that still can end within the largest limit
  const straightMaxM = Math.max(state.footMaxM, state.transportMaxM) / state.detourFactor;
  const { rows } = await db.execute<{ id: string; category: PoiCategory; straight_m: number; sitelinks: number | null }>(sql`
    with pts as (
      select ST_SetSRID(ST_MakePoint(p.lon, p.lat), 4326)::geography as geog
      from jsonb_to_recordset(${JSON.stringify(points)}::jsonb) as p(lon float8, lat float8)
    )
    select o.id, o.category::text as category, min(ST_Distance(o.centroid::geography, pts.geog)) as straight_m, max(w.sitelinks) as sitelinks
    from geo_objects o
    cross join pts
    left join wikidata_sitelinks w on w.wikidata_id = o.wikidata_id
    where o.type = 'poi' and o.category is not null and o.valid_to is null and o.merged_into_id is null
      and ST_DWithin(o.centroid::geography, pts.geog, ${straightMaxM}::float8)
    group by o.id, o.category
    order by o.id`);
  return classifyNearby(
    rows.map((r) => ({ geoObjectId: r.id, category: r.category, distanceM: Math.round(Number(r.straight_m) * state.detourFactor), sitelinks: r.sitelinks === null ? null : Number(r.sitelinks) })),
    state,
    opts.transportFact,
  );
}
