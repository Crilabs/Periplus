import { sql } from "drizzle-orm";
import { getConfig, type AreaConfig, type ConsolidationConfig, type DiscoveryConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { buildQueries, dedupeQueries, namesByLanguage, templatesFor, type DiscoveryQuery } from "@/lib/domain/discovery/queries";
import { createLogger } from "@/lib/logger";
import { countingSourceSql } from "./inputs";

/*
 * Follow-up of a consolidation (spec 07 Folgeaufträge, plan Task 15): a place with fewer than `followup.minDocuments`
 * documents gets a targeted source discovery, the tile templates with its own names (stage `discovery.place`).
 */

/** Priority of a place query (as islands among the tile queries). */
const PLACE_PRIORITY = 1;

type PlaceRow = { tile_id: string | null; area_key: string | null };

/**
 * The SERP queries of a targeted discovery for the place of `geoObjectId`: per tile template the preferred valid name
 * of the object in the template's language (no name, no query), `level "place"`, `scopeId` = the geo object id,
 * priority 1 and `tileId` = the place's tile, so the cost is booked there. As `tileQueries`, the templates are limited
 * to the `sourceLanguages` of the area of the place's tile (ruling M5-P12); without a valid place, a tile with a
 * configured area there are no queries (logged). Deduplicated over `(keyword, languageCode, locationCode)`.
 */
export async function placeQueries(
  db: Db,
  geoObjectId: string,
  cfg: DiscoveryConfig,
  areas: AreaConfig[] = getConfig().areas,
): Promise<DiscoveryQuery[]> {
  const { rows } = await db.execute<PlaceRow>(sql`
    select p.tile_id, a.config_key as area_key
    from places p
    left join tiles t on t.id = p.tile_id
    left join geo_objects a on a.id = t.area_id and a.type = 'area'
    where p.geo_object_id = ${geoObjectId} and p.merged_into_id is null
      and p.valid_from <= current_date and (p.valid_to is null or p.valid_to > current_date)
    order by p.created_at, p.id
    limit 1
  `);
  const place = rows[0];
  const area = place?.area_key ? areas.find((a) => a.key === place.area_key) : undefined;
  if (!place?.tile_id || !area) {
    createLogger("consolidation").warn(
      { geoObjectId, tileId: place?.tile_id ?? null, areaKey: place?.area_key ?? null },
      "no place queries: the object has no valid place in a tile of a configured area",
    );
    return [];
  }
  const templates = templatesFor(cfg.templates.tile, area.sourceLanguages);
  if (templates.length === 0) return [];
  const names = await namesByLanguage(db, [geoObjectId], [...new Set(templates.map((t) => t.lang))]);
  return dedupeQueries(
    buildQueries(templates, names.get(geoObjectId), { level: "place", scopeId: geoObjectId, priority: PLACE_PRIORITY, tileId: place.tile_id }),
  );
}

/**
 * The thin places among `geoObjectIds` on `now`: valid geo objects with a valid, unmerged place of status `candidate`
 * or `confirmed` that have fewer than `cfg.minDocuments` documents (distinct documents with a mention of the object or
 * of an object merged into it, from sources neither rejected nor ended, as the profile's `documentsCount`) and no
 * `place_discovery_requests` row within the last `cfg.cooldownDays`. Fewest documents first, then by id; at most
 * `cfg.maxPlacesPerRun`.
 */
export async function thinPlaces(
  db: Db,
  geoObjectIds: string[],
  cfg: ConsolidationConfig["followup"],
  now: Date,
): Promise<string[]> {
  if (geoObjectIds.length === 0) return [];
  const today = now.toISOString().slice(0, 10);
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
        where r.geo_object_id = t.id and r.requested_at > ${now.toISOString()}::timestamptz - make_interval(days => ${cfg.cooldownDays})
      )
    order by coalesce(docs.n, 0), t.id
    limit ${cfg.maxPlacesPerRun}
  `);
  return rows.map((r) => r.id);
}
