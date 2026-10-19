import { sql } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import type { GeoObjectType } from "@/lib/db/schema/geo";
import type { FactLevel } from "./schema-types";

/** Fact level by geo object type, for objects without a place; `null`: no facts (settlement). */
const LEVEL_BY_TYPE: Record<GeoObjectType, FactLevel | null> = {
  sea: "area",
  area: "area",
  gulf: "area",
  island: "island",
  islet: "island",
  archipelago: "island",
  coast_section: "island",
  cape: "cape_strait",
  strait: "cape_strait",
  channel: "cape_strait",
  poi: "poi",
  bay: "place",
  harbour: "place",
  settlement: null,
};

/** Types that take no facts without a place (`LEVEL_BY_TYPE` null). */
const NO_FACT_TYPES = (Object.keys(LEVEL_BY_TYPE) as GeoObjectType[]).filter((t) => LEVEL_BY_TYPE[t] === null);

/** SQL condition: the geo object (alias `o`) takes facts, as `levelFor` decides (a non-null level). */
export const takesFactsSql = sql`(o.type::text not in (${sql.join(
  NO_FACT_TYPES.map((t) => sql`${t}`),
  sql`, `,
)}) or exists (
  select 1 from places p
  where p.geo_object_id = o.id and p.status <> 'rejected' and p.valid_to is null and p.merged_into_id is null
))`;

/**
 * The fact level of a geo object: `place` if it has a valid, unmerged place that is not rejected; otherwise by
 * type. `null` for an unknown object or one that takes no facts.
 */
export async function levelFor(db: Db, geoObjectId: string): Promise<FactLevel | null> {
  const result = await db.execute<{ type: GeoObjectType; has_place: boolean }>(sql`
    select o.type, exists (
      select 1 from places p
      where p.geo_object_id = o.id and p.status <> 'rejected' and p.valid_to is null and p.merged_into_id is null
    ) as has_place
    from geo_objects o
    where o.id = ${geoObjectId}
  `);
  const row = result.rows[0];
  if (!row) return null;
  return row.has_place ? "place" : LEVEL_BY_TYPE[row.type];
}
