import { sql } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import { displayNameSql } from "@/lib/domain/gazetteer/names";
import { hasCoreImagery, imageCoverage, type ImageCoverage } from "@/lib/domain/images/view";
import { SUBDIVISION_BUILD_STAGES } from "@/lib/pipeline/subdivision-build";
import { countryName } from "./country-name";

/*
 * The admin view „Länder und Landesteile“ (spec 14 „Admin-UI“): every valid subdivision grouped by country, with its
 * status, its coast tiles (labelled with it) and how many of them a run processed, its last run and the costs of its
 * runs. A country that is one subdivision as a whole (`wholeCountry`, the subdivision's object is the country) is one
 * row without children. Single runs count (N7 4.5, B11): a run of any kind with the subdivision as scope makes it
 * `läuft`, and a build stage finished in such a run makes it `teilweise` until a build as a whole finished.
 */

export const SUBDIVISION_STATUSES = ["nicht begonnen", "teilweise", "läuft", "aufgebaut", "fehlgeschlagen", "ausgeschlossen"] as const;
export type SubdivisionStatus = (typeof SUBDIVISION_STATUSES)[number];

/**
 * The status of a subdivision: `ausgeschlossen` by configuration; `läuft` while any run with it as scope is queued or
 * running (a build, a single stage, a research run); `fehlgeschlagen` when its latest build (run of kind `full`)
 * failed (also one an admin ended); `aufgebaut` once a build finished (`built_at`); `teilweise` when no build
 * finished but a stage of `SUBDIVISION_BUILD_STAGES` did, in any run with it as scope; otherwise `nicht begonnen`.
 */
export function subdivisionStatus(s: {
  excluded: boolean;
  builtAt: Date | string | null;
  latestBuild: { status: "queued" | "running" | "finished" | "failed" } | null;
  /** A run of any kind with the subdivision as scope is queued or running. */
  activeRun: boolean;
  /** A stage of the build finished in a run with the subdivision as scope. */
  partial: boolean;
}): SubdivisionStatus {
  if (s.excluded) return "ausgeschlossen";
  if (s.activeRun || s.latestBuild?.status === "queued" || s.latestBuild?.status === "running") return "läuft";
  if (s.latestBuild?.status === "failed") return "fehlgeschlagen";
  if (s.builtAt !== null) return "aufgebaut";
  if (s.partial) return "teilweise";
  return "nicht begonnen";
}

export type SubdivisionRow = {
  key: string;
  publicId: string;
  name: string;
  status: SubdivisionStatus;
  statusReason: string | null;
  coastTiles: number;
  processedTiles: number;
  lastRunAt: string | null;
  costEur: number;
  queued: boolean;
};

export type CountrySummary = { total: number; built: number; partial: number; running: number; failed: number; excluded: number };

export type CountryNode = {
  country: string;
  name: string;
  whole: boolean;
  summary: CountrySummary;
  /** A subdivision of the country is begun (`läuft`, `teilweise`, `aufgebaut` or `fehlgeschlagen`), so the list opens it. */
  expanded: boolean;
  subdivisions: SubdivisionRow[];
};

export { countryName };

type Row = {
  key: string;
  public_id: string;
  country: string;
  name: string | null;
  whole: boolean;
  status: "active" | "excluded";
  status_reason: string | null;
  built_at: string | Date | null;
  queued_at: string | Date | null;
  build_status: "queued" | "running" | "finished" | "failed" | null;
  active_run: boolean;
  partial: boolean;
  coast_tiles: number;
  processed_tiles: number;
  last_run_at: string | Date | null;
  cost_eur: string | number;
};

/** The build stages as an SQL list, for `in (…)`. */
const buildStagesSql = sql.join(SUBDIVISION_BUILD_STAGES.map((stage) => sql`${stage}`), sql`, `);

const subdivisionRowsSql = (where: ReturnType<typeof sql>) => sql`
  select s.key, s.public_id, s.country, ${displayNameSql(sql`s.geo_object_id`)} as name,
         (o.type = 'country') as whole, s.status, s.status_reason, s.built_at, s.queued_at,
         (select r.status from runs r where r.kind = 'full' and r.scope_type = 'subdivision' and r.scope_id = s.key
          order by r.created_at desc limit 1) as build_status,
         exists (select 1 from runs r
                 where r.scope_type = 'subdivision' and r.scope_id = s.key and r.status in ('queued', 'running')) as active_run,
         exists (select 1 from run_stages rs join runs r on r.id = rs.run_id
                 where r.scope_type = 'subdivision' and r.scope_id = s.key and rs.status = 'finished'
                   and rs.stage in (${buildStagesSql})) as partial,
         (select count(*)::int from tiles t where t.subdivision_id = s.id and t.has_coast and t.valid_to is null) as coast_tiles,
         (select count(*)::int from tiles t
          where t.subdivision_id = s.id and t.has_coast and t.valid_to is null and t.last_run_at is not null) as processed_tiles,
         (select max(r.created_at) from runs r where r.scope_type = 'subdivision' and r.scope_id = s.key) as last_run_at,
         (select coalesce(sum(e.cost_eur), 0) from external_calls e
          where e.run_id in (select r.id from runs r where r.scope_type = 'subdivision' and r.scope_id = s.key)) as cost_eur
  from subdivisions s
  join geo_objects o on o.id = s.geo_object_id
  where s.valid_to is null and ${where}
`;

function toRow(r: Row): { country: string; whole: boolean; row: SubdivisionRow } {
  return { country: r.country, whole: r.whole, row: subdivisionRow(r) };
}

function subdivisionRow(r: Row): SubdivisionRow {
  return {
    key: r.key,
    publicId: r.public_id,
    name: r.name ?? r.key,
    status: subdivisionStatus({
      excluded: r.status === "excluded",
      builtAt: r.built_at,
      latestBuild: r.build_status ? { status: r.build_status } : null,
      activeRun: r.active_run,
      partial: r.partial,
    }),
    statusReason: r.status_reason,
    coastTiles: Number(r.coast_tiles),
    processedTiles: Number(r.processed_tiles),
    lastRunAt: r.last_run_at === null ? null : new Date(r.last_run_at).toISOString(),
    costEur: Number(r.cost_eur),
    queued: r.queued_at !== null,
  };
}

/** Every valid subdivision grouped by country (German country names, sorted), subdivisions sorted by name. */
export async function subdivisionTree(db: Db): Promise<CountryNode[]> {
  const { rows } = await db.execute<Row>(subdivisionRowsSql(sql`true`));
  const byCountry = new Map<string, Array<ReturnType<typeof toRow>>>();
  for (const r of rows.map(toRow)) byCountry.set(r.country, [...(byCountry.get(r.country) ?? []), r]);
  const collator = new Intl.Collator("de");
  return [...byCountry]
    .map(([country, items]) => {
      const subdivisions = items
        .map((i) => i.row)
        .sort((a, b) => collator.compare(a.name, b.name) || collator.compare(a.key, b.key));
      const count = (status: SubdivisionStatus) => subdivisions.filter((s) => s.status === status).length;
      return {
        country,
        name: countryName(country),
        whole: items.length === 1 && items[0]!.whole,
        summary: {
          total: subdivisions.length,
          built: count("aufgebaut"),
          partial: count("teilweise"),
          running: count("läuft"),
          failed: count("fehlgeschlagen"),
          excluded: count("ausgeschlossen"),
        },
        expanded: subdivisions.some((s) => BEGUN_STATUSES.includes(s.status)),
        subdivisions,
      };
    })
    .sort((a, b) => collator.compare(a.name, b.name));
}

/** The statuses of a begun subdivision; a country with one is shown expanded (B11). */
const BEGUN_STATUSES: readonly SubdivisionStatus[] = ["läuft", "teilweise", "aufgebaut", "fehlgeschlagen"];

/** The short German summary of a country, e.g. „3 von 13 aufgebaut, 2 teilweise, 1 läuft“. */
export function countrySummaryText(s: CountrySummary): string {
  const open = s.total - s.excluded;
  const parts = [`${s.built} von ${open} aufgebaut`];
  if (s.partial > 0) parts.push(`${s.partial} teilweise`);
  if (s.running > 0) parts.push(`${s.running} läuft`);
  if (s.failed > 0) parts.push(`${s.failed} fehlgeschlagen`);
  if (s.excluded > 0) parts.push(`${s.excluded} ausgeschlossen`);
  return parts.join(", ");
}

export type StageHistoryEntry = {
  stage: string;
  /** When the run ended; null while it still goes on (a later stage of it runs). */
  finishedAt: string | null;
  runId: string;
  runStatus: string;
};

/**
 * Which stages ran for a subdivision (N7 4.5, B11): per stage the youngest run with the subdivision as scope in which
 * the stage finished, with the run's end. Build stages first in build order, then other stages (research …) by name.
 */
export async function subdivisionStageHistory(db: Db, key: string): Promise<StageHistoryEntry[]> {
  const { rows } = await db.execute<{ stage: string; run_id: string; run_status: string; finished_at: string | Date | null }>(sql`
    select distinct on (rs.stage) rs.stage, r.id as run_id, r.status as run_status, r.finished_at
    from run_stages rs join runs r on r.id = rs.run_id
    where r.scope_type = 'subdivision' and r.scope_id = ${key} and rs.status = 'finished'
    order by rs.stage, r.created_at desc
  `);
  const order = (stage: string) => {
    const i = (SUBDIVISION_BUILD_STAGES as readonly string[]).indexOf(stage);
    return i === -1 ? SUBDIVISION_BUILD_STAGES.length : i;
  };
  return rows
    .map((r) => ({
      stage: r.stage,
      finishedAt: r.finished_at === null ? null : new Date(r.finished_at).toISOString(),
      runId: r.run_id,
      runStatus: r.run_status,
    }))
    .sort((a, b) => order(a.stage) - order(b.stage) || a.stage.localeCompare(b.stage));
}

export type SubdivisionDetail = SubdivisionRow & {
  country: string;
  countryName: string;
  whole: boolean;
  tiles: Array<{ id: string; lastRunAt: string | null; label: boolean }>;
  areas: Array<{ id: string; publicId: string | null; key: string | null; members: number; name: string }>;
  counts: { confirmedPlaces: number; candidates: number; geoObjects: number };
  runs: Array<{ id: string; kind: string; status: string; stages: string[]; createdAt: string; triggeredBy: string }>;
  /** Title image coverage of its spots (spec 13). */
  images: ImageCoverage;
  /** Its country has a detailed aerial source (`hasCoreImagery`), so its spots get images and „Titelbilder erzeugen“ is offered. */
  coreImagery: boolean;
};

/**
 * One subdivision for its detail page: the row of the tree, its scope tiles (coast tiles meeting its polygon; `label`:
 * labelled with it), the sailing areas linked to them, counts of its objects and its last 20 runs. Null for an
 * unknown key. `images`: the image coverage of its spots (`imageCoverage`).
 */
export async function subdivisionDetail(db: Db, key: string): Promise<SubdivisionDetail | null> {
  const { rows } = await db.execute<Row>(subdivisionRowsSql(sql`s.key = ${key}`));
  if (!rows[0]) return null;
  const { country, whole, row } = toRow(rows[0]);
  const { rows: tileRows } = await db.execute<{ id: string; last_run_at: string | Date | null; label: boolean }>(sql`
    select t.id, t.last_run_at, (t.subdivision_id = s.id) as label
    from subdivisions s join tiles t on t.has_coast and t.valid_to is null and ST_Intersects(t.bbox, s.geom) and not ST_Touches(t.bbox, s.geom)
    where s.key = ${key} and s.valid_to is null
    order by t.id
  `);
  const { rows: areaRows } = await db.execute<{ id: string; public_id: string | null; config_key: string | null; members: number; name: string | null }>(sql`
    select distinct o.id, o.public_id, o.config_key, (select count(*)::int from area_members m where m.area_id = o.id) as members,
      ${displayNameSql(sql`o.id`)} as name
    from subdivisions s
    join tiles t on t.has_coast and t.valid_to is null and ST_Intersects(t.bbox, s.geom) and not ST_Touches(t.bbox, s.geom)
    join tile_geo_objects tg on tg.tile_id = t.id
    join geo_objects o on o.id = tg.geo_object_id and o.type = 'area' and o.valid_to is null and o.merged_into_id is null
    where s.key = ${key} and s.valid_to is null
  `);
  const { rows: countRows } = await db.execute<{ confirmed: number; candidates: number; objects: number }>(sql`
    select
      (select count(*)::int from places p join geo_objects o on o.id = p.geo_object_id
       where o.subdivision_id = s.id and p.status = 'confirmed' and p.valid_to is null and p.merged_into_id is null) as confirmed,
      (select count(*)::int from places p join geo_objects o on o.id = p.geo_object_id
       where o.subdivision_id = s.id and p.status = 'candidate' and p.valid_to is null) as candidates,
      (select count(*)::int from geo_objects o where o.subdivision_id = s.id and o.valid_to is null) as objects
    from subdivisions s where s.key = ${key} and s.valid_to is null
  `);
  const { rows: runRows } = await db.execute<{ id: string; kind: string; status: string; stages: string[]; created_at: string | Date; triggered_by: string }>(sql`
    select id, kind, status, stages, created_at, triggered_by from runs
    where scope_type = 'subdivision' and scope_id = ${key}
    order by created_at desc limit 20
  `);
  const { rows: idRows } = await db.execute<{ id: string }>(sql`select id from subdivisions where key = ${key} and valid_to is null`);
  const collator = new Intl.Collator("de");
  return {
    ...row,
    images: await imageCoverage(db, idRows[0]!.id),
    coreImagery: hasCoreImagery(country),
    country,
    whole,
    countryName: countryName(country),
    tiles: tileRows.map((t) => ({ id: t.id, lastRunAt: t.last_run_at === null ? null : new Date(t.last_run_at).toISOString(), label: t.label })),
    areas: areaRows
      .map((a) => ({ id: a.id, publicId: a.public_id, key: a.config_key, members: a.members, name: a.name ?? a.public_id ?? a.id }))
      .sort((a, b) => collator.compare(a.name, b.name)),
    counts: { confirmedPlaces: countRows[0]?.confirmed ?? 0, candidates: countRows[0]?.candidates ?? 0, geoObjects: countRows[0]?.objects ?? 0 },
    runs: runRows.map((r) => ({ id: r.id, kind: r.kind, status: r.status, stages: r.stages, createdAt: new Date(r.created_at).toISOString(), triggeredBy: r.triggered_by })),
  };
}
