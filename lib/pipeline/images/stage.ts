import { sql, type SQL } from "drizzle-orm";
import { simulationActive } from "@/lib/adapters/simulation";
import { getConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { getEnv, type Env } from "@/lib/env";
import { loadPlaceImageInput } from "@/lib/domain/images/place-input";
import { planRender } from "@/lib/domain/images/render-plan";
import { subdivisionByKey } from "@/lib/domain/subdivisions/store";
import type { JobData } from "@/lib/jobs/worker";
import { createLogger } from "@/lib/logger";
import { aerialIds, initialZoom, keyDone, keyFor, resolveView, titleView, type ImageStageConfig, type ImageView } from "./generate";
import { currentAerialTiles } from "./imagery";
import { imageModelAvailable } from "./model";

let logger: ReturnType<typeof createLogger> | undefined;
const getLog = () => (logger ??= createLogger("images.place"));

/*
 * Plan of stage `images.place` (spec 13): which places of a run get an image generated. A run started for images
 * (`startImageRun`) names a subdivision or one place and view in `params.images`; the follow-up run of confirmed
 * berths names their objects (`images.geoObjectIds`). A run without `params.images` has no targets.
 */

/**
 * `params.images` of a run from `startImageRun`. `force` (one place and view, after „Neu erzeugen“): a decided task
 * with the view's key does not make it done (`keyDone`).
 */
export type ImageRunScope = { subdivisionKey: string } | { geoObjectId: string; view: ImageView; force?: boolean } | { geoObjectIds: string[] };

export type ImageTarget = { geoObjectId: string; view: ImageView; force?: true };

/**
 * Of the objects `scope` selects, the spots that get images, sorted by id: a current, unmerged place with status in
 * `delivery.spots.statuses` (any kind: anchorage, mooring field, marina, port) and a public id (so images follow delivery
 * exactly: a seed-excluded place without one is not delivered, spec 17), a fetch computation (without one the
 * camera has no direction; the next geometry run brings the place in) and a subdivision whose country has a core
 * source (the cadastre: Greece in Stufe 1).
 */
async function eligibleSpots(db: Db, scope: SQL, cfg: ImageStageConfig): Promise<string[]> {
  const statuses = `{${cfg.delivery.spots.statuses.join(",")}}`;
  const countries = cfg.images.sources.ktimatologio.countries;
  const country = countries === "*" ? sql`true` : sql`s.country = any(${`{${countries.join(",")}}`}::text[])`;
  const { rows } = await db.execute<{ id: string }>(sql`
    select distinct p.geo_object_id as id
    from places p
    join geo_objects o on o.id = p.geo_object_id and o.valid_to is null and o.merged_into_id is null
    join subdivisions s on s.id = o.subdivision_id
    where ${scope} and p.valid_to is null and p.merged_into_id is null
      and p.status::text = any(${statuses}::text[])
      and p.public_id is not null
      and ${country}
      and exists (select 1 from computations c where c.geo_object_id = p.geo_object_id and c.kind = 'fetch')
    order by p.geo_object_id`);
  return rows.map((r) => r.id);
}

const inIds = (ids: string[]) => sql`p.geo_object_id in (select value::uuid from jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb))`;

/**
 * The generation key `generatePlaceImage` would compute for `view` of the place now, without any request: the camera
 * from `planRender` at the view's zoom (else the wanted title zoom), the current aerial tiles of the windows around
 * its target and, for a title view, the zoom they allow (`resolveView` with `currentAerialTiles`, the job's steps).
 * `null` when the place has no input or one of the tiles is missing (new imagery, so a new key).
 */
async function plannedKey(db: Db, geoObjectId: string, view: ImageView, cfg: ImageStageConfig): Promise<string | null> {
  const place = await loadPlaceImageInput(db, geoObjectId, cfg.images);
  if (!place || !place.country) return null;
  const country = place.country;
  const zoom = initialZoom(place, view, cfg.images);
  const plan = await planRender(db, place, zoom, cfg.images, view.azimuthDeg ?? null);
  if (!plan.ok) return keyFor(place, { ...view, zoom }, [], cfg);
  const resolved = await resolveView(db, place, view, { zoom, camera: plan.camera }, cfg.images, (target) =>
    currentAerialTiles(db, { lon: target.lon, lat: target.lat, country }, cfg.images),
  );
  if (resolved === null) return null;
  return keyFor(place, { ...view, zoom: resolved.zoom }, resolved.ok ? aerialIds(resolved.imagery) : [], cfg);
}

/**
 * The images a run generates, at most `images.pipeline.maxGenerationsPerRun`. Candidates: for a run from
 * `startImageRun` the title images of the subdivision's spots, or the one place and view it names; for the follow-up
 * run of confirmed berths (`params.images.geoObjectIds`) the title images of those objects; for any other run
 * none. Of those, the eligible spots
 * (`eligibleSpots`) whose current generation key is not done yet (`keyDone`: a current image of the slot, an open or a
 * decided task with that key; a forced scope passes over the decided task). Since the key depends on the imagery tiles, it is computed from the current
 * `imagery_tiles` rows of the windows around the camera target; a missing tile makes the key new. None in an
 * evaluation run or a simulation (no paid image calls there), and none (logged once per plan) while no image model
 * is usable (`imageModelAvailable`: the model this process set, else `env.OPENAI_API_KEY`; the web server plans the
 * first stage of a run it starts), so no run downloads imagery and renders for nothing.
 */
export async function imageTargets(
  db: Db,
  run: { id: string; params: Record<string, unknown> },
  cfg: ImageStageConfig = getConfig(),
  env: Pick<Env, "OPENAI_API_KEY"> = getEnv(),
): Promise<ImageTarget[]> {
  if (run.params.evaluation === true || simulationActive()) return [];
  if (!imageModelAvailable(db, env)) {
    getLog().warn({ runId: run.id }, "no usable image model (OPENAI_API_KEY missing?): the run generates no place images");
    return [];
  }
  const scope = run.params.images as ImageRunScope | undefined;
  if (!scope) return [];
  let candidates: ImageTarget[];
  if (scope && "geoObjectId" in scope) {
    const ok = await eligibleSpots(db, inIds([scope.geoObjectId]), cfg);
    candidates = ok.map((geoObjectId) => ({ geoObjectId, view: scope.view, ...(scope.force === true ? { force: true as const } : {}) }));
  } else if (scope && "geoObjectIds" in scope) {
    const ids = scope.geoObjectIds.length === 0 ? [] : await eligibleSpots(db, inIds(scope.geoObjectIds), cfg);
    const view = titleView();
    candidates = ids.map((geoObjectId) => ({ geoObjectId, view }));
  } else {
    const sub = await subdivisionByKey(db, scope.subdivisionKey);
    if (!sub) return [];
    const ids = await eligibleSpots(db, sql`o.subdivision_id = ${sub.id}::uuid`, cfg);
    const view = titleView();
    candidates = ids.map((geoObjectId) => ({ geoObjectId, view }));
  }

  const targets: ImageTarget[] = [];
  for (const c of candidates) {
    if (targets.length >= cfg.images.pipeline.maxGenerationsPerRun) break;
    const key = await plannedKey(db, c.geoObjectId, c.view, cfg);
    if (key !== null && (await keyDone(db, c.geoObjectId, c.view.slot, key, c.force))) continue;
    targets.push(c);
  }
  return targets;
}

/** One job per target, key `<geoObjectId>:<slot>`; a forced target's job carries `force`. */
export async function imageJobs(db: Db, run: { id: string; params: Record<string, unknown> }): Promise<JobData[]> {
  return (await imageTargets(db, run)).map((t) => ({
    key: `${t.geoObjectId}:${t.view.slot}`,
    geoObjectId: t.geoObjectId,
    view: t.view,
    ...(t.force ? { force: true } : {}),
  }));
}

/**
 * The slot of a further view of the place: `view-<n>` with n one above the highest view slot of its current images
 * and open `place_image` tasks (`view-2` for the first, the title image counting as the first view).
 */
export async function nextViewSlot(db: Db, geoObjectId: string): Promise<string> {
  const { rows } = await db.execute<{ slot: string }>(sql`
    select slot from place_images where geo_object_id = ${geoObjectId} and valid_to is null
    union all
    select substr(subject_id, length(${geoObjectId}) + 2) from review_tasks
    where kind = 'place_image' and status = 'open' and subject_id like ${`${geoObjectId}:%`}`);
  let highest = 1;
  for (const { slot } of rows) {
    const m = /^view-(\d+)$/.exec(slot);
    if (m) highest = Math.max(highest, Number(m[1]));
  }
  return `view-${highest + 1}`;
}
