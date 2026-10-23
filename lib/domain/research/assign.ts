import { alias } from "drizzle-orm/pg-core";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { resolveTaskModel } from "@/lib/ai/cost";
import { getConfig, type AppConfig, type NameAffixesConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { documents, documentVersions, geoNames, geoObjects, pageAssessments, places, researchHits, researchRouteStops } from "@/lib/db/schema";
import { normalizeName } from "@/lib/domain/gazetteer/names";
import { stripAffix } from "@/lib/domain/mentions/affixes";
import { activeAssessor } from "./assessment";
import { provisionalNameIds } from "./provisional-names";
import { namesOccur } from "./unit-text";
import type { Archive } from "@/lib/adapters/s3";

/*
 * Assigns assessed pages to berth candidates (plan N2): a page that is a research hit of place A may name other
 * berths nearby; each such candidate within the extraction radius whose name matches an assessed berth of the page
 * becomes part of the page's research unit. Names are compared normalized and without generic affixes, never fuzzy.
 * A page is also a page of every place one of its route stops points to (`research_route_stops`, plan N2 task 5).
 * A page found by searching a place is only a unit of that place when it names the berth (N3 task 0): the page's
 * assessment names a berth matching the place, or the page's Markdown (read from the `archive`) contains one of
 * the place's names as whole words. A quote that names no berth must never count as evidence for the searched one.
 */

export type ResearchUnitPlan = { documentVersionId: string; placeIds: string[] };

/** The model and prompt version that extracts routes now (task `extract-route`); route stops of others do not count. */
export function activeRouteExtractor(config: AppConfig = getConfig()): { model: string; promptVersion: number } {
  const { model, taskConfig } = resolveTaskModel(config, "extract-route");
  return { model, promptVersion: taskConfig.promptVersion };
}

/** Name forms to compare: the normalized name and, when it has a generic affix, the core without it. */
export function berthNameForms(name: string, affixes: NameAffixesConfig): string[] {
  const n = normalizeName(name);
  if (!n) return [];
  const core = stripAffix(n, affixes)?.core;
  return core && core !== n ? [n, core] : [n];
}

/** Whole-word containment of `a` in `b` (equal included). */
function containsWords(b: string, a: string): boolean {
  return ` ${b} `.includes(` ${a} `);
}

/**
 * Whether an assessed berth of a page is the candidate: one name form equals or contains the other (as whole words),
 * generic affixes stripped. The island must agree when both the page and the candidate (`candidateIslands`) name one.
 */
export function berthNameMatches(
  assessed: { name: string; island: string | null },
  candidateNames: string[],
  affixes: NameAffixesConfig,
  candidateIslands: string[] = [],
): boolean {
  const island = assessed.island ? normalizeName(assessed.island) : "";
  if (island && candidateIslands.length > 0 && !candidateIslands.some((i) => { const c = normalizeName(i); return c !== "" && (containsWords(c, island) || containsWords(island, c)); })) {
    return false;
  }
  const mine = berthNameForms(assessed.name, affixes);
  return candidateNames.some((name) => berthNameForms(name, affixes).some((c) => mine.some((m) => containsWords(c, m) || containsWords(m, c))));
}

/**
 * The research units of the places' hit pages: per current, actively assessed, not `generated` version of a hit
 * document, the searched places plus every candidate within `extraction.placeRadiusKm` of a searched place whose name
 * matches an assessed berth of the page; a searched place only when the page names it (see above). A current version with a route stop (active route model and prompt) pointing
 * to one of the places counts as a hit of that place. Sorted by version, places by id.
 */
export async function unitsForPlaces(db: Db, placeIds: string[], cfg: AppConfig, archive: Pick<Archive, "get">): Promise<ResearchUnitPlan[]> {
  return (await planUnits(db, placeIds, cfg, archive)).units;
}

/**
 * `unitsForPlaces` plus the versions it judged (current, actively assessed, not generated, a page of one of the
 * places): a unit of such a version for a place not in `units` no longer qualifies. A version whose Markdown is
 * missing from the archive cannot be judged by its text; its searched places stay in (extraction skips them as
 * missing Markdown, retryably).
 */
export async function planUnits(
  db: Db,
  placeIds: string[],
  cfg: AppConfig,
  archive: Pick<Archive, "get">,
): Promise<{ units: ResearchUnitPlan[]; judgedVersions: string[] }> {
  const none = { units: [], judgedVersions: [] };
  if (placeIds.length === 0) return none;
  const { model, promptVersion } = activeAssessor(cfg);

  // version -> searched places (hits of these places on the version's document)
  const hitRows = await db
    .selectDistinct({ placeId: researchHits.placeId, versionId: documents.currentVersionId })
    .from(researchHits)
    .innerJoin(documents, eq(documents.urlNormalized, researchHits.urlNormalized))
    .where(inArray(researchHits.placeId, placeIds));
  const route = activeRouteExtractor(cfg);
  const stopRows = await db
    .selectDistinct({ placeId: sql<string>`${researchRouteStops.placeId}`, versionId: researchRouteStops.documentVersionId })
    .from(researchRouteStops)
    .innerJoin(documents, eq(documents.currentVersionId, researchRouteStops.documentVersionId))
    .where(
      and(
        inArray(researchRouteStops.placeId, placeIds),
        eq(researchRouteStops.model, route.model),
        eq(researchRouteStops.promptVersion, route.promptVersion),
      ),
    );
  const searched = new Map<string, Set<string>>();
  for (const h of [...hitRows, ...stopRows]) {
    if (!h.versionId) continue;
    (searched.get(h.versionId) ?? searched.set(h.versionId, new Set()).get(h.versionId)!).add(h.placeId);
  }
  if (searched.size === 0) return none;
  const stopPairs = new Set(stopRows.map((s) => `${s.versionId}:${s.placeId}`));

  const assessments = await db
    .select({ versionId: pageAssessments.documentVersionId, berths: pageAssessments.berths })
    .from(pageAssessments)
    .where(
      and(
        inArray(pageAssessments.documentVersionId, [...searched.keys()]),
        eq(pageAssessments.model, model),
        eq(pageAssessments.promptVersion, promptVersion),
        eq(pageAssessments.generated, false),
      ),
    );

  // candidates near the searched places, with their names and (for an island parent) the island names
  const searchedIds = [...new Set([...hitRows, ...stopRows].map((h) => h.placeId))];
  const near = await nearbyCandidates(db, searchedIds, cfg.research.extraction.placeRadiusKm);
  const affixes = cfg.nameAffixes;
  const own = await placeNames(db, searchedIds);

  // searched places whose page does not name them in its assessment: the Markdown decides
  const unnamed = (a: { versionId: string; berths: Array<{ name: string; island: string | null }> }, placeId: string): boolean => {
    const p = own.get(placeId);
    return !p || !a.berths.some((b) => berthNameMatches(b, p.names, affixes, p.islands));
  };
  const needText = new Map<string, string[]>(); // version -> places to look for in the text
  for (const a of assessments) {
    for (const placeId of searched.get(a.versionId)!) {
      if (!stopPairs.has(`${a.versionId}:${placeId}`) && unnamed(a, placeId)) (needText.get(a.versionId) ?? needText.set(a.versionId, []).get(a.versionId)!).push(placeId);
    }
  }
  const named = new Set<string>(); // `version:place` found in the Markdown
  if (needText.size > 0) {
    const keys = await db
      .select({ id: documentVersions.id, mdKey: documentVersions.mdKey })
      .from(documentVersions)
      .where(inArray(documentVersions.id, [...needText.keys()]));
    for (const k of keys) {
      const body = await archive.get(k.mdKey);
      const md = body === null ? null : new TextDecoder().decode(body);
      for (const placeId of needText.get(k.id)!) {
        // no Markdown: undecidable here, the unit stays and extraction skips it as missing Markdown
        if (md === null || namesOccur(md, own.get(placeId)?.names ?? [])) named.add(`${k.id}:${placeId}`);
      }
    }
  }

  const units = assessments
    .map((a): ResearchUnitPlan => {
      const ids = new Set<string>();
      for (const placeId of searched.get(a.versionId)!) {
        if (stopPairs.has(`${a.versionId}:${placeId}`) || !unnamed(a, placeId) || named.has(`${a.versionId}:${placeId}`)) ids.add(placeId);
      }
      for (const s of searched.get(a.versionId)!) {
        for (const c of near.get(s) ?? []) {
          if (a.berths.some((b) => berthNameMatches(b, c.names, affixes, c.islands))) ids.add(c.placeId);
        }
      }
      return { documentVersionId: a.versionId, placeIds: [...ids].sort() };
    })
    .filter((u) => u.placeIds.length > 0)
    .sort((x, y) => (x.documentVersionId < y.documentVersionId ? -1 : x.documentVersionId > y.documentVersionId ? 1 : 0));
  return { units, judgedVersions: assessments.map((a) => a.versionId) };
}

export type NamedPlace = { placeId: string; names: string[]; islands: string[] };

/** Candidate/confirmed places within `radiusKm` of each given place (other than itself), with names. */
async function nearbyCandidates(db: Db, placeIds: string[], radiusKm: number): Promise<Map<string, NamedPlace[]>> {
  const { rows: pairs } = await db.execute<{ origin: string; candidate: string }>(sql`
    select o.id as origin, c.id as candidate
    from ${places} o
    join ${places} c on c.id <> o.id
      and ST_DWithin(o.position::geography, c.position::geography, ${radiusKm * 1000}::float8)
    where o.id in (${sql.join(placeIds.map((id) => sql`${id}::uuid`), sql`, `)})
      and c.merged_into_id is null and c.valid_to is null and c.status in ('candidate', 'confirmed')`);
  const byCandidate = await placeNames(db, [...new Set(pairs.map((p) => p.candidate))]);
  const result = new Map<string, NamedPlace[]>();
  for (const p of pairs) {
    const c = byCandidate.get(p.candidate);
    if (c) (result.get(p.origin) ?? result.set(p.origin, []).get(p.origin)!).push(c);
  }
  return result;
}

/**
 * The valid names of each place's geo object and, for a place on an island, the island's names; provisional research
 * names (`provisionalNameIds`) are left out, and so are places without another name.
 */
export async function placeNames(db: Db, placeIds: string[]): Promise<Map<string, NamedPlace>> {
  const byPlace = new Map<string, NamedPlace>();
  if (placeIds.length === 0) return byPlace;
  const names = await db
    .select({ placeId: places.id, geoObjectId: places.geoObjectId, id: geoNames.id, name: geoNames.name })
    .from(places)
    .innerJoin(geoNames, eq(geoNames.geoObjectId, places.geoObjectId))
    .where(and(inArray(places.id, placeIds), isNull(geoNames.validTo)));
  const provisional = await provisionalNameIds(db, [...new Set(names.map((n) => n.geoObjectId))]);
  for (const n of names) {
    if (provisional.has(n.id)) continue;
    (byPlace.get(n.placeId) ?? byPlace.set(n.placeId, { placeId: n.placeId, names: [], islands: [] }).get(n.placeId)!).names.push(n.name);
  }
  const island = alias(geoObjects, "island");
  const islands = await db
    .select({ placeId: places.id, name: geoNames.name })
    .from(places)
    .innerJoin(geoObjects, eq(geoObjects.id, places.geoObjectId))
    .innerJoin(island, and(eq(island.id, geoObjects.parentId), eq(island.type, "island")))
    .innerJoin(geoNames, eq(geoNames.geoObjectId, island.id))
    .where(and(inArray(places.id, placeIds), isNull(geoNames.validTo)));
  for (const i of islands) byPlace.get(i.placeId)?.islands.push(i.name);
  return byPlace;
}
