import { sql } from "drizzle-orm";
import type { AppConfig } from "@/lib/config";
import type { ConsolidationConfig } from "@/lib/config/schemas";
import type { Db } from "@/lib/db/client";
import type { PlaceKind, PlaceStatus } from "@/lib/db/schema/geo";
import { activeExtractionRun } from "@/lib/domain/extraction/active-run";
import { latestComputations } from "@/lib/domain/facts/computations";
import { levelFor } from "@/lib/domain/facts/levels";
import { getFactSchema } from "@/lib/domain/facts/schema";
import type { FactLevel } from "@/lib/domain/facts/schema-types";
import { displayNameSql } from "@/lib/domain/gazetteer/names";
import { effectiveVersionMeta, type EffectiveVersionMeta } from "@/lib/domain/mentions/classification";
import type { ConflictResolution, ConsolidationInput } from "./types";

/*
 * The inputs of a geo object's consolidation (spec 07 "Eingänge") and what the profile build knows beside them.
 *
 * - Text facts count only from the active extraction run of their (document version, geo object), resolved with
 *   `activeExtractionRun` once per version (ruling M5-P2; blocked, comparison and non-active-configuration runs are
 *   excluded there). Facts of other runs stay, but count as `ignored.inactiveRun`.
 * - One source is one `sourceKey` (documents of one source count once, spec 07 Unabhängigkeit); duplicated mentions
 *   of one span enter as several inputs of one source, which every rule aggregates per source (ruling M5-P4).
 * - POIs near a place support `highlight.<category>` as inputs only, never as fact rows (ruling M5-P6).
 */

export type LoadInputsOptions = {
  cfg: ConsolidationConfig;
  /** The fact schema version whose level attributes are consolidated. */
  schemaVersion: string;
  /** The configuration whose extraction model, prompt and fact schema decide the active run (ruling M5-P2, P22). */
  appConfig?: AppConfig;
};

export type LoadedInputs = {
  inputs: ConsolidationInput[];
  ignored: { inactiveRun: number; unknownAttribute: number };
};

type TextFactRow = {
  id: string;
  attribute: string;
  value: unknown;
  confidence: number;
  observed_at: string;
  extraction_run_id: string;
  version_id: string;
  document_id: string;
  source_id: string;
  source_weight: number;
  gone: boolean;
  last_confirmed: string;
};

type BasisFactRow = { id: string; attribute: string; value: unknown; confidence: number; observed_at: string; basis_id: string };

type PoiRow = { id: string; category: string; origin: string; valid_from: string; name: string | null };

const utcDate = (d: Date) => d.toISOString().slice(0, 10);

/**
 * Every input of the geo object's consolidation: text facts of the active runs, the facts of the newest computation
 * per kind, review facts, observation facts and (places only) POI support for `highlight.<category>`. Attributes the
 * object's level does not know in `schemaVersion` are dropped and counted. Empty for an object without a fact level.
 * Sorted by attribute, source and id.
 */
export async function loadInputs(db: Db, geoObjectId: string, opts: LoadInputsOptions): Promise<LoadedInputs> {
  const ignored = { inactiveRun: 0, unknownAttribute: 0 };
  const level = await levelFor(db, geoObjectId);
  if (level === null) return { inputs: [], ignored };
  const { cfg } = opts;

  const all: ConsolidationInput[] = [
    ...(await textInputs(db, geoObjectId, opts, ignored)),
    ...(await computedInputs(db, geoObjectId, cfg)),
    ...(await basisInputs(db, geoObjectId, cfg, "review")),
    ...(await basisInputs(db, geoObjectId, cfg, "observed")),
    ...(level === "place" ? await poiInputs(db, geoObjectId, cfg) : []),
  ];

  const known = new Set(getFactSchema(opts.schemaVersion).levels[level].map((d) => d.key));
  const inputs = all.filter((i) => {
    if (known.has(i.attribute)) return true;
    ignored.unknownAttribute++;
    return false;
  });
  inputs.sort(byAttributeSourceId);
  return { inputs, ignored };
}

const inputKey = (i: ConsolidationInput) => i.factId ?? i.poiId ?? i.computationId ?? "";

function byAttributeSourceId(a: ConsolidationInput, b: ConsolidationInput): number {
  for (const [x, y] of [
    [a.attribute, b.attribute],
    [a.sourceKey, b.sourceKey],
    [inputKey(a), inputKey(b)],
  ] as const) {
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/**
 * Text facts (basis `mention_id`) of the active extraction run of their (version, object), in one query joined to
 * version, document and source; the active run and the effective version meta are resolved once per version.
 * `sourceType` is the version's effective document type (classification first, ruling M5-P24). `dateKnown` is false
 * only when the observation date is the version's fetch date (basis `fetched`) and the fact did not state another.
 * A gone document keeps its `observedAt` but is confirmed last on that date; an active one on its last check, else
 * on the version's fetch date (ruling M5-P21).
 */
async function textInputs(
  db: Db,
  geoObjectId: string,
  opts: LoadInputsOptions,
  ignored: LoadedInputs["ignored"],
): Promise<ConsolidationInput[]> {
  const { rows } = await db.execute<TextFactRow>(sql`
    select f.id, f.attribute, f.value, f.confidence, f.observed_at::text as observed_at, f.extraction_run_id,
           v.id as version_id, d.id as document_id, d.source_id, s.weight as source_weight, d.status = 'gone' as gone,
           case when d.status = 'gone' then f.observed_at::text
                else coalesce((d.last_checked_at at time zone 'UTC')::date, (v.fetched_at at time zone 'UTC')::date)::text
           end as last_confirmed
    from facts f
    join mentions m on m.id = f.mention_id
    join document_versions v on v.id = m.document_version_id
    join documents d on d.id = v.document_id
    join sources s on s.id = d.source_id
    where f.geo_object_id = ${geoObjectId} and f.mention_id is not null
    order by f.id
  `);

  const active = new Map<string, string | null>();
  const meta = new Map<string, EffectiveVersionMeta>();
  for (const versionId of [...new Set(rows.map((r) => r.version_id))].sort()) {
    const run = await activeExtractionRun(db, versionId, geoObjectId, opts.appConfig);
    active.set(versionId, run?.id ?? null);
    if (run) meta.set(versionId, await effectiveVersionMeta(db, versionId));
  }

  const inputs: ConsolidationInput[] = [];
  for (const r of rows) {
    if (r.extraction_run_id !== active.get(r.version_id)) {
      ignored.inactiveRun++;
      continue;
    }
    const m = meta.get(r.version_id)!;
    inputs.push({
      factId: r.id,
      attribute: r.attribute,
      value: r.value,
      origin: "text",
      confidence: Number(r.confidence),
      observedAt: r.observed_at,
      dateKnown: m.basis !== "fetched" || r.observed_at !== m.observedAt,
      sourceKey: `source:${r.source_id}`,
      sourceWeight: Number(r.source_weight),
      sourceType: m.docType,
      documentId: r.document_id,
      gone: r.gone,
      lastConfirmedAt: r.last_confirmed,
      computationId: null,
      poiId: null,
    });
  }
  return inputs;
}

/** The facts of the newest computation per kind (`computed:<kind>`), confirmed on the computation's date. */
async function computedInputs(db: Db, geoObjectId: string, cfg: ConsolidationConfig): Promise<ConsolidationInput[]> {
  const inputs: ConsolidationInput[] = [];
  for (const c of (await latestComputations(db, geoObjectId)).values()) {
    for (const f of c.facts) {
      inputs.push({
        factId: f.id,
        attribute: f.attribute,
        value: f.value,
        origin: "computed",
        confidence: f.confidence,
        observedAt: f.observedAt,
        dateKnown: true,
        sourceKey: `computed:${c.kind}`,
        sourceWeight: cfg.weights.computed,
        sourceType: null,
        documentId: null,
        gone: false,
        lastConfirmedAt: utcDate(c.createdAt),
        computationId: c.id,
        poiId: null,
      });
    }
  }
  return inputs;
}

/**
 * Review facts (`review_decision_id`, source `review`, `weights.review`) or observation facts (`observation_id`,
 * source `observation:<id>`, `weights.observed`; none before M8), with their stored confidence.
 */
async function basisInputs(
  db: Db,
  geoObjectId: string,
  cfg: ConsolidationConfig,
  origin: "review" | "observed",
): Promise<ConsolidationInput[]> {
  const basis = origin === "review" ? sql`f.review_decision_id` : sql`f.observation_id`;
  const { rows } = await db.execute<BasisFactRow>(sql`
    select f.id, f.attribute, f.value, f.confidence, f.observed_at::text as observed_at, ${basis}::text as basis_id
    from facts f
    where f.geo_object_id = ${geoObjectId} and ${basis} is not null
    order by f.id
  `);
  return rows.map((r) => ({
    factId: r.id,
    attribute: r.attribute,
    value: r.value,
    origin,
    confidence: Number(r.confidence),
    observedAt: r.observed_at,
    dateKnown: true,
    sourceKey: origin === "review" ? "review" : `observation:${r.basis_id}`,
    sourceWeight: origin === "review" ? cfg.weights.review : cfg.weights.observed,
    sourceType: null,
    documentId: null,
    gone: false,
    lastConfirmedAt: r.observed_at,
    computationId: null,
    poiId: null,
  }));
}

/**
 * Valid POIs with a category within `rules.highlight.poiRadiusM` of the place position, each an input
 * `highlight.<category>` `{ present: true, names: [display name] }` (ruling M5-P6): one source per gazetteer origin
 * (`gazetteer:<origin>`, all OSM POIs are one source), `weights.poi`, `poiConfidence`, `observedAt` = `valid_from`
 * with `dateKnown false` (an import date is no observation: no time course, no expiry).
 */
async function poiInputs(db: Db, geoObjectId: string, cfg: ConsolidationConfig): Promise<ConsolidationInput[]> {
  const radiusM = cfg.rules.highlight.poiRadiusM;
  const { rows } = await db.execute<PoiRow>(sql`
    select o.id, o.category::text as category, o.origin::text as origin, o.valid_from::text as valid_from,
           ${displayNameSql(sql`o.id`)} as name
    from places p
    join geo_objects o
      on o.type = 'poi' and o.category is not null and o.merged_into_id is null
     and o.valid_from <= current_date and (o.valid_to is null or o.valid_to > current_date)
     -- box prefilter (index), then the exact distance in metres
     and o.geom && ST_Expand(p.position, ${radiusM}::float8 / (111320 * cos(radians(ST_Y(p.position)))))
     and ST_DWithin(o.geom::geography, p.position::geography, ${radiusM}::float8)
    where p.geo_object_id = ${geoObjectId} and p.valid_to is null and p.merged_into_id is null and p.status <> 'rejected'
    order by o.id
  `);
  return rows.map((r) => ({
    factId: null,
    attribute: `highlight.${r.category}`,
    value: { present: true, names: r.name === null ? [] : [r.name] },
    origin: "computed",
    confidence: cfg.poiConfidence,
    observedAt: r.valid_from,
    dateKnown: false,
    sourceKey: `gazetteer:${r.origin}`,
    sourceWeight: cfg.weights.poi,
    sourceType: null,
    documentId: null,
    gone: false,
    lastConfirmedAt: r.valid_from,
    computationId: null,
    poiId: r.id,
  }));
}

export type LonLat = { lon: number; lat: number };

/** What the profile build knows about the geo object beside its inputs. */
export type ProfileContext = {
  level: FactLevel;
  place: {
    id: string;
    kind: PlaceKind;
    status: PlaceStatus;
    statusReason: string | null;
    position: LonLat;
    publicId: string | null;
  } | null;
  identity: { name: string | null; parentId: string | null; geometryHash: string };
  tileCycleDays: number;
  areaId: string | null;
  documentsCount: number;
  sourcesCount: number;
  /** Attribute → reason, from `outputs.gaps` of the newest computations. */
  computationGaps: Record<string, string>;
  /** Conflict key → the admin's resolution (decided `conflict` tasks with `seasonal` / `leave_open`). */
  resolutions: Map<string, ConflictResolution>;
  /** Keys of decided `uncertain_change` tasks. */
  decidedUncertainKeys: Set<string>;
  /** Open `conflict` / `uncertain_change` tasks by `"<kind>:<attribute>"`. */
  openTasks: Map<string, { taskId: string; key: string }>;
};

type ObjectRow = {
  valid: boolean;
  parent_id: string | null;
  name: string | null;
  geometry_hash: string;
  place_id: string | null;
  place_kind: PlaceKind | null;
  place_status: PlaceStatus | null;
  place_status_reason: string | null;
  place_merged: boolean;
  place_valid: boolean;
  place_public_id: string | null;
  place_lon: number | null;
  place_lat: number | null;
  cycle_days: number | null;
  area_id: string | null;
};

type TaskRow = { id: string; kind: "conflict" | "uncertain_change"; status: string; subject_id: string; key: string | null; action: string | null };

const RESOLUTION_BY_ACTION: Record<string, ConflictResolution> = { seasonal: "seasonal", leave_open: "left_open" };

/**
 * The profile context of a geo object; null for an unknown or invalid (ended, merged) object, one without a fact
 * level, or one whose place is rejected or merged. The tile is the place's tile, else the tile of the object's
 * centroid; without a valid tile the cycle is `expiry.defaultCycleDays` and there is no area. Documents and sources
 * count the distinct ones with a mention of the object.
 */
export async function loadContext(db: Db, geoObjectId: string, cfg: ConsolidationConfig): Promise<ProfileContext | null> {
  const { rows } = await db.execute<ObjectRow>(sql`
    select o.merged_into_id is null and o.valid_from <= current_date and (o.valid_to is null or o.valid_to > current_date) as valid,
           o.parent_id, ${displayNameSql(sql`o.id`)} as name,
           md5(ST_AsEWKB(ST_SnapToGrid(o.geom, 1e-6))) as geometry_hash,
           p.id as place_id, p.kind as place_kind, p.status as place_status, p.status_reason as place_status_reason,
           p.merged_into_id is not null as place_merged, coalesce(p.valid_to is null, false) as place_valid,
           p.public_id as place_public_id, ST_X(p.position) as place_lon, ST_Y(p.position) as place_lat,
           t.cycle_days, t.area_id
    from geo_objects o
    left join places p on p.geo_object_id = o.id
    left join tiles t on t.id = coalesce(p.tile_id, tile_id_for(o.centroid))
      and t.valid_from <= current_date and (t.valid_to is null or t.valid_to > current_date)
    where o.id = ${geoObjectId}
  `);
  const o = rows[0];
  if (!o || !o.valid) return null;
  if (o.place_id !== null && (o.place_status === "rejected" || o.place_merged)) return null;
  const level = await levelFor(db, geoObjectId);
  if (level === null) return null;

  const place =
    level === "place" && o.place_id !== null && o.place_valid
      ? {
          id: o.place_id,
          kind: o.place_kind!,
          status: o.place_status!,
          statusReason: o.place_status_reason,
          position: { lon: Number(o.place_lon), lat: Number(o.place_lat) },
          publicId: o.place_public_id,
        }
      : null;

  const { rows: counts } = await db.execute<{ documents: number; sources: number }>(sql`
    select count(distinct d.id)::int as documents, count(distinct d.source_id)::int as sources
    from mentions m
    join document_versions v on v.id = m.document_version_id
    join documents d on d.id = v.document_id
    where m.geo_object_id = ${geoObjectId}
  `);

  const computationGaps: Record<string, string> = {};
  for (const c of (await latestComputations(db, geoObjectId)).values()) {
    const gaps = c.outputs.gaps;
    if (!Array.isArray(gaps)) continue;
    for (const gap of gaps as Array<{ attribute?: unknown; reason?: unknown }>) {
      if (typeof gap.attribute === "string" && typeof gap.reason === "string" && !(gap.attribute in computationGaps)) {
        computationGaps[gap.attribute] = gap.reason;
      }
    }
  }

  const prefix = `${geoObjectId}:`;
  const { rows: tasks } = await db.execute<TaskRow>(sql`
    select t.id, t.kind::text as kind, t.status::text as status, t.subject_id, t.context->>'key' as key,
           (select d.decision->>'action' from review_decisions d where d.task_id = t.id
            order by d.decided_at desc, d.id desc limit 1) as action
    from review_tasks t
    where t.kind in ('conflict', 'uncertain_change') and left(t.subject_id, ${prefix.length}) = ${prefix}
    order by t.created_at, t.id
  `);
  const resolutions = new Map<string, ConflictResolution>();
  const decidedUncertainKeys = new Set<string>();
  const openTasks = new Map<string, { taskId: string; key: string }>();
  for (const t of tasks) {
    if (t.key === null) continue;
    const attribute = t.subject_id.slice(prefix.length);
    if (t.status === "open") openTasks.set(`${t.kind}:${attribute}`, { taskId: t.id, key: t.key });
    else if (t.status !== "decided") continue;
    else if (t.kind === "uncertain_change") decidedUncertainKeys.add(t.key);
    else if (t.action !== null && RESOLUTION_BY_ACTION[t.action]) resolutions.set(t.key, RESOLUTION_BY_ACTION[t.action]!);
  }

  return {
    level,
    place,
    identity: { name: o.name, parentId: o.parent_id, geometryHash: o.geometry_hash },
    tileCycleDays: o.cycle_days ?? cfg.expiry.defaultCycleDays,
    areaId: o.area_id,
    documentsCount: counts[0]?.documents ?? 0,
    sourcesCount: counts[0]?.sources ?? 0,
    computationGaps,
    resolutions,
    decidedUncertainKeys,
    openTasks,
  };
}
