import { sql } from "drizzle-orm";
import { getConfig, type ImagesConfig, type ZoomLevel } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { imageBlockedBy, imageSources } from "./delivery-gate";
import { allowedZooms } from "./render-plan";

/*
 * What the admin shows of a place's images (tab „Bilder“) and of a Landesteil's image coverage (spec 13, UI-Anteil).
 */

export type ImageCamera = { position: { lon: number; lat: number }; heightM: number; viewBearingDeg: number; tiltDeg: number; fovDeg: number };

export type CurrentImage = {
  id: string;
  slot: string;
  sortOrder: number;
  kind: "photo" | "ai_illustration";
  light: "midday" | "evening" | null;
  alt: string;
  attribution: string | null;
  observedAt: string | null;
  fileKey: string;
  waterIoU: number | null;
  approvedAt: string;
  camera: ImageCamera | null;
  render: { photoKey: string; maskKey: string } | null;
  /** Sources of its render whose images are not delivered (`images.delivery`); empty when it can be delivered. */
  blockedBy: string[];
};

export type ImageCandidate = { taskId: string; slot: string; candidateKey: string; waterIoU: number | null; passed: boolean; light: "midday" | "evening" | null };

export type PlaceImageView = {
  /** The title image, else the first current one. */
  current: CurrentImage | null;
  /** Every current image of the place, by sort order. */
  images: CurrentImage[];
  /** The first open `place_image` task with a candidate (a draft waiting for approval); `null` without one. */
  candidate: ImageCandidate | null;
  candidates: ImageCandidate[];
  /** The newest render of the place, with its camera as stored. */
  latestRender: { photoKey: string; maskKey: string; camera: unknown } | null;
  /** `current` exists and no source it builds on is blocked. */
  deliverable: boolean;
  blockedBy: string[];
  /** Zoom levels a further view may use: those the place's core imagery resolution supports, else all configured. */
  zooms: ZoomLevel[];
};

/**
 * Whether a country has a detailed (core) aerial source: a WMS source with an explicit country list naming it (the
 * cadastre; a source for every country, `"*"`, is the wide satellite window). Only such a country's spots get images
 * (`eligibleSpots`), so only its Landesteile offer „Titelbilder erzeugen“.
 */
export function hasCoreImagery(country: string, cfg: Pick<ImagesConfig, "sources"> = getConfig().images): boolean {
  return Object.values(cfg.sources).some((s) => s.kind === "wms" && s.countries !== "*" && s.countries.includes(country));
}

/** Per place image the sources of its render whose images `images.delivery` does not deliver (sorted); `[]` when deliverable. */
async function blockedSources(db: Db, placeImageIds: string[], cfg: Pick<ImagesConfig, "delivery">): Promise<Map<string, string[]>> {
  const sources = await imageSources(db, placeImageIds);
  return new Map([...sources].map(([id, list]) => [id, imageBlockedBy(list, cfg.delivery)]));
}

type ImageRow = {
  id: string;
  slot: string;
  sort_order: number;
  kind: CurrentImage["kind"];
  light: CurrentImage["light"];
  alt: string;
  attribution: string | null;
  observed_at: string | Date | null;
  file_key: string;
  water_iou: number | null;
  valid_from: string | Date;
  lon: number | null;
  lat: number | null;
  camera_height_m: number | null;
  view_bearing_deg: number | null;
  camera_tilt_deg: number | null;
  camera_fov_deg: number | null;
  photo_key: string | null;
  mask_key: string | null;
};

const day = (d: string | Date) => (typeof d === "string" ? d : d.toISOString()).slice(0, 10);

/** The first non-blank core (detailed) tile resolution under the place, or null: the zoom levels follow from it. */
async function coreResolutionM(db: Db, geoObjectId: string, cfg: Pick<ImagesConfig, "sources">): Promise<number | null> {
  const core = Object.entries(cfg.sources)
    .filter(([, s]) => s.kind === "wms" && s.countries !== "*")
    .map(([source]) => source);
  if (core.length === 0) return null;
  const { rows } = await db.execute<{ resolution_m: number | null }>(sql`
    select min(t.resolution_m) as resolution_m
    from places p
    join imagery_tiles t on t.valid_to is null and not t.blank and t.source::text = any(${`{${core.join(",")}}`}::text[])
      and ST_Intersects(t.bbox, p.position)
    where p.geo_object_id = ${geoObjectId} and p.valid_to is null and p.merged_into_id is null`);
  return rows[0]?.resolution_m ?? null;
}

/**
 * The images of a place for its tab: every current `place_images` row (title first, by sort order) with camera, render
 * and the sources that block its delivery, the open task's candidate (a draft: the generated image shows right away),
 * the newest render and the zoom levels a further view may use.
 */
export async function placeImageView(db: Db, geoObjectId: string, cfg: Pick<ImagesConfig, "delivery" | "sources" | "camera" | "render"> = getConfig().images): Promise<PlaceImageView> {
  const { rows } = await db.execute<ImageRow>(sql`
    select pi.id, pi.slot, pi.sort_order, pi.kind, pi.light, pi.alt, pi.attribution, pi.observed_at, pi.file_key, pi.water_iou, pi.valid_from,
           ST_X(pi.camera_position) as lon, ST_Y(pi.camera_position) as lat, pi.camera_height_m, pi.view_bearing_deg,
           pi.camera_tilt_deg, pi.camera_fov_deg, r.photo_key, r.mask_key
    from place_images pi left join place_renders r on r.id = pi.render_id
    where pi.geo_object_id = ${geoObjectId} and pi.valid_to is null
    order by pi.sort_order, pi.slot`);
  const blocked = await blockedSources(db, rows.map((r) => r.id), cfg);
  const images: CurrentImage[] = rows.map((r) => ({
    id: r.id,
    slot: r.slot,
    sortOrder: r.sort_order,
    kind: r.kind,
    light: r.light,
    alt: r.alt,
    attribution: r.attribution,
    observedAt: r.observed_at === null ? null : day(r.observed_at),
    fileKey: r.file_key,
    waterIoU: r.water_iou,
    approvedAt: day(r.valid_from),
    camera:
      r.lon === null || r.lat === null || r.camera_height_m === null || r.view_bearing_deg === null || r.camera_tilt_deg === null || r.camera_fov_deg === null
        ? null
        : { position: { lon: r.lon, lat: r.lat }, heightM: r.camera_height_m, viewBearingDeg: r.view_bearing_deg, tiltDeg: r.camera_tilt_deg, fovDeg: r.camera_fov_deg },
    render: r.photo_key && r.mask_key ? { photoKey: r.photo_key, maskKey: r.mask_key } : null,
    blockedBy: blocked.get(r.id) ?? [],
  }));
  const current = images.find((i) => i.slot === "title") ?? images[0] ?? null;

  const { rows: taskRows } = await db.execute<{ id: string; context: Record<string, unknown> }>(sql`
    select id, context from review_tasks
    where kind = 'place_image' and status = 'open' and subject_id like ${`${geoObjectId}:%`}
    order by created_at, id`);
  const candidates = taskRows.flatMap((t): ImageCandidate[] => {
    const c = t.context;
    if (typeof c.candidateKey !== "string") return [];
    return [
      {
        taskId: t.id,
        slot: typeof c.slot === "string" ? c.slot : "title",
        candidateKey: c.candidateKey,
        waterIoU: typeof c.waterIoU === "number" ? c.waterIoU : null,
        passed: c.passed === true,
        light: c.light === "midday" || c.light === "evening" ? c.light : null,
      },
    ];
  });

  const { rows: renderRows } = await db.execute<{ photo_key: string; mask_key: string; camera: unknown }>(sql`
    select photo_key, mask_key, camera from place_renders where geo_object_id = ${geoObjectId} order by created_at desc, id desc limit 1`);
  const resolution = await coreResolutionM(db, geoObjectId, cfg);
  const configured = Object.keys(cfg.camera.zooms) as ZoomLevel[];
  const blockedBy = current?.blockedBy ?? [];
  return {
    current,
    images,
    candidate: candidates[0] ?? null,
    candidates,
    latestRender: renderRows[0] ? { photoKey: renderRows[0].photo_key, maskKey: renderRows[0].mask_key, camera: renderRows[0].camera } : null,
    deliverable: current !== null && blockedBy.length === 0,
    blockedBy,
    zooms: resolution === null ? configured : allowedZooms(resolution, cfg),
  };
}

export type ImageCoverage = {
  spots: number;
  withImagery: number;
  withApprovedImage: number;
  deliverable: number;
  medianWaterIoU: number | null;
  rejectedShare: number | null;
  imageryCostEur: number;
  generationCostEur: number;
};

/**
 * The image coverage of a Landesteil. `spots`: its current, unmerged places with a status in `delivery.spots.statuses`.
 * `withImagery`: spots under a non-blank core tile (the detailed source); `withApprovedImage`: spots with a current
 * image; `deliverable`: of those, spots with a current image none of whose sources is blocked. `medianWaterIoU` over the
 * current images; `rejectedShare`: decided `place_image` tasks whose decision is „Kein Bild“ over all decided ones.
 * Costs: `imagery_tiles.cost_eur` of the tiles the spots' renders used, and `external_calls` of service `openai` made
 * for one of the spots (`meta.geoObjectId`, which the image edit records), whatever run made them: a consolidation
 * run over a tile pays for the title images of the places it confirmed, too.
 */
export async function imageCoverage(db: Db, subdivisionId: string, cfg: Pick<ImagesConfig, "delivery" | "sources"> = getConfig().images, spotStatuses: string[] = getConfig().delivery.spots.statuses): Promise<ImageCoverage> {
  const statuses = `{${spotStatuses.join(",")}}`;
  const core = Object.entries(cfg.sources)
    .filter(([, s]) => s.kind === "wms" && s.countries !== "*")
    .map(([source]) => source);
  const spotsSql = sql`
    select p.id as place_id, p.geo_object_id, p.position
    from places p join geo_objects o on o.id = p.geo_object_id
    where o.subdivision_id = ${subdivisionId} and p.valid_to is null and p.merged_into_id is null
      and p.status::text = any(${statuses}::text[])`;
  const { rows: spotRows } = await db.execute<{ spots: number; with_imagery: number; with_image: number; median: number | null }>(sql`
    with spot as (${spotsSql})
    select (select count(*)::int from spot) as spots,
           (select count(*)::int from spot s where exists (
              select 1 from imagery_tiles t
              where t.valid_to is null and not t.blank and t.source::text = any(${`{${core.join(",")}}`}::text[]) and ST_Intersects(t.bbox, s.position))) as with_imagery,
           (select count(distinct s.geo_object_id)::int from spot s join place_images i on i.geo_object_id = s.geo_object_id and i.valid_to is null) as with_image,
           (select percentile_cont(0.5) within group (order by i.water_iou)
              from spot s join place_images i on i.geo_object_id = s.geo_object_id and i.valid_to is null) as median`);
  const { rows: imageRows } = await db.execute<{ id: string; geo_object_id: string }>(sql`
    with spot as (${spotsSql})
    select i.id, i.geo_object_id from spot s join place_images i on i.geo_object_id = s.geo_object_id and i.valid_to is null`);
  const blocked = await blockedSources(db, imageRows.map((r) => r.id), cfg);
  const deliverable = new Set(imageRows.filter((r) => blocked.get(r.id)!.length === 0).map((r) => r.geo_object_id)).size;

  const { rows: reviewRows } = await db.execute<{ decided: number; rejected: number }>(sql`
    with spot as (${spotsSql})
    select count(*)::int as decided, count(*) filter (where d.decision->>'action' = 'no_image')::int as rejected
    from review_tasks t
    join review_decisions d on d.task_id = t.id
    where t.kind = 'place_image' and t.status = 'decided' and substr(t.subject_id, 1, 36) in (select geo_object_id::text from spot)`);
  const { rows: costRows } = await db.execute<{ imagery: string | number; generation: string | number }>(sql`
    with spot as (${spotsSql}),
    used as (
      select distinct u.tile_id from spot s
      join place_renders r on r.geo_object_id = s.geo_object_id
      cross join lateral unnest(r.imagery_tile_ids || r.dem_tile_ids) as u(tile_id)
    )
    select (select coalesce(sum(t.cost_eur), 0) from imagery_tiles t where t.id in (select tile_id from used)) as imagery,
           (select coalesce(sum(e.cost_eur), 0) from external_calls e
            where e.service = 'openai' and e.meta->>'geoObjectId' in (select s.geo_object_id::text from spot s)) as generation`);
  const s = spotRows[0]!;
  const decided = reviewRows[0]?.decided ?? 0;
  return {
    spots: s.spots,
    withImagery: s.with_imagery,
    withApprovedImage: s.with_image,
    deliverable,
    medianWaterIoU: s.median === null ? null : Number(s.median),
    rejectedShare: decided === 0 ? null : (reviewRows[0]?.rejected ?? 0) / decided,
    imageryCostEur: Number(costRows[0]?.imagery ?? 0),
    generationCostEur: Number(costRows[0]?.generation ?? 0),
  };
}
