import { eq, sql } from "drizzle-orm";
import { getConfig } from "@/lib/config";
import type { ResearchConfig } from "@/lib/config/schemas";
import type { Db } from "@/lib/db/client";
import { geoObjects, places, subdivisions } from "@/lib/db/schema";
import { namesByLanguage, queryKey, type DiscoveryQuery } from "@/lib/domain/discovery/queries";

/** What the search templates of a candidate are filled from. */
export type CandidateNames = {
  /** Preferred valid name per language. */
  names: Record<string, string>;
  /** Names of the nearest ancestor of type island/islet per language; null when there is none. */
  island: Record<string, string> | null;
  /** ISO 3166-1 alpha-2 country of the candidate's subdivision; empty when it has none. */
  countryCode: string;
  tileId: string | null;
};

/**
 * The queries of one candidate for one purpose: per template (of a language searched in the candidate's country)
 * the candidate's name in the template's language and, for `{island}`, the island's name in that language; a
 * template without the name it needs yields no query. `priority` is the index of the template, deduplicated over
 * `queryKey` (the lowest priority wins). `tileId` books the cost on the candidate's tile.
 */
export function buildResearchQueries(
  placeId: string,
  input: CandidateNames,
  cfg: ResearchConfig,
  purpose: "positive" | "negative",
): DiscoveryQuery[] {
  const languages = cfg.languagesByCountry[input.countryCode] ?? cfg.languagesByCountry.default!;
  const byKey = new Map<string, DiscoveryQuery>();
  for (const [priority, t] of cfg.templates[purpose].entries()) {
    if (!languages.includes(t.lang)) continue;
    const name = input.names[t.lang];
    const locationCode = cfg.locationCodes[t.lang];
    if (!name || locationCode === undefined) continue;
    let keyword = t.template.replaceAll("{name}", name);
    if (keyword.includes("{island}")) {
      const island = input.island?.[t.lang];
      if (!island) continue;
      keyword = keyword.replaceAll("{island}", island);
    }
    const q: DiscoveryQuery = {
      keyword,
      languageCode: t.lang,
      locationCode,
      level: "research",
      scopeId: placeId,
      priority,
      ...(input.tileId ? { tileId: input.tileId } : {}),
    };
    const prior = byKey.get(queryKey(q));
    if (!prior || priority < prior.priority) byKey.set(queryKey(q), q);
  }
  return [...byKey.values()];
}

/**
 * The names a candidate is searched with: the preferred valid names of its geo object, the names of its nearest
 * island/islet ancestor (via `parent_id`), the country of its subdivision and its tile. Unknown place: empty names.
 */
export async function candidateNames(db: Db, placeId: string): Promise<CandidateNames> {
  const [row] = await db
    .select({ geoObjectId: places.geoObjectId, tileId: places.tileId, country: subdivisions.country })
    .from(places)
    .innerJoin(geoObjects, eq(geoObjects.id, places.geoObjectId))
    .leftJoin(subdivisions, eq(subdivisions.id, geoObjects.subdivisionId))
    .where(eq(places.id, placeId));
  if (!row) return { names: {}, island: null, countryCode: "", tileId: null };

  const { rows } = await db.execute<{ id: string }>(sql`
    with recursive up as (
      select g.id, g.parent_id, g.type, 0 as depth from geo_objects g where g.id = ${row.geoObjectId}
      union all
      select p.id, p.parent_id, p.type, up.depth + 1 from geo_objects p join up on p.id = up.parent_id where up.depth < 10
    )
    select id from up where type in ('island', 'islet') and depth > 0 order by depth limit 1
  `);
  const islandId = rows[0]?.id;

  const languages = Object.keys(getConfig().research.locationCodes);
  const byLanguage = await namesByLanguage(db, islandId ? [row.geoObjectId, islandId] : [row.geoObjectId], languages);
  const record = (id: string) => Object.fromEntries(byLanguage.get(id) ?? []);
  const island = islandId ? record(islandId) : null;
  return {
    names: record(row.geoObjectId),
    island: island && Object.keys(island).length > 0 ? island : null,
    countryCode: row.country ?? "",
    tileId: row.tileId,
  };
}
