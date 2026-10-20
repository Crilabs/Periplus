import { and, asc, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { countryConfig, getConfig, type DiscoveryConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { facts, geoNames, geoObjects, subdivisions, tileGeoObjects, tiles, type SerpLevel } from "@/lib/db/schema";
import { subdivisionTileIds } from "@/lib/domain/gazetteer/tiles-ensure";
import { subdivisionByKey } from "@/lib/domain/subdivisions/store";
import { validAt } from "@/lib/domain/timeline";
import { createLogger } from "@/lib/logger";

/**
 * One SERP search to make: `priority` orders tile queries (1 islands, 2 settlements, 3 bays; area queries 0; place
 * queries 1).
 */
export type DiscoveryQuery = {
  keyword: string;
  languageCode: string;
  locationCode: number;
  level: SerpLevel;
  /** Area `config_key` (`area`; plan 14b moves it to the id), tile id (`tile`) or geo object id (`place`). */
  scopeId: string;
  priority: number;
  /** The tile a `place` query's cost is booked on (the place's tile, ruling M5-P12); unset for other levels. */
  tileId?: string;
};

type Template = DiscoveryConfig["templates"]["area"][number];

const AREA_PRIORITY = 0;
const TILE_PRIORITY: Record<string, number> = { island: 1, islet: 1, archipelago: 1, settlement: 2, bay: 3 };

/**
 * The preferred valid name per language of each object: preferred first, then real names before fallbacks
 * and transliterations, then alphabetical.
 */
export async function namesByLanguage(db: Db, objectIds: string[], languages: string[]): Promise<Map<string, Map<string, string>>> {
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

/** Templates whose language the subdivision searches in. */
export function templatesFor(templates: Template[], sourceLanguages: string[]): Template[] {
  return templates.filter((t) => sourceLanguages.includes(t.lang));
}

/** One query per template whose language has a name in `names` (`{name}` replaced); a language without a name yields none. */
export function buildQueries(
  templates: Template[],
  names: Map<string, string> | undefined,
  base: Pick<DiscoveryQuery, "level" | "scopeId" | "priority" | "tileId">,
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
export function dedupeQueries(queries: DiscoveryQuery[]): DiscoveryQuery[] {
  const byKey = new Map<string, DiscoveryQuery>();
  for (const q of queries) {
    const prior = byKey.get(queryKey(q));
    if (!prior || q.priority < prior.priority) byKey.set(queryKey(q), q);
  }
  return [...byKey.values()];
}

/** Priority of a place query (as islands among the tile queries). */
const PLACE_PRIORITY = 1;

/**
 * The source languages of the subdivision a tile is labelled with: its override, else its country's default
 * (`config/subdivisions.json`). Throws `Kachel <id> hat keinen Landesteil` for a tile without label.
 */
export async function sourceLanguagesOfTile(db: Db, tileId: string): Promise<string[]> {
  const [row] = await db
    .select({ key: subdivisions.key, country: subdivisions.country })
    .from(tiles)
    .leftJoin(subdivisions, eq(subdivisions.id, tiles.subdivisionId))
    .where(eq(tiles.id, tileId));
  if (!row?.key) throw new Error(`Kachel ${tileId} hat keinen Landesteil`);
  return getConfig().subdivisions.overrides[row.key]?.sourceLanguages ?? countryConfig(row.country!).sourceLanguages;
}

type PlaceRow = { tile_id: string | null; subdivision_id: string | null };

/**
 * The SERP queries of a targeted discovery for the place of `geoObjectId`: per tile template the preferred valid name
 * of the object in the template's language (no name, no query), `level "place"`, `scopeId` = the geo object id,
 * priority 1 and `tileId` = the place's tile, so the cost is booked there. As `tileQueries`, the templates are limited
 * to the source languages of the subdivision of the place's tile (`sourceLanguagesOfTile`, ruling M5-P12); without a
 * valid place, or in a tile without subdivision, there are no queries (logged). The place is valid on `opts.on` (the
 * run date; default the database's date). Deduplicated over `(keyword, languageCode, locationCode)`.
 */
export async function placeQueries(
  db: Db,
  geoObjectId: string,
  cfg: DiscoveryConfig,
  opts: { on?: string } = {},
): Promise<DiscoveryQuery[]> {
  const on = opts.on ? sql`${opts.on}::date` : sql`current_date`;
  const { rows } = await db.execute<PlaceRow>(sql`
    select p.tile_id, t.subdivision_id
    from places p
    left join tiles t on t.id = p.tile_id
    where p.geo_object_id = ${geoObjectId} and p.merged_into_id is null
      and p.valid_from <= ${on} and (p.valid_to is null or p.valid_to > ${on})
    order by p.created_at, p.id
    limit 1
  `);
  const place = rows[0];
  if (!place?.tile_id || !place.subdivision_id) {
    createLogger("discovery").warn(
      { geoObjectId, tileId: place?.tile_id ?? null },
      "no place queries: the object has no valid place in a tile with a subdivision",
    );
    return [];
  }
  const templates = templatesFor(cfg.templates.tile, await sourceLanguagesOfTile(db, place.tile_id));
  if (templates.length === 0) return [];
  const names = await namesByLanguage(db, [geoObjectId], [...new Set(templates.map((t) => t.lang))]);
  return dedupeQueries(
    buildQueries(templates, names.get(geoObjectId), { level: "place", scopeId: geoObjectId, priority: PLACE_PRIORITY, tileId: place.tile_id }),
  );
}

/**
 * The area templates for every valid `area` object that touches the subdivision's scope tiles (`tile_geo_objects` of
 * `subdivisionTileIds`): the object's preferred valid name in each template language that is one of the subdivision's
 * source languages; a language without a name yields no query. `scopeId` is the area's id (a SERP stored under a legacy
 * `config_key` still maps to it, `areaOfSerpScopeSql`); an area without a config key is searched too. An area touching two subdivisions yields the same queries for both, which
 * the SERP reuse (`serp.reuseDays`) searches once. Empty for a subdivision without tiles.
 */
export async function areaQueries(db: Db, subdivisionKey: string, cfg: DiscoveryConfig): Promise<DiscoveryQuery[]> {
  const sub = await subdivisionByKey(db, subdivisionKey);
  if (!sub) throw new Error(`Unbekannter Landesteil ${subdivisionKey}`);
  const tileIds = await subdivisionTileIds(db, sub.id);
  if (tileIds.length === 0) return [];
  const languages = getConfig().subdivisions.overrides[sub.key]?.sourceLanguages ?? countryConfig(sub.country).sourceLanguages;
  const templates = templatesFor(cfg.templates.area, languages);
  const areas = await db
    .selectDistinct({ id: geoObjects.id })
    .from(tileGeoObjects)
    .innerJoin(geoObjects, eq(geoObjects.id, tileGeoObjects.geoObjectId))
    .where(
      and(
        inArray(tileGeoObjects.tileId, tileIds),
        eq(geoObjects.type, "area"),
        isNull(geoObjects.mergedIntoId),
        validAt(geoObjects),
      ),
    )
    .orderBy(geoObjects.id);
  const names = await namesByLanguage(db, areas.map((a) => a.id), [...new Set(templates.map((t) => t.lang))]);
  return dedupeQueries(
    areas.flatMap((a) => buildQueries(templates, names.get(a.id), { level: "area", scopeId: a.id, priority: AREA_PRIORITY })),
  );
}

/**
 * The tile templates for the valid objects of the tile: islands, islets and archipelagos (priority 1),
 * settlements (2) and named bays (3) whose newest `anchor_area` fact has `areaM2 >= cfg.bay.minAnchorAreaM2` or
 * that have at least `cfg.bay.minWikidataNames` valid Wikidata names. Template languages are limited to the source
 * languages of the tile's subdivision (`sourceLanguagesOfTile`, throws for a tile without one); deduplicated over
 * `(keyword, languageCode, locationCode)`.
 */
export async function tileQueries(db: Db, tileId: string, cfg: DiscoveryConfig): Promise<DiscoveryQuery[]> {
  const templates = templatesFor(cfg.templates.tile, await sourceLanguagesOfTile(db, tileId));
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
  return dedupeQueries(
    objects.flatMap((o) =>
      buildQueries(templates, names.get(o.id), { level: "tile", scopeId: tileId, priority: TILE_PRIORITY[o.type]! }),
    ),
  );
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Area queries before tile and place queries, then by priority, keyword, language and location; keeps the first `max`. */
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
