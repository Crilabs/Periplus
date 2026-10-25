import { and, eq, inArray, sql, type SQL } from "drizzle-orm";
import { getConfig, type AppConfig } from "@/lib/config";
import type { QualityConfig } from "@/lib/config/schemas";
import type { Db } from "@/lib/db/client";
import { COMPARISON_ATTRIBUTES, places, type ComparisonAttribute, type MetricKey } from "@/lib/db/schema";
import { derivedBerthable } from "@/lib/domain/rules/berthable";
import { countingSourceSql, mergedChainsSql } from "@/lib/domain/consolidation/inputs";
import { activeExtractionRunIdSql } from "@/lib/domain/extraction/active-run";
import { belegtreue } from "@/lib/domain/extraction/fidelity";
import { SECTORS, type Sector } from "@/lib/domain/facts/schema-types";
import { latestProfiles } from "@/lib/domain/timeline";
import { subdivisionByKey } from "@/lib/domain/subdivisions/store";
import { latestComparisonResults } from "./comparison-results";
import { comparisonValues, loadComparisonSubjects } from "./comparison-values";

/*
 * Quality metrics I (spec 10 „Kennzahlen“, ruling M7-P12): one function per metric, each a value (null when it cannot
 * be computed) and details with counts only (Grundprinzip 9: never a Navily value). The places in scope are the
 * confirmed, valid places of the subdivision (`geo_objects.subdivision_id`, nearest land, spec 14; the tile label decides nothing here)
 * or, for a tile scope, those of the subdivision in that tile.
 */

export type QualityScope = { subdivisionKey: string; tileId?: string };
/** A measurement window: `from` inclusive, `to` exclusive. */
export type MeasureWindow = { from: Date; to: Date };
export type MetricResult = { metric: MetricKey; value: number | null; details: Record<string, unknown> };

const share = (n: number, d: number) => (d === 0 ? null : n / d);

/** The UTC date (`YYYY-MM-DD`) validity is judged on when the caller gives none. */
const utcToday = () => new Date().toISOString().slice(0, 10);

/*
 * Validity of places (`p`) and tiles (`t`) on `today`, the one date a measurement judges on (the job's UTC date, also
 * for sources), never the database date (ruling M7-D-R2/R3).
 */
const validPlaceOn = (today: string) => sql`p.valid_from <= ${today}::date and (p.valid_to is null or p.valid_to > ${today}::date)`;
const validTileOn = (today: string) => sql`(t.valid_to is null or t.valid_to > ${today}::date)`;

type ResolvedScope = { subdivisionId: string; tileId: string | undefined; inScope: SQL };

/**
 * The subdivision of the scope and the condition on `places p` joined with `geo_objects g` of the scope: the place's
 * geo object belongs to the subdivision (and, for a tile scope, the place lies in that tile); null for an unknown
 * subdivision.
 */
async function resolveScope(db: Db, scope: QualityScope): Promise<ResolvedScope | null> {
  const sub = await subdivisionByKey(db, scope.subdivisionKey);
  if (!sub) return null;
  const inScope = scope.tileId
    ? sql`g.subdivision_id = ${sub.id} and p.tile_id = ${scope.tileId}`
    : sql`g.subdivision_id = ${sub.id}`;
  return { subdivisionId: sub.id, tileId: scope.tileId, inScope };
}

/**
 * The places in scope: confirmed, valid on `today`, of the subdivision (in the tile, for a tile scope). A subdivision
 * counts the places of its ended tiles too (`placesPerTileMetric` lists them under `endedTiles`, ruling M7-D-R3).
 */
async function placesInScope(db: Db, s: ResolvedScope, today: string): Promise<Array<{ placeId: string; geoObjectId: string }>> {
  const { rows } = await db.execute<{ place_id: string; geo_object_id: string }>(sql`
    select p.id as place_id, p.geo_object_id from places p join geo_objects g on g.id = p.geo_object_id
    where ${s.inScope} and p.status = 'confirmed' and ${validPlaceOn(today)}
    order by p.id
  `);
  return rows.map((r) => ({ placeId: r.place_id, geoObjectId: r.geo_object_id }));
}

/**
 * Abdeckung (spec 10): the share of the comparison set's places that are confirmed and valid. A member counts for the
 * subdivision only while its geo object belongs to it (and, for a tile scope, the place lies in that tile; ruling M7-C-R1).
 * `details { set, confirmed }`; an empty set is null.
 */
export async function coverageMetric(db: Db, scope: QualityScope, opts: { today?: string } = {}): Promise<MetricResult> {
  const s = await resolveScope(db, scope);
  if (!s) return { metric: "coverage", value: null, details: { set: 0, confirmed: 0 } };
  const { rows } = await db.execute<{ set: number; confirmed: number }>(sql`
    select count(*)::int as set, count(*) filter (where p.status = 'confirmed' and ${validPlaceOn(opts.today ?? utcToday())})::int as confirmed
    from comparison_set cs join places p on p.id = cs.place_id join geo_objects g on g.id = p.geo_object_id
    where cs.subdivision_id = ${s.subdivisionId} and ${s.inScope}
  `);
  const set = Number(rows[0]!.set);
  const confirmed = Number(rows[0]!.confirmed);
  return { metric: "coverage", value: share(confirmed, set), details: { set, confirmed } };
}

/*
 * Text counts for a place as consolidation counts it (ruling M7-C-R2): mentions, facts and route stops of the place's
 * object and of every object merged into it (`mergedChainsSql`), from sources that are neither rejected nor ended on
 * `today` (`countingSourceSql`, aliases `documents d`, `sources s`).
 */

/**
 * Mehrbefund (spec 10): the share of places in scope with mentions from documents of at least two different sources.
 * `details { places, multi, multiDocument }`; `multiDocument` counts places with mentions from at least two documents,
 * the datendienst definition the acceptance uses (ruling M7-P12, metric `multi_document`).
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

/**
 * Mehrbefund as the datendienst defines it („mindestens 2 Dokumenten“, the acceptance metric, ruling M7-P12): the share
 * of places in scope with mentions from at least two documents (counted like `multiSourceMetric`).
 * `details { places, multiDocument, multiSource }`.
 */
export async function multiDocumentMetric(db: Db, scope: QualityScope, opts: { today?: string } = {}): Promise<MetricResult> {
  const counts = await mentionCounts(db, scope, opts.today ?? utcToday());
  if (!counts) return { metric: "multi_document", value: null, details: { places: 0, multiDocument: 0, multiSource: 0 } };
  return {
    metric: "multi_document",
    value: share(counts.multiDocument, counts.places),
    details: { places: counts.places, multiDocument: counts.multiDocument, multiSource: counts.multi },
  };
}

/** Places in scope, those with mentions from ≥ 2 sources and from ≥ 2 documents; null for an unknown subdivision. */
async function mentionCounts(db: Db, scope: QualityScope, today: string) {
  const s = await resolveScope(db, scope);
  if (!s) return null;
  const { rows } = await db.execute<{ places: number; multi: number; multi_document: number }>(sql`
    with scope_places as (
      select p.id, p.geo_object_id from places p join geo_objects g on g.id = p.geo_object_id
      where ${s.inScope} and p.status = 'confirmed' and ${validPlaceOn(today)}
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
  let subjects = await loadComparisonSubjects(db, scope.subdivisionKey, { evaluationRunId: opts.evaluationRunId });
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

type FidelityCounts = { facts: number; verified: number; runs: number };

/**
 * Belegtreue (spec 10) of the text runs created in the window: the sum of `belegtreue(runId)` (verified / checked text
 * facts and route stops). A text run is one that owns an extraction run: those are exactly the runs with a stage of
 * `TEXT_RUN_STAGES` (and the model comparison) that extracted anything, and a run without one adds nothing to the sums
 * (`TEXT_RUN_STAGES` lives with the run starters, which import the queue; this module stays free of them). The value
 * spans the regular text runs only (ruling M7-D-R1); evaluation runs, i.e. candidate evaluations (`params.evaluation`)
 * and model comparisons (only comparison extraction runs), whose quote failures block that run only, not production,
 * are reported apart in `details.evaluation`. `details { facts, verified, runs, regular, evaluation }`: `facts`,
 * `verified` and `runs` are the value's (regular) counts; without regular text facts null.
 */
export async function quoteFidelityMetric(db: Db, window: MeasureWindow): Promise<MetricResult> {
  const { rows } = await db.execute<{ id: string; evaluation: boolean }>(sql`
    select r.id,
      (r.params @> '{"evaluation": true}'::jsonb
        or not exists (select 1 from extraction_runs er where er.run_id = r.id and er.purpose <> 'comparison')) as evaluation
    from runs r
    where r.created_at >= ${window.from.toISOString()}::timestamptz and r.created_at < ${window.to.toISOString()}::timestamptz
      and exists (select 1 from extraction_runs er where er.run_id = r.id)
    order by r.created_at, r.id
  `);
  const regular: FidelityCounts = { facts: 0, verified: 0, runs: 0 };
  const evaluation: FidelityCounts = { facts: 0, verified: 0, runs: 0 };
  for (const { id, evaluation: isEvaluation } of rows) {
    const b = await belegtreue(db, id);
    const part = isEvaluation ? evaluation : regular;
    part.facts += b.facts;
    part.verified += b.verified;
    part.runs++;
  }
  return {
    metric: "quote_fidelity",
    value: share(regular.verified, regular.facts),
    details: { facts: regular.facts, verified: regular.verified, runs: regular.runs, regular, evaluation },
  };
}

type SectorCounts = { withText: number; confirmed: number; corrected: number; textOnly: number };

/**
 * Schutz-Konfidenz (spec 10): the share of places in scope where every one of the 8 sectors `shelter.<Sektor>` has at
 * least one confirming or correcting text fact of the active extraction run of its (document version, object) (`activeExtractionRunIdSql`),
 * counted as consolidation counts text (merged objects, counting sources). A sector's text confirms the newest computed
 * value of the place's own object when one of its facts lies within `shelterConfirmTolerance` of it, else it corrects
 * it; without a computed value it is text only (ruling M7-C-R1) and does not count for the sector, since spec 10 asks
 * for a text that confirms or corrects (final review B M-5). `details { places, complete, confirmed, corrected,
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
  const today = opts.today ?? utcToday();
  const inScope = await placesInScope(db, s, today);
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
        and ${countingSourceSql(today)}
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
      const c = computedValue.get(`${place.geoObjectId}|shelter.${sector}`);
      bySector[sector].withText++;
      // only a text that confirms or corrects a computed value makes the sector count (spec 10, final review B M-5)
      if (c !== undefined) sectors++;
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
 * comparison, when at least one stop lies at a place (of any status) of the scope. Complete = every stop is
 * assigned to a geo object with a confirmed, valid place. A stop at an object merged into a place's object is at that
 * place (ruling M7-C-R2). `details { routes, complete, openStops, reports }` (reports: own document ids with stop
 * counts, for the pilot report); no such report → null.
 */
export async function routeReconstructionMetric(db: Db, scope: QualityScope, opts: { today?: string } = {}): Promise<MetricResult> {
  const s = await resolveScope(db, scope);
  if (!s) return { metric: "route_reconstruction", value: null, details: { routes: 0, complete: 0, openStops: 0, reports: [] } };
  const today = opts.today ?? utcToday();
  const { rows } = await db.execute<{ document_id: string; stops: number; open_stops: number }>(sql`
    with newest as (
      select distinct on (d.id) d.id as document_id, ro.id as route_id
      from documents d
      join sources s on s.id = d.source_id
      join document_versions v on v.id = d.current_version_id
      join routes ro on ro.document_version_id = v.id
      join extraction_runs er on er.id = ro.extraction_run_id
      where coalesce(v.classified_doc_type, v.doc_type) = 'trip_report' and ${countingSourceSql(today)}
        and er.task = 'extract-route' and er.status = 'finished' and er.purpose <> 'comparison'
      order by d.id, er.started_at desc, er.id desc
    ),
    known_places as (
      select p.geo_object_id, bool_or(p.status = 'confirmed') as confirmed, bool_or(${s.inScope}) as in_scope
      from places p join geo_objects g on g.id = p.geo_object_id
      where ${validPlaceOn(today)} and (p.status = 'confirmed' or ${s.inScope})
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

/*
 * Quality metrics II (spec 10 „Kosten je Ort“, „Review-Aufwand“, the extras „Anteil Orte mit Highlight-Fact“ and
 * „Anteil Orte mit Beobachtung < 18 Monate“, „Orte je Kachel, Ziel 10–40“).
 */

const round6 = (x: number) => Math.round(x * 1e6) / 1e6;
const roundValues = (m: Map<string, number>) => Object.fromEntries([...m].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => [k, round6(v)]));
const addTo = (m: Map<string, number>, key: string, eur: number) => m.set(key, (m.get(key) ?? 0) + eur);

/** The run scope id of a model comparison (`MODEL_COMPARISON_SCOPE` in `lib/pipeline/text/run.ts`, which imports the queue). */
const MODEL_COMPARISON_SCOPE_ID = "model-comparison";

/** Kinds of one-off pilot spend (ruling M7-P15), reported as „Einmalkosten Pilot“ and never in the operating cost. */
type OneOffKind = "converterComparison" | "modelComparison" | "pdfCompare" | "fixturesRecord" | "evaluation";

/**
 * Confirmed places valid on `today` per valid subdivision key (by the place's geo object, subdivisions without places are
 * missing); `keys` limits it to these subdivisions, default every valid one.
 */
async function confirmedPlacesBySubdivision(db: Db, today: string, keys?: string[]): Promise<Map<string, number>> {
  if (keys && keys.length === 0) return new Map();
  const { rows } = await db.execute<{ key: string; n: number }>(sql`
    select s.key, count(*)::int as n
    from subdivisions s join geo_objects g on g.subdivision_id = s.id join places p on p.geo_object_id = g.id
    where s.valid_to is null
      ${keys ? sql`and s.key in (select value from jsonb_array_elements_text(${JSON.stringify(keys)}::jsonb))` : sql``}
      and p.status = 'confirmed' and ${validPlaceOn(today)}
    group by s.key
  `);
  return new Map(rows.map((r) => [r.key, Number(r.n)]));
}

/**
 * Kosten je Ort (spec 10, ruling M7-P15): the operating spend of the window (`external_calls.at`, `from` inclusive,
 * `to` exclusive) for the scope, per confirmed place in scope. A call belongs to a tile (its `tile_id`, else its run's
 * tile, else the tile of its run's place), to a subdivision (a run scoped to the subdivision, without tile), or to nobody: shared
 * spend (source, system and text runs, calls without run). The scope's cost is its direct spend (calls of its tiles;
 * for a subdivision also its own calls), plus for a tile the tile's place share of its subdivision's own calls, plus the
 * scope's share of the shared spend by confirmed places among all valid subdivisions (`opts.subdivisionKeys`, default
 * all). One-off pilot spend (converter and model comparison, `pdf:compare`, `fixtures:record`,
 * candidate evaluations) counts nowhere and is listed in `details.oneOff`. `details { costEur, directEur, sharedEur,
 * places, byStage, byService, oneOff }`; no confirmed places → null.
 */
export async function costPerPlaceMetric(
  db: Db,
  scope: QualityScope,
  window: MeasureWindow,
  opts: { subdivisionKeys?: string[]; today?: string } = {},
): Promise<MetricResult> {
  const today = opts.today ?? utcToday();
  const s = await resolveScope(db, scope);
  const placesCount = s ? (await placesInScope(db, s, today)).length : 0;
  const { rows } = await db.execute<{
    eur: number;
    stage: string;
    service: string;
    tile_id: string | null;
    tile_subdivision_id: string | null;
    subdivision_key: string | null;
    one_off: OneOffKind | null;
  }>(sql`
    with calls as (
      select c.cost_eur::float8 as eur, coalesce(c.stage, '') as stage, c.service,
        coalesce(c.tile_id, case when r.scope_type = 'tile' then r.scope_id end, rp.tile_id) as tile_id,
        case when c.tile_id is null and r.scope_type = 'subdivision' then r.scope_id end as subdivision_key,
        case
          when c.stage = 'fixtures:record' then 'fixturesRecord'
          when c.stage like 'pdf:compare%' then 'pdfCompare'
          when r.scope_type = 'system' and r.scope_id = ${MODEL_COMPARISON_SCOPE_ID} then 'modelComparison'
          when c.stage = 'compare.converters' or 'compare.converters' = any(r.stages) then 'converterComparison'
          when r.params @> '{"evaluation": true}'::jsonb then 'evaluation'
        end as one_off
      from external_calls c
      left join runs r on r.id = c.run_id
      left join places rp on r.scope_type = 'place' and rp.id::text = r.scope_id
      where c.at >= ${window.from.toISOString()}::timestamptz and c.at < ${window.to.toISOString()}::timestamptz
    )
    select sum(c.eur)::float8 as eur, c.stage, c.service, c.tile_id, t.subdivision_id as tile_subdivision_id, c.subdivision_key, c.one_off
    from calls c left join tiles t on t.id = c.tile_id
    group by c.stage, c.service, c.tile_id, t.subdivision_id, c.subdivision_key, c.one_off
    order by c.stage, c.service, c.tile_id, c.subdivision_key, c.one_off
  `);

  const keys = opts.subdivisionKeys ? [...new Set([...opts.subdivisionKeys, scope.subdivisionKey])] : undefined;
  const bySubdivision = await confirmedPlacesBySubdivision(db, today, keys);
  const allPlaces = [...bySubdivision.values()].reduce((n, x) => n + x, 0);
  const subdivisionPlaces = bySubdivision.get(scope.subdivisionKey) ?? 0;
  const sharedWeight = allPlaces === 0 ? 0 : placesCount / allPlaces;
  const subdivisionWeight = !scope.tileId ? 1 : subdivisionPlaces === 0 ? 0 : placesCount / subdivisionPlaces;

  let directEur = 0;
  let sharedEur = 0;
  const byStage = new Map<string, number>();
  const byService = new Map<string, number>();
  const oneOff = new Map<OneOffKind, number>();
  for (const r of rows) {
    const eur = Number(r.eur);
    if (r.one_off) {
      addTo(oneOff, r.one_off, eur);
      continue;
    }
    let part = 0;
    if (r.tile_id !== null) {
      const own = scope.tileId ? r.tile_id === scope.tileId : s !== null && r.tile_subdivision_id === s.subdivisionId;
      if (own) directEur += part = eur;
    } else if (r.subdivision_key !== null) {
      if (r.subdivision_key === scope.subdivisionKey) {
        part = eur * subdivisionWeight;
        if (scope.tileId) sharedEur += part;
        else directEur += part;
      }
    } else {
      sharedEur += part = eur * sharedWeight;
    }
    if (part === 0) continue;
    addTo(byStage, r.stage, part);
    addTo(byService, r.service, part);
  }
  const costEur = directEur + sharedEur;
  return {
    metric: "cost_per_place",
    value: placesCount === 0 ? null : round6(costEur / placesCount),
    details: {
      costEur: round6(costEur),
      directEur: round6(directEur),
      sharedEur: round6(sharedEur),
      places: placesCount,
      byStage: roundValues(byStage),
      byService: roundValues(byService),
      oneOff: { eur: round6([...oneOff.values()].reduce((n, x) => n + x, 0)), byKind: roundValues(oneOff) },
    },
  };
}

type EffortGroup = { tasks: number; decided: number; minutes: number; counted: boolean };

/**
 * Subject types of tasks that are no review work (ruling M7-D-R3): a removed profile entry (ruling M7-P14) and the admin
 * actions that write a task decided on creation (place merge, position and anchor correction, header status change, kind switch by evidence). Reported in `byKind`
 * under their subject type, never counted.
 */
export const PSEUDO_TASK_SUBJECT_TYPES: ReadonlySet<string> = new Set([
  "profile_entry",
  "place_merge",
  "place_position",
  "place_anchor",
  "place_status",
  "place_kind",
]);

/**
 * Review-Aufwand (spec 10, ruling M7-P14) over the review tasks created in the window (all subdivisions): each decision
 * counts `min(duration_ms, reviewDurationCapMinutes)`, a decision without a duration counts 0 (reported). Pseudo-tasks
 * (`PSEUDO_TASK_SUBJECT_TYPES`, keyed by subject type) and comparison deviations (quality control) are not counted and
 * appear apart in `byKind` with `counted: false`. Returns `review_minutes` (`details { tasks, decided, open, withoutDuration, capped,
 * byKind }`) and `review_minutes_per_100` = minutes per 100 confirmed places of the valid subdivisions (`opts.subdivisionKeys`,
 * default all; `details { minutes, places }`, no places → null).
 */
export async function reviewEffortMetrics(
  db: Db,
  window: MeasureWindow,
  cfg: QualityConfig,
  opts: { subdivisionKeys?: string[]; today?: string } = {},
): Promise<[MetricResult, MetricResult]> {
  const { rows } = await db.execute<{ id: string; kind: string; subject_type: string; status: string; duration_ms: number | null; decision_id: string | null }>(sql`
    select t.id, t.kind::text as kind, t.subject_type, t.status::text as status, d.duration_ms, d.id as decision_id
    from review_tasks t left join review_decisions d on d.task_id = t.id
    where t.created_at >= ${window.from.toISOString()}::timestamptz and t.created_at < ${window.to.toISOString()}::timestamptz
    order by t.id, d.id
  `);
  const capMs = cfg.reviewDurationCapMinutes * 60_000;
  const byKind = new Map<string, EffortGroup>();
  const seen = new Set<string>();
  let tasks = 0;
  let decided = 0;
  let open = 0;
  let withoutDuration = 0;
  let capped = 0;
  let ms = 0;
  for (const r of rows) {
    const pseudo = PSEUDO_TASK_SUBJECT_TYPES.has(r.subject_type);
    const key = pseudo ? r.subject_type : r.kind;
    const counted = !pseudo && r.kind !== "comparison_deviation";
    const group = byKind.get(key) ?? { tasks: 0, decided: 0, minutes: 0, counted };
    byKind.set(key, group);
    if (!seen.has(r.id)) {
      seen.add(r.id);
      group.tasks++;
      if (r.status === "decided") group.decided++;
      if (counted) {
        tasks++;
        if (r.status === "decided") decided++;
        if (r.status === "open") open++;
      }
    }
    if (r.decision_id === null) continue;
    const duration = r.duration_ms === null ? 0 : Math.min(Number(r.duration_ms), capMs);
    group.minutes += duration / 60_000;
    if (!counted) continue;
    if (r.duration_ms === null) withoutDuration++;
    else if (Number(r.duration_ms) > capMs) capped++;
    ms += duration;
  }
  const minutes = round6(ms / 60_000);
  const bySubdivision = await confirmedPlacesBySubdivision(db, opts.today ?? utcToday(), opts.subdivisionKeys);
  const places = [...bySubdivision.values()].reduce((n, x) => n + x, 0);
  const kinds = Object.fromEntries(
    [...byKind].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, g]) => [k, { ...g, minutes: round6(g.minutes) }]),
  );
  return [
    { metric: "review_minutes", value: minutes, details: { tasks, decided, open, withoutDuration, capped, byKind: kinds } },
    { metric: "review_minutes_per_100", value: places === 0 ? null : round6((minutes / places) * 100), details: { minutes, places } },
  ];
}

/** The newest profile attributes and provenance of each place in scope (no profile → none). */
async function scopeProfiles(db: Db, scope: QualityScope, today: string) {
  const s = await resolveScope(db, scope);
  const inScope = s ? await placesInScope(db, s, today) : [];
  const profiles = await latestProfiles(db, inScope.map((p) => p.geoObjectId));
  return { places: inScope.length, profiles: inScope.flatMap((p) => profiles.get(p.geoObjectId) ?? []) };
}

/**
 * „Anteil Orte mit Highlight-Fact“: the share of places in scope whose newest profile has a `highlight.<category>`
 * with `present = true`. `details { places, withHighlight }`; no places → null.
 */
export async function highlightShareMetric(db: Db, scope: QualityScope, opts: { today?: string } = {}): Promise<MetricResult> {
  const { places: n, profiles } = await scopeProfiles(db, scope, opts.today ?? utcToday());
  const withHighlight = profiles.filter((p) =>
    Object.entries(p.attributes).some(
      ([k, v]) => k.startsWith("highlight.") && typeof v === "object" && v !== null && (v as { present?: unknown }).present === true,
    ),
  ).length;
  return { metric: "highlight_share", value: share(withHighlight, n), details: { places: n, withHighlight } };
}

/** `today` (`YYYY-MM-DD`) minus `months` calendar months, the day clamped to the month's length. */
export function monthsBefore(today: string, months: number): string {
  const [y, m, d] = today.split("-").map(Number) as [number, number, number];
  const first = new Date(Date.UTC(y, m - 1 - months, 1));
  const lastDay = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  return new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), Math.min(d, lastDay))).toISOString().slice(0, 10);
}

const OBSERVATION_ORIGINS: ReadonlySet<string> = new Set(["text", "observed", "review"]);

/**
 * „Anteil Orte mit Beobachtung < 18 Monate“: the share of places in scope whose newest profile has an attribute from an
 * observation (origin `text`, `observed` or `review`) younger than `months`: `observedAt` after `today` minus `months`
 * (strictly, spec 10 „< 18 Monate“; ruling M7-D-R3).
 * `details { places, recent, since }`; no places → null.
 */
export async function recentObservationShareMetric(
  db: Db,
  scope: QualityScope,
  opts: { today: string; months: number },
): Promise<MetricResult> {
  const since = monthsBefore(opts.today, opts.months);
  const { places: n, profiles } = await scopeProfiles(db, scope, opts.today);
  const recent = profiles.filter((p) =>
    Object.values(p.provenance).some((e) => OBSERVATION_ORIGINS.has(e.origin) && e.observedAt !== null && e.observedAt.slice(0, 10) > since),
  ).length;
  return { metric: "recent_observation_share", value: share(recent, n), details: { places: n, recent, since } };
}

/**
 * „Orte je Kachel, Ziel 10–40“: confirmed places valid on `today` per coast tile labelled with the subdivision
 * (`tiles.subdivision_id`, the label for tile metrics, spec 14) and valid on `today`; the value is the median.
 * `details { tiles, min, max, median, inTarget, outsideTarget, target, endedTiles }` (`inTarget`: tiles within the
 * target range; `endedTiles`: tiles of the subdivision ended by `today` that still hold confirmed, valid places,
 * which the subdivision's metrics count but no tile row shows, ruling M7-D-R3); no coast tiles → null.
 */
export async function placesPerTileMetric(db: Db, subdivisionKey: string, cfg: QualityConfig, opts: { today?: string } = {}): Promise<MetricResult> {
  const today = opts.today ?? utcToday();
  const target = { min: cfg.placesPerTile.min, max: cfg.placesPerTile.max };
  const sub = await subdivisionByKey(db, subdivisionKey);
  const { rows } = sub
    ? await db.execute<{ tile_id: string; places: number; valid: boolean }>(sql`
        select t.id as tile_id, count(p.id) filter (where p.status = 'confirmed' and ${validPlaceOn(today)})::int as places,
          ${validTileOn(today)} as valid
        from tiles t left join places p on p.tile_id = t.id
        where t.subdivision_id = ${sub.id} and (t.has_coast or not ${validTileOn(today)})
        group by t.id order by t.id
      `)
    : { rows: [] };
  const tiles = rows.filter((r) => r.valid).map((r) => ({ tileId: r.tile_id, places: Number(r.places) }));
  const endedTiles = rows.filter((r) => !r.valid && Number(r.places) > 0).map((r) => ({ tileId: r.tile_id, places: Number(r.places) }));
  if (tiles.length === 0) {
    return {
      metric: "places_per_tile",
      value: null,
      details: { tiles, min: null, max: null, median: null, inTarget: 0, outsideTarget: [], target, endedTiles },
    };
  }
  const counts = tiles.map((t) => t.places).sort((a, b) => a - b);
  const mid = Math.floor(counts.length / 2);
  const median = counts.length % 2 === 1 ? counts[mid]! : (counts[mid - 1]! + counts[mid]!) / 2;
  const outsideTarget = tiles.filter((t) => t.places < target.min || t.places > target.max).map((t) => t.tileId);
  return {
    metric: "places_per_tile",
    value: median,
    details: {
      tiles,
      min: counts[0]!,
      max: counts[counts.length - 1]!,
      median,
      inTarget: tiles.length - outsideTarget.length,
      outsideTarget,
      target,
      endedTiles,
    },
  };
}

/*
 * Place metrics (specs 15 and 17): how the automatic confirmation, the websites and the marina services come out for a
 * subdivision. Counts only, no values of any reference (Grundprinzip 9).
 */

type PlaceRow = { place_id: string; geo_object_id: string; kind: string; status: string };

/** The places of the scope of one of `statuses` valid on `today`, with the facts the metrics below ask about. */
async function scopePlaces(db: Db, s: ResolvedScope, today: string, statuses: string[]): Promise<PlaceRow[]> {
  const { rows } = await db.execute<PlaceRow>(sql`
    select p.id as place_id, p.geo_object_id, p.kind::text as kind, p.status::text as status
    from places p join geo_objects g on g.id = p.geo_object_id
    where ${s.inScope} and p.status::text in (select value from jsonb_array_elements_text(${JSON.stringify(statuses)}::jsonb))
      and ${validPlaceOn(today)}
    order by p.id
  `);
  return rows;
}

/**
 * Bestätigung (spec 17): the share of the confirmed places of the scope that the system confirmed (a decided
 * `place_status` task with a `confirm` decision by `system`). `details { candidates, autoConfirmed, manualConfirmed,
 * withoutEvidence, kindChanged, deliveredByKind }`: `withoutEvidence` are candidates without a fact of a berth attribute
 * and without a route stop (nothing to confirm them on); `kindChanged` the places whose kind the system switched;
 * `deliveredByKind` the places of a delivered status (`delivery.spots.statuses`: confirmed and no_anchoring, final
 * review 7) per kind by the `berthable` the delivery gives them (the profile's value, else the derivation of spec 17):
 * yes, no or unknown. No confirmed place → null.
 */
export async function placeConfirmationMetric(db: Db, scope: QualityScope, opts: { today?: string; cfg?: AppConfig } = {}): Promise<MetricResult> {
  const empty = { candidates: 0, autoConfirmed: 0, manualConfirmed: 0, withoutEvidence: 0, kindChanged: 0, deliveredByKind: {} };
  const s = await resolveScope(db, scope);
  if (!s) return { metric: "place_confirmation", value: null, details: empty };
  const today = opts.today ?? utcToday();
  const cfg = opts.cfg ?? getConfig();
  const placeRows = await scopePlaces(db, s, today, ["candidate", "confirmed"]);
  const confirmed = placeRows.filter((p) => p.status === "confirmed");
  const candidates = placeRows.filter((p) => p.status === "candidate");
  const ids = (rows: PlaceRow[]) => JSON.stringify(rows.map((p) => p.place_id));

  const system = async (rows: PlaceRow[], subjectType: string, action?: string) => {
    if (rows.length === 0) return new Set<string>();
    const { rows: found } = await db.execute<{ id: string }>(sql`
      select distinct t.subject_id as id
      from review_tasks t join review_decisions d on d.task_id = t.id
      where t.kind = 'place_candidate' and t.subject_type = ${subjectType} and d.decided_by = 'system'
        ${action ? sql`and d.decision->>'action' = ${action}` : sql``}
        and t.subject_id in (select value from jsonb_array_elements_text(${ids(rows)}::jsonb))
    `);
    return new Set(found.map((r) => r.id));
  };
  const auto = await system(confirmed, "place_status", "confirm");
  const kindChanged = await system(placeRows, "place_kind", "set_kind");

  const patterns = cfg.delivery.confirmation.berthAttributes.map((a) => (a.endsWith(".*") ? `${a.slice(0, -1)}%` : a));
  let withoutEvidence = 0;
  if (candidates.length > 0) {
    const { rows } = await db.execute<{ n: number }>(sql`
      select count(*)::int as n
      from places p
      where p.id in (select value::uuid from jsonb_array_elements_text(${ids(candidates)}::jsonb))
        and not exists (select 1 from facts f where f.geo_object_id = p.geo_object_id
                        and f.attribute like any (select value from jsonb_array_elements_text(${JSON.stringify(patterns)}::jsonb)))
        and not exists (select 1 from route_stops rs where rs.geo_object_id = p.geo_object_id)
    `);
    withoutEvidence = Number(rows[0]!.n);
  }

  const delivered = await scopePlaces(db, s, today, cfg.delivery.spots.statuses);
  const profiles = await latestProfiles(db, delivered.map((p) => p.geo_object_id));
  const deliveredByKind: Record<string, { yes: number; no: number; unknown: number }> = {};
  for (const p of delivered) {
    const fact = (profiles.get(p.geo_object_id)?.attributes as Record<string, unknown> | undefined)?.["berthable"];
    const berthable = typeof fact === "boolean" ? fact : derivedBerthable(p.kind, p.status);
    const entry = (deliveredByKind[p.kind] ??= { yes: 0, no: 0, unknown: 0 });
    entry[berthable === true ? "yes" : berthable === false ? "no" : "unknown"]++;
  }
  const sortedKinds = Object.fromEntries(Object.entries(deliveredByKind).sort(([a], [b]) => (a < b ? -1 : 1)));
  return {
    metric: "place_confirmation",
    value: share(auto.size, confirmed.length),
    details: {
      candidates: candidates.length,
      autoConfirmed: auto.size,
      manualConfirmed: confirmed.length - auto.size,
      withoutEvidence,
      kindChanged: kindChanged.size,
      deliveredByKind: sortedKinds,
    },
  };
}

/**
 * Websites (spec 15 C): the share of the marinas and ports (candidate or confirmed) of the scope with a website (their
 * newest `place_websites` row). `details { withWebsite, bySource { osm, wikidata, serp }, fetched }`: `fetched` counts
 * those whose website is a bound start URL (a source) with at least one document version. No marina or port → null.
 */
export async function placeWebsitesMetric(db: Db, scope: QualityScope, opts: { today?: string } = {}): Promise<MetricResult> {
  const bySource = { osm: 0, wikidata: 0, serp: 0 };
  const s = await resolveScope(db, scope);
  if (!s) return { metric: "place_websites", value: null, details: { withWebsite: 0, bySource, fetched: 0 } };
  const { rows } = await db.execute<{ origin: keyof typeof bySource | null; fetched: boolean | null }>(sql`
    with scope_places as (
      select p.id from places p join geo_objects g on g.id = p.geo_object_id
      where ${s.inScope} and p.status in ('candidate', 'confirmed') and p.kind in ('marina', 'port') and ${validPlaceOn(opts.today ?? utcToday())}
    ),
    current_site as (
      select distinct on (w.place_id) w.place_id, w.origin::text as origin, w.bound, w.source_id
      from place_websites w where w.place_id in (select id from scope_places)
      order by w.place_id, w.created_at desc, w.id desc
    )
    select cs.origin,
      (cs.bound and cs.source_id is not null and exists (
        select 1 from documents d join document_versions v on v.document_id = d.id where d.source_id = cs.source_id
      )) as fetched
    from current_site cs
  `);
  const total = await db.execute<{ n: number }>(sql`
    select count(*)::int as n from places p join geo_objects g on g.id = p.geo_object_id
    where ${s.inScope} and p.status in ('candidate', 'confirmed') and p.kind in ('marina', 'port') and ${validPlaceOn(opts.today ?? utcToday())}
  `);
  for (const r of rows) if (r.origin) bySource[r.origin]++;
  return {
    metric: "place_websites",
    value: share(rows.length, Number(total.rows[0]!.n)),
    details: { withWebsite: rows.length, bySource, fetched: rows.filter((r) => r.fetched === true).length },
  };
}

/**
 * Marina services (spec 15): the share of the confirmed marinas of the scope whose profile has a `services.fuel` and a
 * `services.water` value. `details { fuel, water, fromWebsite }`: marinas with either value, and marinas whose value rests on a
 * fact of a page of their own website (a source bound to the place). No confirmed marina → null.
 */
export async function marinaServicesMetric(db: Db, scope: QualityScope, opts: { today?: string } = {}): Promise<MetricResult> {
  const s = await resolveScope(db, scope);
  if (!s) return { metric: "marina_services", value: null, details: { fuel: 0, water: 0, fromWebsite: 0 } };
  const marinas = (await scopePlaces(db, s, opts.today ?? utcToday(), ["confirmed"])).filter((p) => p.kind === "marina");
  const profiles = await latestProfiles(db, marinas.map((p) => p.geo_object_id));
  const attrs = ["services.fuel", "services.water"] as const;
  const has = (p: PlaceRow, key: string) => {
    const v = (profiles.get(p.geo_object_id)?.attributes as Record<string, unknown> | undefined)?.[key];
    return v !== undefined && v !== null;
  };
  let fuel = 0;
  let water = 0;
  let both = 0;
  const candidatesForWebsite: Array<{ placeId: string; factIds: string[] }> = [];
  for (const p of marinas) {
    const f = has(p, attrs[0]);
    const w = has(p, attrs[1]);
    if (f) fuel++;
    if (w) water++;
    if (f && w) both++;
    const provenance = (profiles.get(p.geo_object_id)?.provenance ?? {}) as Record<string, { factIds?: string[] }>;
    const factIds = attrs.filter((a) => has(p, a)).flatMap((a) => provenance[a]?.factIds ?? []);
    if (factIds.length > 0) candidatesForWebsite.push({ placeId: p.place_id, factIds });
  }
  let fromWebsite = 0;
  if (candidatesForWebsite.length > 0) {
    const { rows } = await db.execute<{ n: number }>(sql`
      select count(distinct c.place_id)::int as n
      from jsonb_to_recordset(${JSON.stringify(candidatesForWebsite.flatMap((c) => c.factIds.map((factId) => ({ place_id: c.placeId, fact_id: factId }))))}::jsonb)
        as c(place_id uuid, fact_id uuid)
      join facts f on f.id = c.fact_id
      join mentions m on m.id = f.mention_id
      join document_versions v on v.id = m.document_version_id
      join documents d on d.id = v.document_id
      where exists (select 1 from place_websites w where w.place_id = c.place_id and w.bound and w.source_id = d.source_id)
    `);
    fromWebsite = Number(rows[0]!.n);
  }
  return { metric: "marina_services", value: share(both, marinas.length), details: { fuel, water, fromWebsite } };
}
