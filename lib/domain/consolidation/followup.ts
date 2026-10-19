import { sql } from "drizzle-orm";
import type { ConsolidationConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { countingSourceSql } from "./inputs";

/*
 * Follow-up of a consolidation (spec 07 Folgeaufträge, plan Task 15): a place with fewer than `followup.minDocuments`
 * documents gets a targeted source discovery, the tile templates with its own names (stage `discovery.place`, its
 * queries `placeQueries` in `lib/domain/discovery/queries.ts`).
 */

/**
 * The thin places among `geoObjectIds` on the run date `today` (`YYYY-MM-DD`): valid geo objects with a valid, unmerged
 * place of status `candidate` or `confirmed` that have fewer than `cfg.minDocuments` documents (distinct documents with
 * a mention of the object or of an object merged into it, from sources neither rejected nor ended, as the profile's
 * `documentsCount`) and no `place_discovery_requests` row within the `cfg.cooldownDays` before `today`. Fewest documents
 * first, then by id; only places `accept` takes (e.g. those with queries; default all), at most `cfg.maxPlacesPerRun`.
 */
export async function thinPlaces(
  db: Db,
  geoObjectIds: string[],
  cfg: ConsolidationConfig["followup"],
  today: string,
  accept: (geoObjectId: string) => Promise<boolean> = async () => true,
): Promise<string[]> {
  if (geoObjectIds.length === 0) return [];
  const { rows } = await db.execute<{ id: string }>(sql`
    with recursive targets(id) as (
      select distinct value::uuid from jsonb_array_elements_text(${JSON.stringify(geoObjectIds)}::jsonb)
    ),
    chain(root, id) as (
      select id, id from targets
      union
      select c.root, o.id from geo_objects o join chain c on o.merged_into_id = c.id
    ),
    docs as (
      select c.root, count(distinct d.id)::int as n
      from chain c
      join mentions m on m.geo_object_id = c.id
      join document_versions v on v.id = m.document_version_id
      join documents d on d.id = v.document_id
      join sources s on s.id = d.source_id
      where ${countingSourceSql(today)}
      group by c.root
    )
    select t.id
    from targets t
    join geo_objects o on o.id = t.id and o.merged_into_id is null
      and o.valid_from <= ${today}::date and (o.valid_to is null or o.valid_to > ${today}::date)
    left join docs on docs.root = t.id
    where coalesce(docs.n, 0) < ${cfg.minDocuments}
      and exists (
        select 1 from places p
        where p.geo_object_id = t.id and p.status in ('candidate', 'confirmed') and p.merged_into_id is null
          and p.valid_from <= ${today}::date and (p.valid_to is null or p.valid_to > ${today}::date)
      )
      and not exists (
        select 1 from place_discovery_requests r
        where r.geo_object_id = t.id
          and r.requested_at >= ((${today}::date - ${cfg.cooldownDays}::int)::timestamp at time zone 'UTC')
      )
    order by coalesce(docs.n, 0), t.id
  `);
  const out: string[] = [];
  for (const { id } of rows) {
    if (out.length >= cfg.maxPlacesPerRun) break;
    if (await accept(id)) out.push(id);
  }
  return out;
}
