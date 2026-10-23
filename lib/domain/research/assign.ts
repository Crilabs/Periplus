import { alias } from "drizzle-orm/pg-core";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { getConfig, type AppConfig, type NameAffixesConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { documents, geoNames, geoObjects, pageAssessments, places, researchHits } from "@/lib/db/schema";
import { normalizeName } from "@/lib/domain/gazetteer/names";
import { stripAffix } from "@/lib/domain/mentions/affixes";
import { activeAssessor } from "./assessment";

/*
 * Assigns assessed pages to berth candidates (plan N2): a page that is a research hit of place A may name other
 * berths nearby; each such candidate within the extraction radius whose name matches an assessed berth of the page
 * becomes part of the page's research unit. Names are compared normalized and without generic affixes, never fuzzy.
 */

export type ResearchUnitPlan = { documentVersionId: string; placeIds: string[] };

/** Name forms to compare: the normalized name and, when it has a generic affix, the core without it. */
function forms(name: string, affixes: NameAffixesConfig): string[] {
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
  const mine = forms(assessed.name, affixes);
  return candidateNames.some((name) => forms(name, affixes).some((c) => mine.some((m) => containsWords(c, m) || containsWords(m, c))));
}

/**
 * The research units of the places' hit pages: per current, actively assessed, not `generated` version of a hit
 * document, the searched places plus every candidate within `extraction.placeRadiusKm` of a searched place whose name
 * matches an assessed berth of the page. Sorted by version, places by id.
 */
export async function unitsForPlaces(db: Db, placeIds: string[], cfg: AppConfig = getConfig()): Promise<ResearchUnitPlan[]> {
  if (placeIds.length === 0) return [];
  const { model, promptVersion } = activeAssessor(cfg);

  // version -> searched places (hits of these places on the version's document)
  const hitRows = await db
    .selectDistinct({ placeId: researchHits.placeId, versionId: documents.currentVersionId })
    .from(researchHits)
    .innerJoin(documents, eq(documents.urlNormalized, researchHits.urlNormalized))
    .where(inArray(researchHits.placeId, placeIds));
  const searched = new Map<string, Set<string>>();
  for (const h of hitRows) {
    if (!h.versionId) continue;
    (searched.get(h.versionId) ?? searched.set(h.versionId, new Set()).get(h.versionId)!).add(h.placeId);
  }
  if (searched.size === 0) return [];

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
  const searchedIds = [...new Set(hitRows.map((h) => h.placeId))];
  const near = await nearbyCandidates(db, searchedIds, cfg.research.extraction.placeRadiusKm);
  const affixes = cfg.nameAffixes;

  return assessments
    .map((a): ResearchUnitPlan => {
      const ids = new Set(searched.get(a.versionId)!);
      for (const s of searched.get(a.versionId)!) {
        for (const c of near.get(s) ?? []) {
          if (a.berths.some((b) => berthNameMatches(b, c.names, affixes, c.islands))) ids.add(c.placeId);
        }
      }
      return { documentVersionId: a.versionId, placeIds: [...ids].sort() };
    })
    .sort((x, y) => (x.documentVersionId < y.documentVersionId ? -1 : x.documentVersionId > y.documentVersionId ? 1 : 0));
}

type NearCandidate = { placeId: string; names: string[]; islands: string[] };

/** Candidate/confirmed places within `radiusKm` of each given place (other than itself), with names. */
async function nearbyCandidates(db: Db, placeIds: string[], radiusKm: number): Promise<Map<string, NearCandidate[]>> {
  const { rows: pairs } = await db.execute<{ origin: string; candidate: string }>(sql`
    select o.id as origin, c.id as candidate
    from ${places} o
    join ${places} c on c.id <> o.id
      and ST_DWithin(o.position::geography, c.position::geography, ${radiusKm * 1000}::float8)
    where o.id in (${sql.join(placeIds.map((id) => sql`${id}::uuid`), sql`, `)})
      and c.merged_into_id is null and c.valid_to is null and c.status in ('candidate', 'confirmed')`);
  const candidateIds = [...new Set(pairs.map((p) => p.candidate))];
  const byCandidate = new Map<string, NearCandidate>();
  if (candidateIds.length > 0) {
    const names = await db
      .select({ placeId: places.id, name: geoNames.name })
      .from(places)
      .innerJoin(geoNames, eq(geoNames.geoObjectId, places.geoObjectId))
      .where(and(inArray(places.id, candidateIds), isNull(geoNames.validTo)));
    for (const n of names) {
      (byCandidate.get(n.placeId) ?? byCandidate.set(n.placeId, { placeId: n.placeId, names: [], islands: [] }).get(n.placeId)!).names.push(n.name);
    }
    const island = alias(geoObjects, "island");
    const islands = await db
      .select({ placeId: places.id, name: geoNames.name })
      .from(places)
      .innerJoin(geoObjects, eq(geoObjects.id, places.geoObjectId))
      .innerJoin(island, and(eq(island.id, geoObjects.parentId), eq(island.type, "island")))
      .innerJoin(geoNames, eq(geoNames.geoObjectId, island.id))
      .where(and(inArray(places.id, candidateIds), isNull(geoNames.validTo)));
    for (const i of islands) byCandidate.get(i.placeId)?.islands.push(i.name);
  }
  const result = new Map<string, NearCandidate[]>();
  for (const p of pairs) {
    const c = byCandidate.get(p.candidate);
    if (c) (result.get(p.origin) ?? result.set(p.origin, []).get(p.origin)!).push(c);
  }
  return result;
}
