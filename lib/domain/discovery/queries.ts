import { and, asc, desc, eq, inArray, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { areaByKey, type AreaConfig, type DiscoveryConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { facts, geoNames, geoObjects, tileGeoObjects, tiles, type SerpLevel } from "@/lib/db/schema";
import { validAt } from "@/lib/domain/timeline";

/** One SERP search to make: `priority` orders tile queries (1 islands, 2 settlements, 3 bays; area queries 0). */
export type DiscoveryQuery = {
  keyword: string;
  languageCode: string;
  locationCode: number;
  level: SerpLevel;
  /** Area key (`area`) or tile id (`tile`). */
  scopeId: string;
  priority: number;
};

type Template = DiscoveryConfig["templates"]["area"][number];

const AREA_PRIORITY = 0;
const TILE_PRIORITY: Record<string, number> = { island: 1, islet: 1, archipelago: 1, settlement: 2, bay: 3 };

/**
 * The preferred valid name per language of each object: preferred first, then real names before fallbacks
 * and transliterations, then alphabetical.
 */
async function namesByLanguage(db: Db, objectIds: string[], languages: string[]): Promise<Map<string, Map<string, string>>> {
  const out = new Map<string, Map<string, string>>();
  if (objectIds.length === 0 || languages.length === 0) return out;
  const rows = await db
    .selectDistinctOn([geoNames.geoObjectId, geoNames.language], {
      geoObjectId: geoNames.geoObjectId,
      language: geoNames.language,
      name: geoNames.name,
    })
    .from(geoNames)
    .where(and(inArray(geoNames.geoObjectId, objectIds), inArray(geoNames.language, languages), validAt(geoNames)))
    .orderBy(
      geoNames.geoObjectId,
      geoNames.language,
      desc(geoNames.isPreferred),
      asc(sql`${geoNames.origin} in ('fallback', 'transliteration')`),
      geoNames.name,
      geoNames.id,
    );
  for (const r of rows) {
    const byLang = out.get(r.geoObjectId) ?? new Map<string, string>();
    byLang.set(r.language, r.name);
    out.set(r.geoObjectId, byLang);
  }
  return out;
}

/** Templates whose language the area searches in. */
function templatesFor(templates: Template[], sourceLanguages: string[]): Template[] {
  return templates.filter((t) => sourceLanguages.includes(t.lang));
}

function build(
  templates: Template[],
  names: Map<string, string> | undefined,
  base: Pick<DiscoveryQuery, "level" | "scopeId" | "priority">,
): DiscoveryQuery[] {
  const out: DiscoveryQuery[] = [];
  for (const t of templates) {
    const name = names?.get(t.lang);
    if (!name) continue;
    out.push({ keyword: t.template.replaceAll("{name}", name), languageCode: t.lang, locationCode: t.locationCode, ...base });
  }
  return out;
}

/** Identity of a search: `(keyword, languageCode, locationCode)`. */
export const queryKey = (q: Pick<DiscoveryQuery, "keyword" | "languageCode" | "locationCode">) =>
  `${q.keyword}\u0000${q.languageCode}\u0000${q.locationCode}`;

/** One query per `(keyword, languageCode, locationCode)`, keeping the lowest priority. */
function dedupe(queries: DiscoveryQuery[]): DiscoveryQuery[] {
  const byKey = new Map<string, DiscoveryQuery>();
  for (const q of queries) {
    const prior = byKey.get(queryKey(q));
    if (!prior || q.priority < prior.priority) byKey.set(queryKey(q), q);
  }
  return [...byKey.values()];
}

/**
 * The area templates applied to the preferred valid name of the area object (`config_key = areaKey`) in each
 * template language that is one of the area's `sourceLanguages`; a language without a name yields no query.
 * Empty while the area object does not exist.
 */
export async function areaQueries(db: Db, areaKey: string, cfg: DiscoveryConfig): Promise<DiscoveryQuery[]> {
  const templates = templatesFor(cfg.templates.area, areaByKey(areaKey).sourceLanguages);
  const rows = await db
    .select({ id: geoObjects.id })
    .from(geoObjects)
    .where(and(eq(geoObjects.type, "area"), eq(geoObjects.configKey, areaKey), validAt(geoObjects)));
  const areaId = rows[0]?.id;
  if (!areaId) return [];
  const names = await namesByLanguage(db, [areaId], [...new Set(templates.map((t) => t.lang))]);
  return dedupe(build(templates, names.get(areaId), { level: "area", scopeId: areaKey, priority: AREA_PRIORITY }));
}

/**
 * The tile templates for the valid objects of the tile: islands, islets and archipelagos (priority 1),
 * settlements (2) and named bays (3) whose newest `anchor_area` fact has `areaM2 >= cfg.bay.minAnchorAreaM2` or
 * that have at least `cfg.bay.minWikidataNames` valid Wikidata names. Template languages are limited to the
 * `sourceLanguages` of the tile's area (`areas`); throws when the tile has no area or its area is not configured; deduplicated over `(keyword, languageCode, locationCode)`.
 */
export async function tileQueries(
  db: Db,
  tileId: string,
  cfg: DiscoveryConfig,
  areas: AreaConfig[],
): Promise<DiscoveryQuery[]> {
  const [tile] = await db
    .select({ areaKey: geoObjects.configKey })
    .from(tiles)
    .leftJoin(geoObjects, eq(geoObjects.id, tiles.areaId))
    .where(eq(tiles.id, tileId));
  const areaKey = tile?.areaKey;
  if (!areaKey) throw new Error(`tile ${tileId} has no area: tile queries need the area's source languages`);
  const area = areas.find((a) => a.key === areaKey);
  if (!area) throw new Error(`area ${areaKey} of tile ${tileId} is not configured`);
  const templates = templatesFor(cfg.templates.tile, area.sourceLanguages);
  if (templates.length === 0) return [];

  const f = alias(facts, "f");
  const n = alias(geoNames, "n");
  const newestAnchorAreaM2 = sql`(
    select (${f.value}->>'areaM2')::float8 from facts f
    where ${f.geoObjectId} = ${geoObjects.id} and ${f.attribute} = 'anchor_area'
    order by ${f.createdAt} desc, ${f.id} desc limit 1
  )`;
  const wikidataNames = sql`(
    select count(*) from geo_names n where ${n.geoObjectId} = ${geoObjects.id} and ${n.origin} = 'wikidata' and ${validAt(n)}
  )`;
  const objects = await db
    .select({ id: geoObjects.id, type: geoObjects.type })
    .from(tileGeoObjects)
    .innerJoin(geoObjects, eq(geoObjects.id, tileGeoObjects.geoObjectId))
    .where(
      and(
        eq(tileGeoObjects.tileId, tileId),
        validAt(geoObjects),
        or(
          inArray(geoObjects.type, ["island", "islet", "archipelago", "settlement"]),
          and(
            eq(geoObjects.type, "bay"),
            sql`(coalesce(${newestAnchorAreaM2}, 0) >= ${cfg.bay.minAnchorAreaM2} or ${wikidataNames} >= ${cfg.bay.minWikidataNames})`,
          ),
        ),
      ),
    )
    .orderBy(geoObjects.id);
  const names = await namesByLanguage(
    db,
    objects.map((o) => o.id),
    [...new Set(templates.map((t) => t.lang))],
  );
  return dedupe(
    objects.flatMap((o) =>
      build(templates, names.get(o.id), { level: "tile", scopeId: tileId, priority: TILE_PRIORITY[o.type]! }),
    ),
  );
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Area queries before tile queries, then by priority, keyword, language and location; keeps the first `max`. */
export function capQueries(queries: DiscoveryQuery[], max: number): { kept: DiscoveryQuery[]; dropped: number } {
  const levelRank = (q: DiscoveryQuery) => (q.level === "area" ? 0 : 1);
  const sorted = [...queries].sort(
    (a, b) =>
      levelRank(a) - levelRank(b) ||
      a.priority - b.priority ||
      cmp(a.keyword, b.keyword) ||
      cmp(a.languageCode, b.languageCode) ||
      a.locationCode - b.locationCode,
  );
  return { kept: sorted.slice(0, max), dropped: Math.max(0, sorted.length - max) };
}
