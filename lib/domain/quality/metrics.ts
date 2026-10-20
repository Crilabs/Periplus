import { and, eq, inArray, sql, type SQL } from "drizzle-orm";
import { getConfig, type AppConfig } from "@/lib/config";
import type { QualityConfig } from "@/lib/config/schemas";
import type { Db } from "@/lib/db/client";
import { COMPARISON_ATTRIBUTES, places, type ComparisonAttribute, type MetricKey } from "@/lib/db/schema";
import { countingSourceSql, mergedChainsSql } from "@/lib/domain/consolidation/inputs";
import { activeExtractionRunIdSql } from "@/lib/domain/extraction/active-run";
import { belegtreue } from "@/lib/domain/extraction/fidelity";
import { SECTORS, type Sector } from "@/lib/domain/facts/schema-types";
import { areaGeoObjectId } from "@/lib/pipeline/tile-scope";
import { latestComparisonResults } from "./comparison-results";
import { comparisonValues, loadComparisonSubjects } from "./comparison-values";

/*
 * Quality metrics I (spec 10 „Kennzahlen“, ruling M7-P12): one function per metric, each a value (null when it cannot
 * be computed) and details with counts only (Grundprinzip 9: never a Navily value). The places in scope are the
 * confirmed, valid places in the tiles labelled with the area (or in the one tile of a tile scope).
 */

export type QualityScope = { areaKey: string; tileId?: string };
/** A measurement window: `from` inclusive, `to` exclusive. */
export type MeasureWindow = { from: Date; to: Date };
export type MetricResult = { metric: MetricKey; value: number | null; details: Record<string, unknown> };

const share = (n: number, d: number) => (d === 0 ? null : n / d);
const validPlace = sql.raw(`p.valid_from <= current_date and (p.valid_to is null or p.valid_to > current_date)`);

type ResolvedScope = { areaId: string; tileId: string | undefined; tiles: SQL };

/** The area of the scope and the condition on `tiles t` of the scope; null for an unknown area. */
async function resolveScope(db: Db, scope: QualityScope): Promise<ResolvedScope | null> {
  const areaId = await areaGeoObjectId(db, scope.areaKey);
  if (!areaId) return null;
  const tiles = scope.tileId ? sql`t.area_id = ${areaId} and t.id = ${scope.tileId}` : sql`t.area_id = ${areaId}`;
  return { areaId, tileId: scope.tileId, tiles };
}

/** The places in scope: confirmed, valid, in a tile of the scope. */
async function placesInScope(db: Db, s: ResolvedScope): Promise<Array<{ placeId: string; geoObjectId: string }>> {
  const { rows } = await db.execute<{ place_id: string; geo_object_id: string }>(sql`
    select p.id as place_id, p.geo_object_id from places p join tiles t on t.id = p.tile_id
    where ${s.tiles} and p.status = 'confirmed' and ${validPlace}
    order by p.id
  `);
  return rows.map((r) => ({ placeId: r.place_id, geoObjectId: r.geo_object_id }));
}

/**
 * Abdeckung (spec 10): the share of the comparison set's places that are confirmed and valid. A member counts for the
 * area only while its tile is labelled with the area (and, for a tile scope, lies in that tile; ruling M7-C-R1).
 * `details { set, confirmed }`; an empty set is null.
 */
export async function coverageMetric(db: Db, scope: QualityScope): Promise<MetricResult> {
  const s = await resolveScope(db, scope);
  if (!s) return { metric: "coverage", value: null, details: { set: 0, confirmed: 0 } };
  const { rows } = await db.execute<{ set: number; confirmed: number }>(sql`
    select count(*)::int as set, count(*) filter (where p.status = 'confirmed' and ${validPlace})::int as confirmed
    from comparison_set cs join places p on p.id = cs.place_id join tiles t on t.id = p.tile_id
    where cs.area_id = ${s.areaId} and ${s.tiles}
  `);
  const set = Number(rows[0]!.set);
  const confirmed = Number(rows[0]!.confirmed);
  return { metric: "coverage", value: share(confirmed, set), details: { set, confirmed } };
}

/** The UTC date (`YYYY-MM-DD`) source validity is judged on when the caller gives none. */
const utcToday = () => new Date().toISOString().slice(0, 10);

/*
 * Text counts for a place as consolidation counts it (ruling M7-C-R2): mentions, facts and route stops of the place's
 * object and of every object merged into it (`mergedChainsSql`), from sources that are neither rejected nor ended on
 * `today` (`countingSourceSql`, aliases `documents d`, `sources s`).
 */

/**
 * Mehrbefund (spec 10): the share of places in scope with mentions from documents of at least two different sources.
 * `details { places, multi, multiDocument }`; `multiDocument` counts places with mentions from at least two documents,
 * the datendienst definition the acceptance uses (ruling M7-P12; its own metric key arrives with Task 8).
 */
export async function multiSourceMetric(db: Db, scope: QualityScope, opts: { today?: string } = {}): Promise<MetricResult> {
  const counts = await mentionCounts(db, scope, opts.today ?? utcToday());
  if (!counts) return { metric: "multi_source", value: null, details: { places: 0, multi: 0, multiDocument: 0 } };
  return {
    metric: "multi_source",
    value: share(counts.multi, counts.places),
    details: { places: counts.places, multi: counts.multi, multiDocument: counts.multiDocument },
  };
}

/** Places in scope, those with mentions from ≥ 2 sources and from ≥ 2 documents; null for an unknown area. */
async function mentionCounts(db: Db, scope: QualityScope, today: string) {
  const s = await resolveScope(db, scope);
  if (!s) return null;
  const { rows } = await db.execute<{ places: number; multi: number; multi_document: number }>(sql`
    with scope_places as (
      select p.id, p.geo_object_id from places p join tiles t on t.id = p.tile_id
      where ${s.tiles} and p.status = 'confirmed' and ${validPlace}
    ),
    chains as ${mergedChainsSql(sql`select geo_object_id as id from scope_places`)},
    per_place as (
      select sp.id, count(distinct x.document_id) as documents, count(distinct x.source_id) as sources
      from scope_places sp
      left join lateral (
        select d.id as document_id, d.source_id
        from chains c
        join mentions m on m.geo_object_id = c.id
        join document_versions v on v.id = m.document_version_id
        join documents d on d.id = v.document_id
        join sources s on s.id = d.source_id
        where c.root_id = sp.geo_object_id and ${countingSourceSql(today)}
      ) x on true
      group by sp.id
    )
    select count(*)::int as places, count(*) filter (where sources >= 2)::int as multi,
      count(*) filter (where documents >= 2)::int as multi_document
    from per_place
  `);
  return { places: Number(rows[0]!.places), multi: Number(rows[0]!.multi), multiDocument: Number(rows[0]!.multi_document) };
}

type AttributeCounts = { compared: number; correct: number };

/**
 * Fact-Präzision (spec 10): over the newest outcome of each compared attribute of the set's places (in the tile, for a
 * tile scope) for its current own value hash, (`match` + `deviation_confirmed_own`) / all outcomes except
 * `not_at_navily` (so `deviation`, `deviation_confirmed_navily` and `unclear` count against it). An attribute without
 * an outcome for its current hash is `pending`; an outcome for an older hash counts nowhere. `matches` and
 * `autoMatches` report the share of machine-accepted matches (`proposal_auto`, ruling M7-P24). No compared outcome →
 * null.
 */
export async function factPrecisionMetric(
  db: Db,
  scope: QualityScope,
  opts: { evaluationRunId?: string } = {},
): Promise<MetricResult> {
  const cfg = getConfig().quality.navily;
  let subjects = await loadComparisonSubjects(db, scope.areaKey, { evaluationRunId: opts.evaluationRunId });
  if (scope.tileId && subjects.length > 0) {
    const inTile = await db
      .select({ id: places.id })
      .from(places)
      .where(and(inArray(places.id, subjects.map((s) => s.placeId)), eq(places.tileId, scope.tileId)));
    const ids = new Set(inTile.map((r) => r.id));
    subjects = subjects.filter((s) => ids.has(s.placeId));
  }
  const latest = await latestComparisonResults(db, subjects.map((s) => s.placeId));
  const byAttribute = Object.fromEntries(COMPARISON_ATTRIBUTES.map((a) => [a, { compared: 0, correct: 0 }])) as Record<
    ComparisonAttribute,
    AttributeCounts
  >;
  let notAtNavily = 0;
  let pending = 0;
  let matches = 0;
  let autoMatches = 0;
  for (const subject of subjects) {
    const values = comparisonValues(subject, cfg);
    for (const attribute of COMPARISON_ATTRIBUTES) {
      const r = latest.get(`${subject.placeId}|${attribute}|${values[attribute].hash}`);
      if (!r) {
        pending++;
        continue;
      }
      if (r.result === "not_at_navily") {
        notAtNavily++;
        continue;
      }
      byAttribute[attribute].compared++;
      if (r.result === "match" || r.result === "deviation_confirmed_own") byAttribute[attribute].correct++;
      if (r.result === "match") {
        matches++;
        if (r.method === "proposal_auto") autoMatches++;
      }
    }
  }
  const compared = COMPARISON_ATTRIBUTES.reduce((n, a) => n + byAttribute[a].compared, 0);
  const correct = COMPARISON_ATTRIBUTES.reduce((n, a) => n + byAttribute[a].correct, 0);
  return {
    metric: "fact_precision",
    value: share(correct, compared),
    details: { compared, correct, notAtNavily, pending, matches, autoMatches, byAttribute },
  };
}

/**
 * Belegtreue (spec 10) of the text runs created in the window: the sum of `belegtreue(runId)` (verified / checked text
 * facts and route stops). A text run is one that owns an extraction run: those are exactly the runs with a stage of
 * `TEXT_RUN_STAGES` (and the model comparison) that extracted anything, and a run without one adds nothing to the sums
 * (`TEXT_RUN_STAGES` lives with the run starters, which import the queue; this module stays free of them). `details
 * { facts, verified, runs }`; without text facts null.
 */
export async function quoteFidelityMetric(db: Db, window: MeasureWindow): Promise<MetricResult> {
  const { rows } = await db.execute<{ id: string }>(sql`
    select r.id from runs r
    where r.created_at >= ${window.from.toISOString()}::timestamptz and r.created_at < ${window.to.toISOString()}::timestamptz
      and exists (select 1 from extraction_runs er where er.run_id = r.id)
    order by r.created_at, r.id
  `);
  let facts = 0;
  let verified = 0;
  for (const { id } of rows) {
    const b = await belegtreue(db, id);
    facts += b.facts;
    verified += b.verified;
  }
  return { metric: "quote_fidelity", value: share(verified, facts), details: { facts, verified, runs: rows.length } };
}

type SectorCounts = { withText: number; confirmed: number; corrected: number; textOnly: number };

/**
 * Schutz-Konfidenz (spec 10): the share of places in scope where every one of the 8 sectors `shelter.<Sektor>` has at
 * least one text fact of the active extraction run of its (document version, object) (`activeExtractionRunIdSql`),
 * counted as consolidation counts text (merged objects, counting sources). A sector's text confirms the newest computed
 * value of the place's own object when one of its facts lies within `shelterConfirmTolerance` of it, else it corrects
 * it; without a computed value it is text only (ruling M7-C-R1). `details { places, complete, confirmed, corrected,
 * textOnly, bySector }`, counted per place and sector with text; no places → null. Two queries for any number of places.
 */
export async function shelterConfidenceMetric(
  db: Db,
  scope: QualityScope,
  cfg: QualityConfig,
  opts: { appConfig?: AppConfig; today?: string } = {},
): Promise<MetricResult> {
  const appConfig = opts.appConfig ?? getConfig();
  const bySector = Object.fromEntries(SECTORS.map((x) => [x, { withText: 0, confirmed: 0, corrected: 0, textOnly: 0 }])) as Record<
    Sector,
    SectorCounts
  >;
  const empty = { places: 0, complete: 0, confirmed: 0, corrected: 0, textOnly: 0, bySector };
  const s = await resolveScope(db, scope);
  if (!s) return { metric: "shelter_confidence", value: null, details: empty };
  const inScope = await placesInScope(db, s);
  if (inScope.length === 0) return { metric: "shelter_confidence", value: null, details: empty };

  const objectIds = JSON.stringify(inScope.map((p) => p.geoObjectId));
  const sectorAttributes = JSON.stringify(SECTORS.map((x) => `shelter.${x}`));
  const { rows: texts } = await db.execute<{ root_id: string; attribute: string; value: unknown }>(sql`
    with chains as ${mergedChainsSql(sql`select value::uuid as id from jsonb_array_elements_text(${objectIds}::jsonb)`)},
    text_facts as (
      select c.root_id, f.geo_object_id, f.attribute, f.value, f.extraction_run_id, m.document_version_id as version_id
      from chains c
      join facts f on f.geo_object_id = c.id
      join mentions m on m.id = f.mention_id
      join document_versions v on v.id = m.document_version_id
      join documents d on d.id = v.document_id
      join sources s on s.id = d.source_id
      where f.mention_id is not null
        and f.attribute in (select value from jsonb_array_elements_text(${sectorAttributes}::jsonb))
        and ${countingSourceSql(opts.today ?? utcToday())}
    ),
    units as (
      select k.version_id, k.geo_object_id,
        ${activeExtractionRunIdSql(appConfig, sql.raw("k.version_id"), sql.raw("k.geo_object_id"))} as run_id
      from (select distinct version_id, geo_object_id from text_facts) k
    )
    select t.root_id, t.attribute, t.value
    from text_facts t join units u on u.version_id = t.version_id and u.geo_object_id = t.geo_object_id
    where u.run_id = t.extraction_run_id
    order by t.root_id, t.attribute
  `);
  const textBySector = new Map<string, number[]>(); // "<place object>|<sector>" → text values of active runs
  for (const r of texts) {
    if (typeof r.value !== "number") continue;
    const key = `${r.root_id}|${r.attribute.slice("shelter.".length)}`;
    textBySector.set(key, [...(textBySector.get(key) ?? []), r.value]);
  }

  // the newest shelter computation of each place's own object (merged objects' computations describe ended geometry)
  const { rows: computed } = await db.execute<{ geo_object_id: string; attribute: string; value: unknown }>(sql`
    with newest as (
      select distinct on (c.geo_object_id) c.id, c.geo_object_id from computations c
      where c.kind = 'shelter' and c.geo_object_id in (select value::uuid from jsonb_array_elements_text(${objectIds}::jsonb))
      order by c.geo_object_id, c.created_at desc, c.id desc
    )
    select n.geo_object_id, f.attribute, f.value from newest n join facts f on f.computation_id = n.id
    order by n.geo_object_id, f.attribute
  `);
  const computedValue = new Map(computed.flatMap((r) => (typeof r.value === "number" ? [[`${r.geo_object_id}|${r.attribute}`, r.value] as const] : [])));

  const EPSILON = 1e-9;
  let complete = 0;
  for (const place of inScope) {
    let sectors = 0;
    for (const sector of SECTORS) {
      const values = textBySector.get(`${place.geoObjectId}|${sector}`);
      if (!values) continue;
      sectors++;
      const c = computedValue.get(`${place.geoObjectId}|shelter.${sector}`);
      bySector[sector].withText++;
      if (c === undefined) bySector[sector].textOnly++;
      else if (values.some((t) => Math.abs(t - c) <= cfg.shelterConfirmTolerance + EPSILON)) bySector[sector].confirmed++;
      else bySector[sector].corrected++;
    }
    if (sectors === SECTORS.length) complete++;
  }
  const sum = (k: keyof SectorCounts) => SECTORS.reduce((n, x) => n + bySector[x][k], 0);
  return {
    metric: "shelter_confidence",
    value: share(complete, inScope.length),
    details: { places: inScope.length, complete, confirmed: sum("confirmed"), corrected: sum("corrected"), textOnly: sum("textOnly"), bySector },
  };
}

type ReportRoute = { documentId: string; stops: number; openStops: number; complete: boolean };

/**
 * Routen-Rekonstruktion per trip report (ruling M7-P12, datendienst „Anteil der Törnberichte“): each document of a
 * counting source whose current version is a trip report (classified type, else the fetch-time type) counts with the
 * newest route of a finished (quote check passed, never blocked) `extract-route` run on that version, not of a model
 * comparison, when at least one stop lies at a place (of any status) in a tile of the scope. Complete = every stop is
 * assigned to a geo object with a confirmed, valid place. A stop at an object merged into a place's object is at that
 * place (ruling M7-C-R2). `details { routes, complete, openStops, reports }` (reports: own document ids with stop
 * counts, for the pilot report); no such report → null.
 */
export async function routeReconstructionMetric(db: Db, scope: QualityScope, opts: { today?: string } = {}): Promise<MetricResult> {
  const s = await resolveScope(db, scope);
  if (!s) return { metric: "route_reconstruction", value: null, details: { routes: 0, complete: 0, openStops: 0, reports: [] } };
  const { rows } = await db.execute<{ document_id: string; stops: number; open_stops: number }>(sql`
    with newest as (
      select distinct on (d.id) d.id as document_id, ro.id as route_id
      from documents d
      join sources s on s.id = d.source_id
      join document_versions v on v.id = d.current_version_id
      join routes ro on ro.document_version_id = v.id
      join extraction_runs er on er.id = ro.extraction_run_id
      where coalesce(v.classified_doc_type, v.doc_type) = 'trip_report' and ${countingSourceSql(opts.today ?? utcToday())}
        and er.task = 'extract-route' and er.status = 'finished' and er.purpose <> 'comparison'
      order by d.id, er.started_at desc, er.id desc
    ),
    known_places as (
      select p.geo_object_id, bool_or(p.status = 'confirmed') as confirmed, bool_or(${s.tiles}) as in_scope
      from places p join tiles t on t.id = p.tile_id
      where ${validPlace} and (p.status = 'confirmed' or ${s.tiles})
      group by p.geo_object_id
    ),
    chains as ${mergedChainsSql(sql`select geo_object_id as id from known_places`)},
    stops as (
      select n.document_id,
        exists (
          select 1 from chains c join known_places k on k.geo_object_id = c.root_id
          where c.id = st.geo_object_id and k.confirmed
        ) as at_place,
        exists (
          select 1 from chains c join known_places k on k.geo_object_id = c.root_id
          where c.id = st.geo_object_id and k.in_scope
        ) as in_scope
      from newest n join route_stops st on st.route_id = n.route_id
    )
    select document_id, count(*)::int as stops, count(*) filter (where not at_place)::int as open_stops
    from stops group by document_id having bool_or(in_scope)
    order by document_id
  `);
  const reports: ReportRoute[] = rows.map((r) => ({
    documentId: r.document_id,
    stops: Number(r.stops),
    openStops: Number(r.open_stops),
    complete: Number(r.open_stops) === 0,
  }));
  const complete = reports.filter((r) => r.complete).length;
  return {
    metric: "route_reconstruction",
    value: share(complete, reports.length),
    details: { routes: reports.length, complete, openStops: reports.reduce((n, r) => n + r.openStops, 0), reports },
  };
}
