import type { Geometry, MultiPolygon, Polygon } from "geojson";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import { geomFromGeoJson } from "@/lib/db/geometry";
import { places, restrictedAreas, reviewTasks, type RestrictedKind } from "@/lib/db/schema";
import type { LonLat } from "@/lib/domain/geo-view";
import { createReviewTask, hasDecidedTask } from "@/lib/domain/review";
import type { Bbox } from "@/lib/domain/tiles";
import { validAt } from "@/lib/domain/timeline";

export type { RestrictedKind };

export type RestrictedFeature = { kind: RestrictedKind; sourceRef: string; geometry: Polygon | MultiPolygon };

export type RestrictionHit = {
  restrictedAreaId: string;
  kind: RestrictedKind;
  sourceRef: string | null;
  /** Share of the target area inside the restricted area, 0–1; 1 when only the position was tested. */
  share: number;
  anchoringBan: boolean;
};

export type AnchoringBanConfig = { noAnchoringKinds: RestrictedKind[]; protectedAreaAnchoringBan: string[] };

export type UpsertResult = { inserted: number; updated: number; unchanged: number; ended: number };

/** Grid for comparing geometries on re-import (degrees, ≈ 1 cm). */
const SNAP_GRID = 1e-7;

const todayIso = () => new Date().toISOString().slice(0, 10);

/**
 * Reconciles one source layer with `restricted_areas` in one transaction, matching on `source_ref` among rows valid
 * on `today`: same kind and same geometry (compared snapped to 1e-7°) → unchanged; otherwise the kind and geometry
 * of that row are updated in place (the history trigger records the old row); no valid row → inserted (valid from
 * `today`). Valid rows of the layer (`source_ref` starting with `layerPrefix`) that intersect `box` and are missing
 * from the import end on `today`; rows outside `box` stay valid (the import did not look there). Every feature's
 * `sourceRef` must start with `layerPrefix` and be unique.
 */
export async function upsertRestrictedAreas(
  db: Db,
  input: { layerPrefix: string; box: Bbox; features: RestrictedFeature[]; today?: string },
): Promise<UpsertResult> {
  const { layerPrefix } = input;
  if (layerPrefix.length === 0) throw new Error("layerPrefix must not be empty");
  const seen = new Set<string>();
  for (const f of input.features) {
    if (!f.sourceRef.startsWith(layerPrefix)) {
      throw new Error(`sourceRef ${f.sourceRef} does not start with the layer prefix ${layerPrefix}`);
    }
    if (seen.has(f.sourceRef)) throw new Error(`duplicate sourceRef ${f.sourceRef}`);
    seen.add(f.sourceRef);
  }
  const today = input.today ?? todayIso();
  const box = sql`ST_MakeEnvelope(${input.box[0]}::float8, ${input.box[1]}::float8, ${input.box[2]}::float8, ${input.box[3]}::float8, 4326)`;
  const valid = validAt(restrictedAreas, today);
  const bySourceRef = new Map(input.features.map((f) => [f.sourceRef, f]));
  /** CTE `src(kind, source_ref, geom)` over the given features. */
  const srcOf = (features: RestrictedFeature[]) => sql`
    src as (
      select f->>'kind' as kind, f->>'source_ref' as source_ref,
             ST_SetSRID(ST_GeomFromGeoJSON(f->'geometry'), 4326) as geom
      from jsonb_array_elements(${JSON.stringify(
        features.map((f) => ({ kind: f.kind, source_ref: f.sourceRef, geometry: f.geometry })),
      )}::jsonb) f
    )`;

  return db.transaction(async (tx) => {
    const result: UpsertResult = { inserted: 0, updated: 0, unchanged: 0, ended: 0 };

    // Valid rows of the layer in the box that the import no longer contains.
    const { rows: ended } = await tx.execute<{ id: string }>(sql`
      update restricted_areas set valid_to = ${today}::date
      where ${valid}
        and left(restricted_areas.source_ref, length(${layerPrefix})) = ${layerPrefix}
        and restricted_areas.geom && ${box}
        and ST_Intersects(restricted_areas.geom, ${box})
        and restricted_areas.source_ref not in (select jsonb_array_elements_text(${JSON.stringify([...bySourceRef.keys()])}::jsonb))
      returning restricted_areas.id`);
    result.ended = ended.length;
    if (input.features.length === 0) return result;

    const { rows } = await tx.execute<{ source_ref: string; match_id: string | null; same: boolean }>(sql`
      with ${srcOf(input.features)}
      select src.source_ref, m.id as match_id,
             coalesce(m.kind::text = src.kind
               and ST_OrderingEquals(ST_SnapToGrid(m.geom, ${SNAP_GRID}::float8), ST_SnapToGrid(src.geom, ${SNAP_GRID}::float8)),
               false) as same
      from src
      left join lateral (
        select restricted_areas.id, restricted_areas.kind, restricted_areas.geom from restricted_areas
        where restricted_areas.source_ref = src.source_ref and ${valid}
        order by restricted_areas.valid_from desc, restricted_areas.id
        limit 1
      ) m on true`);

    const updates: Array<{ id: string; feature: RestrictedFeature }> = [];
    const inserts: RestrictedFeature[] = [];
    for (const row of rows) {
      const feature = bySourceRef.get(row.source_ref)!;
      if (row.match_id === null) inserts.push(feature);
      else if (row.same) result.unchanged++;
      else updates.push({ id: row.match_id, feature });
    }

    for (const { id, feature } of updates) {
      await tx
        .update(restrictedAreas)
        .set({ kind: feature.kind, geom: sql`${geomFromGeoJson(feature.geometry)}` })
        .where(eq(restrictedAreas.id, id));
      result.updated++;
    }

    if (inserts.length > 0) {
      const inserted = await tx
        .insert(restrictedAreas)
        .values(
          inserts.map((f) => ({
            kind: f.kind,
            geom: sql`${geomFromGeoJson(f.geometry)}`,
            sourceRef: f.sourceRef,
            validFrom: today,
          })),
        )
        .returning({ id: restrictedAreas.id });
      result.inserted = inserted.length;
    }
    return result;
  });
}

/**
 * Whether a restricted area bans anchoring: its kind is one of `noAnchoringKinds`, or it is a `protected_area`
 * whose site code (the part of `sourceRef` after the last `/`) is listed in `protectedAreaAnchoringBan`.
 */
export function isAnchoringBan(kind: RestrictedKind, sourceRef: string | null, cfg: AnchoringBanConfig): boolean {
  if (cfg.noAnchoringKinds.includes(kind)) return true;
  if (kind !== "protected_area" || sourceRef === null) return false;
  const siteCode = sourceRef.slice(sourceRef.lastIndexOf("/") + 1);
  return cfg.protectedAreaAnchoringBan.includes(siteCode);
}

/**
 * All valid restricted areas intersecting `area` (else `position`). `share` = intersection area / area, both over
 * `::geography`; 1 when `area` is null. Sorted by share descending, then kind (enum order), then id.
 */
export async function restrictionHits(
  db: Db,
  target: { area: Geometry | null; position: LonLat },
  cfg: AnchoringBanConfig,
): Promise<RestrictionHit[]> {
  const point = sql`ST_SetSRID(ST_MakePoint(${target.position.lon}::float8, ${target.position.lat}::float8), 4326)`;
  const geom = target.area === null ? point : geomFromGeoJson(target.area);
  const share =
    target.area === null
      ? sql`1::float8`
      : sql`coalesce(ST_Area(ST_Intersection(restricted_areas.geom, t.geom)::geography) / nullif(ST_Area(t.geom::geography), 0), 0)`;
  const { rows } = await db.execute<{ id: string; kind: RestrictedKind; source_ref: string | null; share: number }>(sql`
    with t as (select ${geom} as geom)
    select restricted_areas.id, restricted_areas.kind, restricted_areas.source_ref, ${share} as share
    from restricted_areas, t
    where ${validAt(restrictedAreas)} and restricted_areas.geom && t.geom and ST_Intersects(restricted_areas.geom, t.geom)
    order by share desc, restricted_areas.kind, restricted_areas.id`);
  return rows.map((r) => ({
    restrictedAreaId: r.id,
    kind: r.kind,
    sourceRef: r.source_ref,
    share: Number(r.share),
    anchoringBan: isAnchoringBan(r.kind, r.source_ref, cfg),
  }));
}

/** The first hit that bans anchoring and covers more than `minShare`, else null. */
export function exclusionFor(hits: RestrictionHit[], minShare: number): RestrictionHit | null {
  return hits.find((h) => h.anchoringBan && h.share > minShare) ?? null;
}

/** `status_reason` of a place excluded by a restricted area. */
export function exclusionReason(hit: Pick<RestrictionHit, "kind" | "restrictedAreaId">): string {
  return `restricted:${hit.kind}:${hit.restrictedAreaId}`;
}

export type ExclusionOutcome = "excluded" | "review_opened" | "unchanged";

/**
 * Applies a restricted-area hit to a valid, unmerged place (spec 03/04: only candidates are excluded automatically).
 * - `candidate`: status `no_anchoring`, reason `restricted:<kind>:<id>`, its open `place_candidate` task dismissed
 *   → `excluded`.
 * - `confirmed`: left as is; a `place_candidate` review task (`context.reason = "restricted"`) is opened so the admin
 *   decides → `review_opened`. Not opened again once the admin decided such a task (the decision is sticky), nor
 *   while a task is already open → `unchanged`.
 * - anything else → `unchanged`.
 * Lock order as in `decideReviewTask`: the open task row first, then the place.
 */
export async function applyExclusion(db: Db, placeId: string, hit: RestrictionHit): Promise<ExclusionOutcome> {
  return db.transaction(async (tx) => {
    const [openTask] = await tx
      .select({ id: reviewTasks.id })
      .from(reviewTasks)
      .where(and(eq(reviewTasks.kind, "place_candidate"), eq(reviewTasks.subjectId, placeId), eq(reviewTasks.status, "open")))
      .for("update");
    const [place] = await tx
      .select({ status: places.status })
      .from(places)
      .where(and(eq(places.id, placeId), isNull(places.validTo), isNull(places.mergedIntoId)))
      .for("update");
    if (!place) return "unchanged";

    if (place.status === "candidate") {
      await tx.update(places).set({ status: "no_anchoring", statusReason: exclusionReason(hit) }).where(eq(places.id, placeId));
      if (openTask) await tx.update(reviewTasks).set({ status: "dismissed" }).where(eq(reviewTasks.id, openTask.id));
      return "excluded";
    }
    if (place.status !== "confirmed" || openTask) return "unchanged";
    if (await hasDecidedTask(tx, "place_candidate", placeId, { reason: "restricted" })) return "unchanged";
    const { created } = await createReviewTask(tx, {
      kind: "place_candidate",
      subjectType: "place",
      subjectId: placeId,
      context: {
        reason: "restricted",
        restriction: { kind: hit.kind, id: hit.restrictedAreaId, share: hit.share },
        previousStatus: "confirmed",
      },
    });
    return created ? "review_opened" : "unchanged";
  });
}
