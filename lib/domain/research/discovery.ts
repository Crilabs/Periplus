import { and, asc, eq, isNull, sql } from "drizzle-orm";
import type { ExtractRouteOutput } from "@/lib/ai/tasks/extract-route";
import type { AppConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { documentVersions, geoNames, pageAssessments, places, researchRouteStops } from "@/lib/db/schema";
import { locateQuote } from "@/lib/domain/extraction/quote";
import { isGreek, normalizeName } from "@/lib/domain/gazetteer/names";
import { plausibleDate } from "@/lib/domain/mentions/classification";
import { jsonUuids } from "@/lib/domain/mentions/scope";
import { activeAssessor } from "./assessment";
import { activeRouteExtractor, berthNameForms, berthNameMatches, placeNames, type NamedPlace } from "./assign";

/*
 * Routes of trip reports and the anchored discovery of the stops they name (plan N2, spec 5.5): texts choose among the
 * places that are geographically possible, they never invent coordinates. A stop is assigned to a known place by name
 * (near its assigned neighbour stops, else near the page's own places or in their subdivision) or, between two
 * assigned neighbours, to the one candidate bay in the corridor between them. An assignment never changes a place's
 * status; it only makes the page a page of that place (`unitsForPlaces`), so extraction and confirmation decide.
 */

/** One answered section of a report: the text the model read and its answer. */
export type RouteSectionAnswer = { text: string; output: ExtractRouteOutput };

/**
 * Stores the route stops of a version from the answers of its sections, in section order, for the given route model and
 * prompt version: per section at most `research.extraction.routeMaxStops` stops are looked at; a stop needs a name
 * (≤ `extraction.routeStop.nameMaxChars`) and a quote the quote check finds in its section, else it is dropped. Kept
 * stops are numbered from 0 and dated with their own plausible date, else the page's observation date. Idempotent: a
 * version that has stops of this model and prompt keeps them.
 */
export async function storeRouteStops(
  db: Db,
  input: { documentVersionId: string; model: string; promptVersion: number; observedAt: string; fetchedAt: Date; sections: RouteSectionAnswer[] },
  cfg: AppConfig,
): Promise<{ stored: number; dropped: number }> {
  const [existing] = await db
    .select({ id: researchRouteStops.id })
    .from(researchRouteStops)
    .where(
      and(
        eq(researchRouteStops.documentVersionId, input.documentVersionId),
        eq(researchRouteStops.model, input.model),
        eq(researchRouteStops.promptVersion, input.promptVersion),
      ),
    )
    .limit(1);
  if (existing) return { stored: 0, dropped: 0 };
  let dropped = 0;
  const rows: Array<typeof researchRouteStops.$inferInsert> = [];
  for (const section of input.sections) {
    const considered = section.output.stops.slice(0, cfg.research.extraction.routeMaxStops);
    dropped += section.output.stops.length - considered.length;
    for (const stop of considered) {
      const name = stop.name.trim();
      if (name.length === 0 || name.length > cfg.extraction.routeStop.nameMaxChars || !locateQuote(section.text, stop.quote, cfg.extraction.quote).ok) {
        dropped++;
        continue;
      }
      rows.push({
        documentVersionId: input.documentVersionId,
        seq: rows.length,
        name,
        mooringKind: stop.mooring,
        quote: stop.quote,
        observedAt: plausibleDate(stop.date, input.fetchedAt, cfg.extraction.earliestDate, false) ?? input.observedAt,
        model: input.model,
        promptVersion: input.promptVersion,
      });
    }
  }
  if (rows.length > 0) await db.insert(researchRouteStops).values(rows).onConflictDoNothing();
  return { stored: rows.length, dropped };
}

type Stop = { id: string; name: string; placeId: string | null; observedAt: string };

/** The language of a page: its active assessment's, else the version's, else `und`. */
async function pageLanguage(db: Db, documentVersionId: string, cfg: AppConfig): Promise<string> {
  const { model, promptVersion } = activeAssessor(cfg);
  const [row] = await db
    .select({ assessed: pageAssessments.language, version: documentVersions.language })
    .from(documentVersions)
    .leftJoin(
      pageAssessments,
      and(
        eq(pageAssessments.documentVersionId, documentVersions.id),
        eq(pageAssessments.model, model),
        eq(pageAssessments.promptVersion, promptVersion),
      ),
    )
    .where(eq(documentVersions.id, documentVersionId));
  return row?.assessed ?? row?.version ?? "und";
}

/**
 * Places (valid, not merged, not `rejected`) within `radiusKm` of one of `nearPlaceIds` or in one of the subdivisions
 * of `subdivisionOf` places, with their names (`placeNames`; unnamed places are left out).
 */
async function namedPool(db: Db, nearPlaceIds: string[], radiusKm: number, subdivisionOf: string[] = []): Promise<NamedPlace[]> {
  if (nearPlaceIds.length === 0 && subdivisionOf.length === 0) return [];
  const { rows } = await db.execute<{ id: string }>(sql`
    select c.id from ${places} c join geo_objects g on g.id = c.geo_object_id
    where c.merged_into_id is null and c.valid_to is null and c.status <> 'rejected'
      and (
        exists (select 1 from ${places} o where o.id in ${jsonUuids(nearPlaceIds)}
          and ST_DWithin(o.position::geography, c.position::geography, ${radiusKm * 1000}::float8))
        or g.subdivision_id in (
          select og.subdivision_id from ${places} o join geo_objects og on og.id = o.geo_object_id
          where o.id in ${jsonUuids(subdivisionOf)} and og.subdivision_id is not null)
      )`);
  return [...(await placeNames(db, rows.map((r) => r.id))).values()];
}

/** The one place of the pool whose name is the stop's, or null when none or several are. */
function onlyNameMatch(pool: NamedPlace[], name: string, cfg: AppConfig): string | null {
  const matches = pool.filter((p) => berthNameMatches({ name, island: null }, p.names, cfg.nameAffixes, p.islands));
  return matches.length === 1 ? matches[0]!.placeId : null;
}

/** Highest pg_trgm similarity between any name form of the stop and any name form of each named place. */
async function similarities(db: Db, name: string, named: NamedPlace[], cfg: AppConfig): Promise<Map<string, number>> {
  const mine = berthNameForms(name, cfg.nameAffixes);
  const pairs = named.flatMap((p) => p.names.flatMap((n) => berthNameForms(n, cfg.nameAffixes)).flatMap((theirs) => mine.map((m) => [p.placeId, m, theirs])));
  const out = new Map<string, number>();
  if (pairs.length === 0) return out;
  const { rows } = await db.execute<{ id: string; sim: number }>(sql`
    select p ->> 0 as id, max(similarity(p ->> 1, p ->> 2))::float8 as sim
    from jsonb_array_elements(${JSON.stringify(pairs)}::jsonb) p group by p ->> 0`);
  for (const r of rows) out.set(r.id, Number(r.sim));
  return out;
}

type CorridorMatch = { placeId: string; nameIt: { geoObjectId: string } | null };

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The candidate in the corridor (`discovery.corridorBufferKm` around the straight line between the places of the
 * previous and the next stop) the stop means. Only for a plausible leg: the straight line is at most
 * `discovery.maxLegKm` long and the two stops are dated at most `discovery.maxLegDays` apart. Of the
 * `anchorage`/`mooring_field` candidates (status `candidate`), the only one whose name is similar enough
 * (`discovery.minNameSimilarity`); without such a one, the only unnamed one (provisional research names do not count
 * as names), which then gets the stop's name, unless a named candidate matches the stop by name or reaches
 * `discovery.vetoSimilarity` (the stop may well mean it). Otherwise null.
 */
async function corridorMatch(db: Db, stop: Stop, prev: Stop, next: Stop, cfg: AppConfig): Promise<CorridorMatch | null> {
  const { corridorBufferKm, minNameSimilarity, vetoSimilarity, maxLegKm, maxLegDays } = cfg.research.discovery;
  if (Math.abs(Date.parse(next.observedAt) - Date.parse(prev.observedAt)) > maxLegDays * DAY_MS) return null;
  const { rows } = await db.execute<{ id: string; geo_object_id: string }>(sql`
    select c.id, c.geo_object_id from ${places} c, ${places} a, ${places} b
    where a.id = ${prev.placeId}::uuid and b.id = ${next.placeId}::uuid and c.id <> a.id and c.id <> b.id
      and ST_Distance(a.position::geography, b.position::geography) <= ${maxLegKm * 1000}::float8
      and c.merged_into_id is null and c.valid_to is null and c.status = 'candidate' and c.kind in ('anchorage', 'mooring_field')
      and ST_DWithin(c.position::geography, ST_MakeLine(a.position, b.position)::geography, ${corridorBufferKm * 1000}::float8)`);
  if (rows.length === 0) return null;
  const named = await placeNames(db, rows.map((r) => r.id));
  const sims = await similarities(db, stop.name, [...named.values()], cfg);
  const similar = [...sims].filter(([, s]) => s >= minNameSimilarity).map(([id]) => id);
  if (similar.length === 1) return { placeId: similar[0]!, nameIt: null };
  if (similar.length > 1) return null;
  const vetoed = [...named.values()].some(
    (p) => (sims.get(p.placeId) ?? 0) >= vetoSimilarity || berthNameMatches({ name: stop.name, island: null }, p.names, cfg.nameAffixes, p.islands),
  );
  if (vetoed) return null;
  const unnamed = rows.filter((r) => !named.has(r.id));
  return unnamed.length === 1 ? { placeId: unnamed[0]!.id, nameIt: { geoObjectId: unnamed[0]!.geo_object_id } } : null;
}

/** Gives an unnamed bay the stop's name as a provisional research name: never preferred, no transliteration. */
async function addResearchName(db: Db, geoObjectId: string, name: string, language: string): Promise<void> {
  const clean = name.trim().replace(/\s+/g, " ");
  await db
    .insert(geoNames)
    .values({ geoObjectId, name: clean, nameNormalized: normalizeName(clean), language, script: isGreek(clean) ? "greek" : "latin", origin: "research", isPreferred: false })
    .onConflictDoNothing();
}

/**
 * Assigns the open route stops of a page version (active route model and prompt) to places (spec 5.5), repeated until
 * nothing changes:
 * 0. anchors: a stop naming exactly one of the page's own places (its research hits) → `match = name`;
 * 1. by name (`berthNameMatches`, provisional research names left out) when a neighbour stop is assigned: the only
 *    place (not `rejected`) of that name within `extraction.placeRadiusKm` of the assigned neighbours → `match = name`;
 *    with zero or several, the stop waits (a stop with an assigned neighbour never falls back to the page area);
 * 2. when the previous and the next stop are assigned, the corridor candidate (`corridorMatch`) → `match = corridor`;
 *    an unnamed one gets the stop's name in the page's language as a provisional research name. A named candidate is
 *    never renamed;
 * 3. only when 1 and 2 change nothing: the first open stop without an assigned neighbour, by name, the only place
 *    within that radius of the page's own places or in their subdivisions → `match = name`; then again from 1.
 * Otherwise the stop stays open. No status changes. Pages linked here are extracted by the next research run (the
 * stage order is extract → routes → discover → confirm). Returns the stops assigned now and those still open.
 */
export async function matchStops(db: Db, documentVersionId: string, cfg: AppConfig): Promise<{ byName: number; byCorridor: number; open: number }> {
  const { model, promptVersion } = activeRouteExtractor(cfg);
  const stops: Stop[] = await db
    .select({ id: researchRouteStops.id, name: researchRouteStops.name, placeId: researchRouteStops.placeId, observedAt: researchRouteStops.observedAt })
    .from(researchRouteStops)
    .where(
      and(
        eq(researchRouteStops.documentVersionId, documentVersionId),
        eq(researchRouteStops.model, model),
        eq(researchRouteStops.promptVersion, promptVersion),
      ),
    )
    .orderBy(asc(researchRouteStops.seq));
  const result = { byName: 0, byCorridor: 0, open: 0 };
  if (stops.every((s) => s.placeId !== null)) return result;

  const { rows: hits } = await db.execute<{ place_id: string; usable: boolean }>(sql`
    select distinct h.place_id, (p.merged_into_id is null and p.valid_to is null and p.status <> 'rejected') as usable
    from research_hits h
    join places p on p.id = h.place_id
    join documents d on d.url_normalized = h.url_normalized
    join document_versions v on v.document_id = d.id
    where v.id = ${documentVersionId}::uuid and h.purpose <> 'landside'`);
  const pagePlaces = hits.map((h) => h.place_id);
  const radiusKm = cfg.research.extraction.placeRadiusKm;
  let pagePool: NamedPlace[] | undefined;
  let language: string | undefined;

  /** Assigns the stop unless another job did first; counts only an update that took effect. */
  const assign = async (stop: Stop, placeId: string, match: "name" | "corridor"): Promise<boolean> => {
    const updated = await db
      .update(researchRouteStops)
      .set({ placeId, match })
      .where(and(eq(researchRouteStops.id, stop.id), isNull(researchRouteStops.placeId)))
      .returning({ id: researchRouteStops.id });
    if (updated.length === 0) {
      const [now] = await db.select({ placeId: researchRouteStops.placeId }).from(researchRouteStops).where(eq(researchRouteStops.id, stop.id));
      stop.placeId = now?.placeId ?? null;
      return false;
    }
    stop.placeId = placeId;
    if (match === "name") result.byName++;
    else result.byCorridor++;
    return true;
  };

  const pageMatch = async (stop: Stop): Promise<string | null> => {
    pagePool ??= await namedPool(db, pagePlaces, radiusKm, pagePlaces);
    return onlyNameMatch(pagePool, stop.name, cfg);
  };
  const neighboursOf = (i: number) => [stops[i - 1]?.placeId, stops[i + 1]?.placeId].filter((id): id is string => !!id);

  // Anchors: stops that name one of the places the page was found for.
  const anchors = [...(await placeNames(db, hits.filter((h) => h.usable).map((h) => h.place_id))).values()];
  for (const stop of stops) {
    if (stop.placeId) continue;
    const placeId = onlyNameMatch(anchors, stop.name, cfg);
    if (placeId) await assign(stop, placeId, "name");
  }

  for (let changed = true; changed; ) {
    changed = false;
    // 1. by name near the assigned neighbours; a stop with an assigned neighbour never falls back to the page area
    for (let progress = true; progress; ) {
      progress = false;
      for (const [i, stop] of stops.entries()) {
        const neighbours = neighboursOf(i);
        if (stop.placeId || neighbours.length === 0) continue;
        const placeId = onlyNameMatch(await namedPool(db, neighbours, radiusKm), stop.name, cfg);
        if (placeId) {
          await assign(stop, placeId, "name");
          progress = changed = true;
        }
      }
    }
    // 2. corridor between two assigned neighbours
    for (const [i, stop] of stops.entries()) {
      const prev = stops[i - 1];
      const next = stops[i + 1];
      if (stop.placeId || !prev?.placeId || !next?.placeId) continue;
      const found = await corridorMatch(db, stop, prev, next, cfg);
      if (!found) continue;
      if ((await assign(stop, found.placeId, "corridor")) && found.nameIt) {
        language ??= await pageLanguage(db, documentVersionId, cfg);
        await addResearchName(db, found.nameIt.geoObjectId, stop.name, language);
      }
      changed = true;
    }
    if (changed) continue;
    // 3. by name in the page area, for the first open stop (in route order) without an assigned neighbour; then again from 1
    for (const [i, stop] of stops.entries()) {
      if (stop.placeId || neighboursOf(i).length > 0) continue;
      const placeId = await pageMatch(stop);
      if (placeId) {
        await assign(stop, placeId, "name");
        changed = true;
        break;
      }
    }
  }
  result.open = stops.filter((s) => !s.placeId).length;
  return result;
}
