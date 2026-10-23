import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { ResearchConfig } from "@/lib/config/schemas";
import type { Db } from "@/lib/db/client";
import { berthStates, geoObjects, wikidataSitelinks } from "@/lib/db/schema";
import { namesByLanguage, queryKey, type DiscoveryQuery } from "@/lib/domain/discovery/queries";

type LandsideConfig = ResearchConfig["landside"];

/** A town, sight or settlement near a berth, named in one language of the landside templates. */
export type LandsideSubject = { name: string; lang: string; geoObjectId: string | null };

/** The categories of `berth_states.nearby` that make a landside subject: towns and sights. */
const SUBJECT_CATEGORIES = ["town", "culture"];
/** The nearest settlements looked at: the nearest one may have no name in any template language. */
const NEAREST_SETTLEMENTS = 3;

/**
 * What a berth's landside is searched for: from `berth_states.nearby` the towns and sights with the most Wikidata
 * sitelinks (ties: nearer first), at most `maxSubjectsPerPlace`, plus always the nearest settlement of the place's
 * position. Each is named in every language of the landside templates it has a (non-provisional) name in; an
 * object without such a name is no subject. A place without a state or without `nearby` has the nearest settlement only.
 */
export async function landsideSubjects(db: Db, placeId: string, cfg: LandsideConfig): Promise<LandsideSubject[]> {
  const [state] = await db.select({ nearby: berthStates.nearby }).from(berthStates).where(eq(berthStates.placeId, placeId));
  const candidates = (state?.nearby ?? []).filter((n) => SUBJECT_CATEGORIES.includes(n.category));
  const links = new Map<string, number>();
  if (candidates.length > 0) {
    const rows = await db
      .select({ id: geoObjects.id, sitelinks: wikidataSitelinks.sitelinks })
      .from(geoObjects)
      .innerJoin(wikidataSitelinks, eq(wikidataSitelinks.wikidataId, geoObjects.wikidataId))
      .where(and(inArray(geoObjects.id, candidates.map((c) => c.geoObjectId)), isNull(geoObjects.validTo)));
    for (const r of rows) links.set(r.id, r.sitelinks);
  }
  const ranked = [...new Map(candidates.map((c) => [c.geoObjectId, c])).values()]
    .sort((a, b) => (links.get(b.geoObjectId) ?? 0) - (links.get(a.geoObjectId) ?? 0) || a.distanceM - b.distanceM || (a.geoObjectId < b.geoObjectId ? -1 : 1))
    .slice(0, cfg.maxSubjectsPerPlace)
    .map((c) => c.geoObjectId);

  const nearest = await db.execute<{ id: string }>(sql`
    select g.id from geo_objects g, places p
    where p.id = ${placeId} and g.type = 'settlement' and g.valid_to is null and g.merged_into_id is null
    order by g.centroid <-> p.position, g.id
    limit ${NEAREST_SETTLEMENTS}
  `);
  const settlements = nearest.rows.map((r) => r.id);

  const languages = [...new Set(cfg.templates.map((t) => t.lang))];
  const names = await namesByLanguage(db, [...new Set([...ranked, ...settlements])], languages);
  const subjectsOf = (id: string): LandsideSubject[] =>
    languages.flatMap((lang) => {
      const name = names.get(id)?.get(lang);
      return name ? [{ name, lang, geoObjectId: id }] : [];
    });

  const out = ranked.flatMap(subjectsOf);
  // the nearest settlement that has a name; one already among the ranked subjects is not repeated
  const nearestNamed = settlements.find((id) => subjectsOf(id).length > 0);
  if (nearestNamed && !ranked.includes(nearestNamed)) out.push(...subjectsOf(nearestNamed));
  return out;
}

/**
 * The queries of one subject: per template of the subject's language `{subject}` replaced by its name. `priority` is
 * the template's index; deduplicated over `queryKey`. The scope is the subject's geo object (the place when it has none);
 * `tileId` books the cost on the place's tile.
 */
export function buildLandsideQueries(placeId: string, tileId: string | null, subject: LandsideSubject, cfg: ResearchConfig): DiscoveryQuery[] {
  const byKey = new Map<string, DiscoveryQuery>();
  for (const [priority, t] of cfg.landside.templates.entries()) {
    if (t.lang !== subject.lang) continue;
    const locationCode = cfg.locationCodes[t.lang];
    if (locationCode === undefined) continue;
    const q: DiscoveryQuery = {
      keyword: t.template.replaceAll("{subject}", subject.name),
      languageCode: t.lang,
      locationCode,
      level: "research",
      scopeId: subject.geoObjectId ?? placeId,
      priority,
      ...(tileId ? { tileId } : {}),
    };
    const prior = byKey.get(queryKey(q));
    if (!prior || priority < prior.priority) byKey.set(queryKey(q), q);
  }
  return [...byKey.values()];
}
