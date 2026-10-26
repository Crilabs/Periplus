import { and, asc, desc, inArray, notInArray, sql } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import { geoNames, type SerpLevel } from "@/lib/db/schema";
import { provisionalNameIds } from "@/lib/domain/research/provisional-names";
import { validAt } from "@/lib/db/valid-at";

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

/**
 * The preferred valid name per language of each object: preferred first, then real names before fallbacks
 * and transliterations, then alphabetical. Provisional research names (`provisionalNameIds`) are left out.
 */
export async function namesByLanguage(db: Db, objectIds: string[], languages: string[]): Promise<Map<string, Map<string, string>>> {
  const out = new Map<string, Map<string, string>>();
  if (objectIds.length === 0 || languages.length === 0) return out;
  const provisional = await provisionalNameIds(db, objectIds);
  const rows = await db
    .selectDistinctOn([geoNames.geoObjectId, geoNames.language], {
      geoObjectId: geoNames.geoObjectId,
      language: geoNames.language,
      name: geoNames.name,
    })
    .from(geoNames)
    .where(
      and(
        inArray(geoNames.geoObjectId, objectIds),
        inArray(geoNames.language, languages),
        validAt(geoNames),
        provisional.size > 0 ? notInArray(geoNames.id, [...provisional]) : undefined,
      ),
    )
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
