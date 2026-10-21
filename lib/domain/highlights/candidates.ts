import { sql } from "drizzle-orm";
import { getConfig, type AppConfig } from "@/lib/config";
import type { ConsolidationConfig } from "@/lib/config/schemas";
import type { Db } from "@/lib/db/client";
import { poiCategoryEnum, type PoiCategory } from "@/lib/db/schema/geo";
import { importanceOf, poiKinds } from "@/lib/domain/consolidation/derived/importance";
import { countingSourceSql, mergedChainSql, mergedChainsSql } from "@/lib/domain/consolidation/inputs";
import { activeExtractionRunIdSql } from "@/lib/domain/extraction/active-run";
import { displayNameSql, normalizeName } from "@/lib/domain/gazetteer/names";
import { validAtAlias } from "@/lib/domain/timeline";
import { highlightsConfig, type HighlightCandidate, type TextName } from "./select";

export { poiKinds };

/*
 * The highlight candidates of one place (spec 16): every POI up to the largest reach, with its importance, and the
 * highlight names of the place's texts that no such POI took. `selectHighlights` applies the reach per importance.
 *
 * Three set-based queries per place, whatever the number of POIs: the candidates (with sitelinks, tags and names), the
 * counting sources of all candidates, and the place's active highlight facts with the candidate POIs mentioned at
 * their quote.
 */

const HIGHLIGHT = "highlight.";
const CATEGORIES = new Set<string>(poiCategoryEnum.enumValues);

type CandidateRow = {
  id: string;
  category: PoiCategory;
  name: string | null;
  names: string[] | null;
  tags: Record<string, unknown>;
  sitelinks: number | null;
  distance_km: number;
  lon: number;
  lat: number;
};

/**
 * Candidates: valid, unmerged, categorised POIs within `max(highlights.reachKm)` of the place's anchor (else its
 * position; the valid, unmerged, not rejected place row of the object), distance over `::geography` in km rounded to 3
 * decimals, nearest first. Importance by `importanceOf`: the counting sources (rejected and ended left out) with a
 * mention of the POI or an object merged into it, its Wikidata sitelinks, category and kinds.
 *
 * Text names: the normalized names (`value.names`) of the place's (and merged objects') `highlight.<category>` facts
 * of the active extraction run of their (version, object), counting sources only, that no candidate took. Extraction
 * links a name to a POI (`matchPoi`) by a POI mention at the fact's quote span, one per linked name; so a name is
 * taken when a candidate mentioned at that span carries it among its names, and the names left over are taken too
 * when at least as many other candidates are mentioned there (a fuzzy match). Distinct per (category, name), sorted.
 */
export async function loadHighlightCandidates(
  db: Db,
  placeGeoObjectId: string,
  cfg: ConsolidationConfig,
  today: string,
  appConfig: AppConfig = getConfig(),
): Promise<{ candidates: HighlightCandidate[]; textNames: TextName[] }> {
  const reachM = Math.max(...highlightsConfig(cfg).reachKm) * 1000;

  const { rows } = await db.execute<CandidateRow>(sql`
    with anchor as (
      select coalesce(p.anchor_position, p.position) as pt
      from places p
      where p.geo_object_id = ${placeGeoObjectId} and ${validAtAlias("p", today)} and p.merged_into_id is null and p.status <> 'rejected'
      order by p.created_at, p.id
      limit 1
    )
    select o.id, o.category::text as category, o.tags, w.sitelinks,
           ${displayNameSql(sql`o.id`, today)} as name,
           (select array_agg(distinct gn.name_normalized) from geo_names gn
            where gn.geo_object_id = o.id and ${validAtAlias("gn", today)}) as names,
           round((ST_Distance(o.geom::geography, a.pt::geography) / 1000)::numeric, 3)::float8 as distance_km,
           ST_X(o.centroid) as lon, ST_Y(o.centroid) as lat
    from anchor a
    join geo_objects o
      on o.type = 'poi' and o.category is not null and o.merged_into_id is null and o.id <> ${placeGeoObjectId}
     and ${validAtAlias("o", today)}
     -- box prefilter (index), then the exact distance in metres
     and o.geom && ST_Expand(a.pt, ${reachM}::float8 / (111320 * greatest(cos(radians(ST_Y(a.pt))), 0.1)))
     and ST_DWithin(o.geom::geography, a.pt::geography, ${reachM}::float8)
    left join wikidata_sitelinks w on w.wikidata_id = o.wikidata_id
    order by distance_km, o.id
  `);
  if (rows.length === 0) return { candidates: [], textNames: await textNamesOf(db, placeGeoObjectId, [], new Map(), today, appConfig) };

  const ids = rows.map((r) => r.id);
  const roots = sql`select unnest(${sql.param(ids)}::uuid[]) as id`;
  const { rows: sourceRows } = await db.execute<{ root_id: string; id: string; weight: number }>(sql`
    select distinct c.root_id, s.id, s.weight
    from ${mergedChainsSql(roots)} c
    join mentions m on m.geo_object_id = c.id
    join document_versions v on v.id = m.document_version_id
    join documents d on d.id = v.document_id
    join sources s on s.id = d.source_id
    where ${countingSourceSql(today)}
    order by c.root_id, s.id
  `);
  const sourcesOf = new Map<string, Array<{ key: string; weight: number }>>();
  for (const r of sourceRows) {
    const list = sourcesOf.get(r.root_id) ?? [];
    list.push({ key: `source:${r.id}`, weight: Number(r.weight) });
    sourcesOf.set(r.root_id, list);
  }

  const candidates: HighlightCandidate[] = rows.map((r) => {
    const imp = importanceOf(
      {
        sources: sourcesOf.get(r.id) ?? [],
        sitelinks: r.sitelinks === null ? null : Number(r.sitelinks),
        category: r.category,
        kinds: poiKinds(r.tags ?? {}),
      },
      cfg,
    );
    return {
      geoObjectId: r.id,
      category: r.category,
      name: r.name,
      nameNormalized: r.name === null ? null : normalizeName(r.name),
      importance: imp.importance,
      score: imp.score,
      distanceKm: Number(r.distance_km),
      lon: Number(r.lon),
      lat: Number(r.lat),
    };
  });
  const namesOf = new Map(rows.map((r) => [r.id, new Set(r.names ?? [])]));
  return { candidates, textNames: await textNamesOf(db, placeGeoObjectId, ids, namesOf, today, appConfig) };
}

/** The text names of the place (see `loadHighlightCandidates`); `namesOf` holds each candidate's normalized names. */
async function textNamesOf(
  db: Db,
  placeGeoObjectId: string,
  candidateIds: string[],
  namesOf: Map<string, Set<string>>,
  today: string,
  appConfig: AppConfig,
): Promise<TextName[]> {
  const roots = sql`select unnest(${sql.param(candidateIds)}::uuid[]) as id`;
  const { rows } = await db.execute<{ id: string; attribute: string; value: { names?: unknown } | null; linked: string[] }>(sql`
    with hf as (
      select f.id, f.attribute, f.value, f.quote_chunk_id, f.quote_start, f.quote_end
      from facts f
      join mentions m on m.id = f.mention_id
      join document_versions v on v.id = m.document_version_id
      join documents d on d.id = v.document_id
      join sources s on s.id = d.source_id
      where f.geo_object_id in ${mergedChainSql(placeGeoObjectId)} and f.attribute like 'highlight.%'
        and ${countingSourceSql(today)}
        and f.extraction_run_id = ${activeExtractionRunIdSql(appConfig, sql`m.document_version_id`, sql`f.geo_object_id`)}
    ),
    chain as materialized (select c.root_id, c.id from ${mergedChainsSql(roots)} c)
    select hf.id, hf.attribute, hf.value,
           coalesce(array_agg(distinct c.root_id) filter (where c.root_id is not null), '{}') as linked
    from hf
    left join mentions pm
      on pm.chunk_id = hf.quote_chunk_id and pm.char_start = hf.quote_start and pm.char_end = hf.quote_end
    left join chain c on c.id = pm.geo_object_id
    group by hf.id, hf.attribute, hf.value
    order by hf.id
  `);

  const found = new Map<string, TextName>();
  for (const r of rows) {
    const category = r.attribute.slice(HIGHLIGHT.length);
    if (!CATEGORIES.has(category)) continue;
    const raw = Array.isArray(r.value?.names) ? r.value.names : [];
    const names = [...new Set(raw.filter((n): n is string => typeof n === "string").map(normalizeName).filter((n) => n.length > 0))];
    const linked = r.linked ?? [];
    const carriers = new Set(linked.filter((id) => names.some((n) => namesOf.get(id)?.has(n))));
    const left = names.filter((n) => !linked.some((id) => namesOf.get(id)?.has(n)));
    // the leftover names took the other mentioned candidates (fuzzy matches), when there are enough of them
    if (left.length <= linked.length - carriers.size) continue;
    for (const n of left) found.set(`${category}\u0000${n}`, { category: category as PoiCategory, nameNormalized: n });
  }
  return [...found.values()].sort((a, b) =>
    a.category < b.category ? -1 : a.category > b.category ? 1 : a.nameNormalized < b.nameNormalized ? -1 : a.nameNormalized > b.nameNormalized ? 1 : 0,
  );
}
