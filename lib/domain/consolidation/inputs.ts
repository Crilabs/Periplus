import { sql, type SQL } from "drizzle-orm";
import type { AppConfig } from "@/lib/config";
import type { ConsolidationConfig } from "@/lib/config/schemas";
import type { Db } from "@/lib/db/client";
import type { PlaceKind, PlaceStatus, PoiCategory } from "@/lib/db/schema/geo";
import { activeExtractionRun } from "@/lib/domain/extraction/active-run";
import { latestComputations } from "@/lib/domain/facts/computations";
import { levelFor } from "@/lib/domain/facts/levels";
import { getFactSchema } from "@/lib/domain/facts/schema";
import type { FactLevel } from "@/lib/domain/facts/schema-types";
import { displayNameSql } from "@/lib/domain/gazetteer/names";
import { effectiveVersionMeta, type EffectiveVersionMeta } from "@/lib/domain/mentions/classification";
import { validAtAlias } from "@/lib/domain/timeline";
import type { QuietnessParts } from "./derived/quietness";
import { applyRule } from "./rules";
import type { ConflictResolution, ConsolidationInput, RuleName } from "./types";
import { inputId } from "./weights";

/*
 * The inputs of a geo object's consolidation (spec 07 "Eingänge") and what the profile build knows beside them.
 *
 * - Text facts count only from the active extraction run of their (document version, geo object), resolved with
 *   `activeExtractionRun` once per version (ruling M5-P2; blocked, comparison and non-active-configuration runs are
 *   excluded there). Facts of other runs stay, but count as `ignored.inactiveRun`.
 * - One source is one `sourceKey` (documents of one source count once, spec 07 Unabhängigkeit); duplicated mentions
 *   of one span enter as several inputs of one source, which every rule aggregates per source (ruling M5-P4).
 * - POIs near a place support `highlight.<category>` as inputs only, never as fact rows (ruling M5-P6).
 * - A gazetteer merge means "same place": the facts of objects merged into the consolidated one (the `merged_into_id`
 *   chain) count for it (ruling M5-D-R2); their computations do not (they describe the ended geometry).
 * - Facts of a rejected or ended source do not count; a paused one still counts (a pause only stops crawling).
 * - Validity (objects, POIs, tiles, sources) is judged on the run date `today`, not the database clock.
 */

/** An extraction configuration to evaluate (ruling M7-P11): the model and prompt version of `extract-facts`. */
export type ExtractionCandidate = { model: string; promptVersion: number };

/**
 * A copy of `config` in which only the model and prompt version of `extract-facts` are the candidate's (ruling M7-P11,
 * M5-P22): passed as `LoadInputsOptions.appConfig`, it makes the candidate's extraction runs the active ones. The
 * candidate's runs are comparison runs (as the M4 model comparison), so the copy marks the decision `decided`: for this
 * evaluation the candidate is the chosen configuration. The running configuration is never changed.
 */
export function candidateAppConfig(config: AppConfig, candidate: ExtractionCandidate): AppConfig {
  const task = config.models.tasks["extract-facts"];
  if (!task) throw new Error("config/models.json has no task extract-facts");
  return {
    ...config,
    models: {
      ...config.models,
      tasks: {
        ...config.models.tasks,
        "extract-facts": {
          ...task,
          model: candidate.model,
          promptVersion: candidate.promptVersion,
          decision: { status: "decided", note: `Bewertung des Kandidaten ${candidate.model}@p${candidate.promptVersion}` },
        },
      },
    },
  };
}

export type LoadInputsOptions = {
  cfg: ConsolidationConfig;
  /** The fact schema version whose level attributes are consolidated. */
  schemaVersion: string;
  /** The configuration whose extraction model, prompt and fact schema decide the active run (ruling M5-P2, P22). */
  appConfig?: AppConfig;
  /** The run date (`YYYY-MM-DD`): validity of sources and POIs. */
  today: string;
  /** Load only these attributes (filtered in the queries; the ferry part of quietness, ruling M5-E-R2). */
  attributes?: string[];
};

export type LoadedInputs = {
  inputs: ConsolidationInput[];
  ignored: { inactiveRun: number; unknownAttribute: number };
};

type TextFactRow = {
  id: string;
  geo_object_id: string;
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
 * For each root object (`roots`: a query with one uuid column `id`), the root and every object merged into it,
 * transitively (the `merged_into_id` chain): rows `(root_id, id)`. Set-based form of `mergedChainSql`, for the quality
 * metrics that count text the way consolidation does (ruling M7-C-R2).
 */
export function mergedChainsSql(roots: SQL) {
  return sql`(
    with recursive chain(root_id, id) as (
      select r.id, r.id from (${roots}) r
      union
      select chain.root_id, o.id from geo_objects o join chain on o.merged_into_id = chain.id
    )
    select root_id, id from chain
  )`;
}

/** The ids of the object and of every object merged into it, transitively (the `merged_into_id` chain). */
export function mergedChainSql(geoObjectId: string) {
  return sql`(select c.id from ${mergedChainsSql(sql`select ${geoObjectId}::uuid as id`)} c)`;
}

/** Fact alias `f` has one of `attributes` (no filter without). */
const attributeFilterSql = (attributes: string[] | undefined) =>
  !attributes ? sql`` : attributes.length === 0 ? sql`and false` : sql`and f.attribute in (${sql.join(attributes.map((a) => sql`${a}`), sql`, `)})`;

/** Source alias `s` is neither rejected nor ended on `today`. */
export const countingSourceSql = (today: string) =>
  sql`s.status <> 'rejected' and (s.valid_to is null or s.valid_to > ${today}::date)`;

/**
 * Every input of the geo object's consolidation: text facts of the active runs, the facts of the newest computation
 * per kind, review facts, observation facts and (places only) POI support for `highlight.<category>`. Attributes the
 * object's level does not know in `schemaVersion` are dropped and counted. Empty for an object without a fact level.
 * With `opts.attributes`, only those attributes are loaded (text and basis facts filtered in SQL, so the active-run
 * resolution only runs for their versions; other attributes are not counted as ignored). Sorted by attribute, source
 * and id.
 */
export async function loadInputs(db: Db, geoObjectId: string, opts: LoadInputsOptions): Promise<LoadedInputs> {
  const ignored = { inactiveRun: 0, unknownAttribute: 0 };
  const level = await levelFor(db, geoObjectId);
  if (level === null) return { inputs: [], ignored };
  const { cfg } = opts;

  const wantsHighlights = !opts.attributes || opts.attributes.some((a) => a.startsWith("highlight."));
  const all: ConsolidationInput[] = [
    ...(await textInputs(db, geoObjectId, opts, ignored)),
    ...(await computedInputs(db, geoObjectId, cfg)),
    ...(await basisInputs(db, geoObjectId, cfg, "review", opts.attributes)),
    ...(await basisInputs(db, geoObjectId, cfg, "observed", opts.attributes)),
    ...(level === "place" && wantsHighlights ? await poiInputs(db, geoObjectId, cfg, opts.today) : []),
  ];

  const known = new Set(getFactSchema(opts.schemaVersion).levels[level].map((d) => d.key));
  const wanted = opts.attributes ? new Set(opts.attributes) : null;
  const inputs = all.filter((i) => {
    if (wanted && !wanted.has(i.attribute)) return false;
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
 * Text facts (basis `mention_id`) of the object and the objects merged into it, from the active extraction run of
 * their (version, fact object), in one query joined to version, document and source (rejected and ended sources left
 * out); the active run is resolved once per (version, object), the effective version meta once per version.
 * `sourceType` is the version's effective document type (classification first, ruling M5-P24). `dateKnown` is false
 * only when the observation date is the version's fetch date (basis `fetched`) and the fact did not state another.
 *
 * `lastConfirmedAt` (rulings M5-P21, M5-D-R2): a gone document keeps its `observedAt` and is confirmed last on that
 * date. The text of an active document is current when the fact's chunk (its origin chunk, if carried) is in the
 * document's current version or carried into it; then it is confirmed on the document's last check, else on the
 * current version's fetch date. Text the document no longer contains was confirmed last on the fetch date of the
 * newest version that still contained it.
 */
async function textInputs(
  db: Db,
  geoObjectId: string,
  opts: LoadInputsOptions,
  ignored: LoadedInputs["ignored"],
): Promise<ConsolidationInput[]> {
  const { rows } = await db.execute<TextFactRow>(sql`
    select f.id, f.geo_object_id, f.attribute, f.value, f.confidence, f.observed_at::text as observed_at,
           f.extraction_run_id, v.id as version_id, d.id as document_id, d.source_id, s.weight as source_weight,
           d.status = 'gone' as gone,
           case when d.status = 'gone' then f.observed_at::text
                when seen.current then coalesce((d.last_checked_at at time zone 'UTC')::date, (seen.last_fetched at time zone 'UTC')::date)::text
                else (seen.last_fetched at time zone 'UTC')::date::text
           end as last_confirmed
    from facts f
    join mentions m on m.id = f.mention_id
    join document_versions v on v.id = m.document_version_id
    join documents d on d.id = v.document_id
    join sources s on s.id = d.source_id
    join chunks mc on mc.id = m.chunk_id
    join chunks oc on oc.id = coalesce(mc.carried_from_chunk_id, mc.id)
    -- the versions of the document holding the text: the origin chunk's version and those carrying the origin chunk
    -- (carried_from_chunk_id always names the origin, one level)
    cross join lateral (
      select bool_or(hv.id = d.current_version_id) as current, max(hv.fetched_at) as last_fetched
      from document_versions hv
      where hv.document_id = d.id
        and (hv.id = oc.document_version_id
             or exists (select 1 from chunks c where c.document_version_id = hv.id and c.carried_from_chunk_id = oc.id))
    ) seen
    where f.geo_object_id in ${mergedChainSql(geoObjectId)} and f.mention_id is not null and ${countingSourceSql(opts.today)}
      ${attributeFilterSql(opts.attributes)}
    order by f.id
  `);

  const unitKey = (versionId: string, objectId: string) => `${versionId}:${objectId}`;
  const active = new Map<string, string | null>();
  const meta = new Map<string, EffectiveVersionMeta>();
  const units = new Map(rows.map((r) => [unitKey(r.version_id, r.geo_object_id), r]));
  for (const key of [...units.keys()].sort()) {
    const { version_id: versionId, geo_object_id: objectId } = units.get(key)!;
    const run = await activeExtractionRun(db, versionId, objectId, opts.appConfig);
    active.set(key, run?.id ?? null);
    if (run && !meta.has(versionId)) meta.set(versionId, await effectiveVersionMeta(db, versionId));
  }

  const inputs: ConsolidationInput[] = [];
  for (const r of rows) {
    if (r.extraction_run_id !== active.get(unitKey(r.version_id, r.geo_object_id))) {
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
 * source `observation:<id>`, `weights.observed`; none before M8) of the object and the objects merged into it, with
 * their stored confidence.
 */
async function basisInputs(
  db: Db,
  geoObjectId: string,
  cfg: ConsolidationConfig,
  origin: "review" | "observed",
  attributes?: string[],
): Promise<ConsolidationInput[]> {
  const basis = origin === "review" ? sql`f.review_decision_id` : sql`f.observation_id`;
  const { rows } = await db.execute<BasisFactRow>(sql`
    select f.id, f.attribute, f.value, f.confidence, f.observed_at::text as observed_at, ${basis}::text as basis_id
    from facts f
    where f.geo_object_id in ${mergedChainSql(geoObjectId)} and ${basis} is not null ${attributeFilterSql(attributes)}
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
async function poiInputs(db: Db, geoObjectId: string, cfg: ConsolidationConfig, today: string): Promise<ConsolidationInput[]> {
  const radiusM = cfg.rules.highlight.poiRadiusM;
  const { rows } = await db.execute<PoiRow>(sql`
    select o.id, o.category::text as category, o.origin::text as origin, o.valid_from::text as valid_from,
           ${displayNameSql(sql`o.id`, today)} as name
    from places p
    join geo_objects o
      on o.type = 'poi' and o.category is not null and o.merged_into_id is null
     and ${validAtAlias("o", today)}
     -- box prefilter (index), then the exact distance in metres
     and o.geom && ST_Expand(p.position, ${radiusM}::float8 / (111320 * cos(radians(ST_Y(p.position)))))
     and ST_DWithin(o.geom::geography, p.position::geography, ${radiusM}::float8)
    where p.geo_object_id = ${geoObjectId} and ${validAtAlias("p", today)} and p.merged_into_id is null and p.status <> 'rejected'
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
  /**
   * Keys of `conflict` tasks decided for one value (`value_a` / `value_b`): the decision entered as a review fact, the
   * conflict is not raised again even if the value groups still weigh alike (ruling M5-D-R1 NOTE).
   */
  decidedConflictKeys: Set<string>;
  /** Open `conflict` / `uncertain_change` tasks by `"<kind>:<attribute>"`. */
  openTasks: Map<string, { taskId: string; key: string }>;
  /**
   * Text facts of the object (and of objects merged into it) whose source is rejected or ended on the run date: a
   * value resting only on them is withdrawn, not kept to expire („Quelle beenden“, ruling M6-H-R1).
   */
  withdrawnFactIds: Set<string>;
  /** `source:<id>` keys of the sources of `withdrawnFactIds`: a kept value stops citing them (ruling M6-FIN-R2). */
  withdrawnSourceKeys: Set<string>;
  /**
   * Text facts of the object (and of objects merged into it) → their observation date, also those that no longer
   * count (an ineligible run): a removal decision no longer lifts a safety list entry the previous profile cites a
   * younger fact for (GR-12).
   */
  factObservedAt: Map<string, string>;
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
 * The profile context of a geo object on the run date `today`; null for an unknown or invalid (ended, merged) object,
 * one without a fact level, or one whose place is rejected or merged (a merged object is consolidated as part of its
 * survivor). The tile is the place's tile, else the tile of the object's centroid; without a valid tile the cycle is
 * `expiry.defaultCycleDays` and there is no area. Documents and sources count the distinct ones with a mention of the
 * object or of an object merged into it, from sources that are neither rejected nor ended (as `loadInputs`).
 */
export async function loadContext(
  db: Db,
  geoObjectId: string,
  cfg: ConsolidationConfig,
  today: string,
): Promise<ProfileContext | null> {
  const { rows } = await db.execute<ObjectRow>(sql`
    select o.merged_into_id is null and ${validAtAlias("o", today)} as valid,
           o.parent_id, ${displayNameSql(sql`o.id`)} as name,
           md5(ST_AsEWKB(ST_SnapToGrid(o.geom, 1e-6))) as geometry_hash,
           p.id as place_id, p.kind as place_kind, p.status as place_status, p.status_reason as place_status_reason,
           p.merged_into_id is not null as place_merged, coalesce(${validAtAlias("p", today)}, false) as place_valid,
           p.public_id as place_public_id, ST_X(p.position) as place_lon, ST_Y(p.position) as place_lat,
           t.cycle_days, t.area_id
    from geo_objects o
    left join places p on p.geo_object_id = o.id
    left join tiles t on t.id = coalesce(p.tile_id, tile_id_for(o.centroid))
      and ${validAtAlias("t", today)}
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
    join sources s on s.id = d.source_id
    where m.geo_object_id in ${mergedChainSql(geoObjectId)} and ${countingSourceSql(today)}
  `);

  const { rows: withdrawn } = await db.execute<{ id: string; source_id: string }>(sql`
    select f.id, s.id as source_id
    from facts f
    join mentions m on m.id = f.mention_id
    join document_versions v on v.id = m.document_version_id
    join documents d on d.id = v.document_id
    join sources s on s.id = d.source_id
    where f.geo_object_id in ${mergedChainSql(geoObjectId)} and not (${countingSourceSql(today)})
  `);

  const { rows: observed } = await db.execute<{ id: string; observed_at: string }>(sql`
    select f.id, f.observed_at::text as observed_at
    from facts f
    where f.geo_object_id in ${mergedChainSql(geoObjectId)} and f.mention_id is not null
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
  const decidedConflictKeys = new Set<string>();
  const openTasks = new Map<string, { taskId: string; key: string }>();
  for (const t of tasks) {
    if (t.key === null) continue;
    const attribute = t.subject_id.slice(prefix.length);
    if (t.status === "open") openTasks.set(`${t.kind}:${attribute}`, { taskId: t.id, key: t.key });
    else if (t.status !== "decided") continue;
    else if (t.kind === "uncertain_change") decidedUncertainKeys.add(t.key);
    else if (t.action !== null && RESOLUTION_BY_ACTION[t.action]) resolutions.set(t.key, RESOLUTION_BY_ACTION[t.action]!);
    else decidedConflictKeys.add(t.key);
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
    decidedConflictKeys,
    openTasks,
    withdrawnFactIds: new Set(withdrawn.map((r) => r.id)),
    withdrawnSourceKeys: new Set(withdrawn.map((r) => `source:${r.source_id}`)),
    factObservedAt: new Map(observed.map((r) => [r.id, r.observed_at])),
  };
}

const METRES_PER_NM = 1852;
/** Parent levels walked for the ferry part; a deeper chain is a data error. */
const MAX_PARENT_DEPTH = 10;

/** What the derived values of a profile need beside the inputs (places: quietness; POIs: importance and spot ids). */
/** Where the ferry part of quietness comes from (provenance, ruling M5-E-R3 I-3). */
export type FerryBasis =
  | { kind: "lane"; restrictedAreaId: string }
  | { kind: "parent"; geoObjectId: string; inputIds: string[] };

export type DerivedInputs = {
  quietness:
    | (Omit<QuietnessParts, "occupancy" | "text"> & {
        /** The quietness computation the distances come from (provenance). */
        computationId: string | null;
        /** The ferry lane or the parent's `ferry_traffic` inputs behind `ferry`; null without a ferry part. */
        ferryBasis: FerryBasis | null;
      })
    | null;
  importance: {
    sources: Array<{ key: string; weight: number }>;
    sitelinks: number | null;
    category: PoiCategory;
    spotCandidates: Array<{ placeId: string; distanceNm: number }>;
  } | null;
};

/**
 * The derived-value inputs of the geo object on the run date `opts.today`.
 *
 * - Place: settlement and road distance from the newest `quietness` computation (null without one); the ferry part is
 *   `quietness.ferryLaneValue` when a valid `ferry_lane` restricted area lies within `quietness.ferryLaneRadiusM` of
 *   the place position (the nearest lane cited), otherwise the `ferry_traffic` of the nearest parent that has inputs
 *   for it, loaded with an attribute filter and evaluated with its schema rule on the same run date (ruling M5-P17:
 *   not the parent's stored profile, which may be built later in the same run) and mapped by
 *   `quietness.ferryTraffic` (the parent and its supporting input ids cited); otherwise null.
 * - POI: the independent sources with a mention of it or of an object merged into it (`source:<id>`, weight
 *   `sources.weight`; rejected and ended sources left out), its Wikidata sitelink count (null without an item or a
 *   loaded count), its category (no category → no importance) and the spot candidates: confirmed, valid, unmerged
 *   places with a public id within the largest radius of meaning (`max(importance.radiusNm)`, ruling M5-E-R2), by
 *   their public id (`sp_…`), distance over `::geography` / 1852, rounded to 3 decimals.
 * - Any other level: nothing.
 */
export async function loadDerivedInputs(
  db: Db,
  geoObjectId: string,
  ctx: ProfileContext,
  opts: LoadInputsOptions,
): Promise<DerivedInputs> {
  if (ctx.level === "place" && ctx.place) return { quietness: await quietnessInputs(db, geoObjectId, ctx.place.position, opts), importance: null };
  if (ctx.level === "poi") return { quietness: null, importance: await importanceInputs(db, geoObjectId, opts) };
  return { quietness: null, importance: null };
}

async function quietnessInputs(
  db: Db,
  geoObjectId: string,
  position: LonLat,
  opts: LoadInputsOptions,
): Promise<NonNullable<DerivedInputs["quietness"]>> {
  const { cfg, today } = opts;
  const computation = (await latestComputations(db, geoObjectId)).get("quietness");
  const distance = (key: string) => {
    const v = computation?.outputs[key];
    return typeof v === "number" ? v : null;
  };

  const radiusM = cfg.quietness.ferryLaneRadiusM;
  const point = sql`ST_SetSRID(ST_MakePoint(${position.lon}, ${position.lat}), 4326)::geography`;
  const { rows: lanes } = await db.execute<{ id: string }>(sql`
    select r.id from restricted_areas r
    where r.kind = 'ferry_lane' and ${validAtAlias("r", today)}
      -- bbox prefilter on the GIST index (a geography cast cannot use it); the longitude degree is the wider one
      and r.geom && ST_Expand(ST_SetSRID(ST_MakePoint(${position.lon}, ${position.lat}), 4326), ${radiusM}::float8 / (111320 * cos(radians(${position.lat}::float8))))
      and ST_DWithin(r.geom::geography, ${point}, ${radiusM}::float8)
    order by ST_Distance(r.geom::geography, ${point}), r.id
    limit 1
  `);
  const lane = lanes[0];
  const parent = lane ? null : await parentFerryTraffic(db, geoObjectId, opts);

  return {
    settlementDistanceM: distance("settlementDistanceM"),
    roadDistanceM: distance("roadDistanceM"),
    ferry: lane ? cfg.quietness.ferryLaneValue : (parent?.value ?? null),
    computationId: computation?.id ?? null,
    ferryBasis: lane
      ? { kind: "lane", restrictedAreaId: lane.id }
      : parent
        ? { kind: "parent", geoObjectId: parent.geoObjectId, inputIds: parent.inputIds }
        : null,
  };
}

/**
 * The mapped `ferry_traffic` of the nearest parent with inputs for it (its schema rule, run date), with the parent
 * and the ids of the inputs supporting it; or null.
 */
async function parentFerryTraffic(
  db: Db,
  geoObjectId: string,
  opts: LoadInputsOptions,
): Promise<{ value: number; geoObjectId: string; inputIds: string[] } | null> {
  const seen = new Set([geoObjectId]);
  let id: string | null = await parentOf(db, geoObjectId);
  for (let depth = 0; id !== null && !seen.has(id) && depth < MAX_PARENT_DEPTH; depth++) {
    seen.add(id);
    const level = await levelFor(db, id);
    const def = level === null ? undefined : getFactSchema(opts.schemaVersion).levels[level].find((d) => d.key === "ferry_traffic");
    if (level !== null && def) {
      const { inputs } = await loadInputs(db, id, { ...opts, attributes: ["ferry_traffic"] });
      const result = applyRule(def.rule as RuleName, inputs, { attribute: "ferry_traffic", level, place: null, today: opts.today, cfg: opts.cfg });
      const mapped = result === null ? undefined : opts.cfg.quietness.ferryTraffic[result.value as keyof typeof opts.cfg.quietness.ferryTraffic];
      if (mapped !== undefined) {
        const inputIds = [...new Set(result!.support.map(inputId).filter((x) => x !== ""))].sort();
        return { value: mapped, geoObjectId: id, inputIds };
      }
    }
    id = await parentOf(db, id);
  }
  return null;
}

async function parentOf(db: Db, geoObjectId: string): Promise<string | null> {
  const { rows } = await db.execute<{ parent_id: string | null }>(sql`select parent_id from geo_objects where id = ${geoObjectId}`);
  return rows[0]?.parent_id ?? null;
}

async function importanceInputs(db: Db, geoObjectId: string, opts: LoadInputsOptions): Promise<DerivedInputs["importance"]> {
  const { today, cfg } = opts;
  const { rows: poi } = await db.execute<{ category: PoiCategory | null; sitelinks: number | null }>(sql`
    select o.category::text as category, w.sitelinks
    from geo_objects o
    left join wikidata_sitelinks w on w.wikidata_id = o.wikidata_id
    where o.id = ${geoObjectId}
  `);
  const category = poi[0]?.category ?? null;
  if (category === null) return null;

  const { rows: sourceRows } = await db.execute<{ id: string; weight: number }>(sql`
    select distinct s.id, s.weight
    from mentions m
    join document_versions v on v.id = m.document_version_id
    join documents d on d.id = v.document_id
    join sources s on s.id = d.source_id
    where m.geo_object_id in ${mergedChainSql(geoObjectId)} and ${countingSourceSql(today)}
    order by s.id
  `);

  // the largest radius of meaning of the rules version (ruling M5-E-R2), not a constant
  const radiusM = Math.max(...cfg.importance.radiusNm) * METRES_PER_NM;
  const { rows: spots } = await db.execute<{ public_id: string; distance_nm: number }>(sql`
    select p.public_id, round((ST_Distance(p.position::geography, o.geom::geography) / ${METRES_PER_NM})::numeric, 3)::float8 as distance_nm
    from geo_objects o
    join places p
      on p.status = 'confirmed' and p.public_id is not null and p.merged_into_id is null
     and ${validAtAlias("p", today)}
     -- box prefilter (index), then the exact distance in metres
     and p.position && ST_Expand(o.geom, ${radiusM}::float8 / (111320 * cos(radians(ST_Y(o.centroid)))))
     and ST_DWithin(p.position::geography, o.geom::geography, ${radiusM}::float8)
    join geo_objects po
      on po.id = p.geo_object_id and po.merged_into_id is null
     and ${validAtAlias("po", today)}
    where o.id = ${geoObjectId}
    order by distance_nm, p.public_id
  `);

  return {
    sources: sourceRows.map((r) => ({ key: `source:${r.id}`, weight: Number(r.weight) })),
    sitelinks: poi[0]!.sitelinks === null ? null : Number(poi[0]!.sitelinks),
    category,
    spotCandidates: spots.map((r) => ({ placeId: r.public_id, distanceNm: Number(r.distance_nm) })),
  };
}
