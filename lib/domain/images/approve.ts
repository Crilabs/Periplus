import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import sharp from "sharp";
import { z } from "zod";
import type { Archive } from "@/lib/adapters/s3";
import { getConfig, type ImagesConfig, type ZoomLevel } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { geomFromGeoJson } from "@/lib/db/geometry";
import { imageryTiles, placeImages, placeRenders, places, reviewTasks, type ImagerySource } from "@/lib/db/schema";
import { newId } from "@/lib/domain/ids";
import { DecisionNotAllowed, type ReviewDecision } from "@/lib/domain/review-decisions";
import type { ImageView } from "@/lib/pipeline/images/generate";

/*
 * Decisions on a `place_image` review task (spec 13): „Freigeben“ writes the candidate as the slot's current image
 * (`place_images`), „Kein Bild“ ends the slot's current image, „Neu erzeugen“ asks for a new image run of the slot.
 * Every decision leaves the task decided with its key, so the automatic runs do not generate that key again.
 */

type Task = typeof reviewTasks.$inferSelect;

const zoomSchema = z.enum(["z1", "z2", "z3"]);

/** The fields of a `PlaceImageTaskContext` the decisions read (a context that does not parse refuses the decision). */
const contextSchema = z.object({
  key: z.string(),
  slot: z.string(),
  azimuthOverride: z.number().nullable(),
  camera: z
    .object({
      position: z.tuple([z.number(), z.number()]),
      heightM: z.number(),
      viewBearingDeg: z.number(),
      tiltDeg: z.number(),
      fovDeg: z.number(),
    })
    .nullable(),
  renderId: z.uuid().nullable(),
  candidateKey: z.string().nullable(),
  light: z.enum(["midday", "evening"]),
  zoom: zoomSchema,
  model: z.string(),
  promptVersion: z.number(),
  waterIoU: z.number().nullable(),
  alt: z.string(),
  allowedZooms: z.array(zoomSchema),
  reason: z.enum(["no_water_view", "no_valid_output"]).optional(),
});

type ImageTaskContext = z.infer<typeof contextSchema>;

/** What „Neu erzeugen“ asks for after the commit: an image run of the slot, past the decided task's key (`force`). */
export type RegenerateImage = { geoObjectId: string; view: ImageView; force: true };

/** `<geoObjectId>:<slot>` of a place image task and its context; `DecisionNotAllowed` for another shape. */
function imageSubject(task: Task): { geoObjectId: string; slot: string; context: ImageTaskContext } {
  const geoObjectId = task.subjectId.slice(0, 36);
  const slot = task.subjectId.slice(37);
  const context = contextSchema.safeParse(task.context);
  if (!z.uuid().safeParse(geoObjectId).success || task.subjectId[36] !== ":" || !context.success || context.data.slot !== slot) {
    throw new DecisionNotAllowed(`task ${task.id} is no valid place image task`);
  }
  return { geoObjectId, slot, context: context.data };
}

/**
 * The geo object's current place, locked (after the task row, as every decision on a place); `DecisionNotAllowed` when
 * it has none.
 */
async function lockPlaceOf(tx: Db, geoObjectId: string): Promise<{ id: string }> {
  const [place] = await tx
    .select({ id: places.id })
    .from(places)
    .where(and(eq(places.geoObjectId, geoObjectId), isNull(places.validTo), isNull(places.mergedIntoId)))
    .orderBy(places.id)
    .limit(1)
    .for("update");
  if (!place) throw new DecisionNotAllowed(`geo object ${geoObjectId} has no current place`);
  return place;
}

/** Ends the current image of the slot (`valid_to` = `today`); returns its sort order, null when there was none. */
async function endCurrent(tx: Db, geoObjectId: string, slot: string, today: string): Promise<number | null> {
  const ended = await tx
    .update(placeImages)
    .set({ validTo: today })
    .where(and(eq(placeImages.geoObjectId, geoObjectId), eq(placeImages.slot, slot), isNull(placeImages.validTo)))
    .returning({ sortOrder: placeImages.sortOrder });
  return ended[0]?.sortOrder ?? null;
}

type TileRole = "core" | "wide" | "dem";

/**
 * The role of a source in a render: a COG source is terrain (`dem`), a WMS source for every country the wide
 * satellite window (`wide`), any other the detailed core window (`core`, the cadastre).
 */
function roleOf(source: ImagerySource, cfg: Pick<ImagesConfig, "sources">): TileRole {
  const s = (cfg.sources as Partial<Record<ImagerySource, ImagesConfig["sources"][keyof ImagesConfig["sources"]]>>)[source];
  if (s?.kind === "cog") return "dem";
  if (s?.countries === "*") return "wide";
  return "core";
}

const ROLE_ORDER: TileRole[] = ["core", "wide", "dem"];

type TileForAttribution = { source: ImagerySource; blank: boolean; attribution?: string };

/**
 * The attribution of an image: the distinct attribution of every imagery and DEM source the render used (a blank
 * tile is unused), core, wide and DEM in that order, joined with „ · “, then `output.credit`. A tile's own
 * `attribution` (as stored with it) wins over the configured one of its source.
 */
export function attributionFor(tiles: TileForAttribution[], cfg: Pick<ImagesConfig, "sources" | "output">): string {
  const sources = cfg.sources as Partial<Record<ImagerySource, { attribution: string }>>;
  const parts: string[] = [];
  for (const role of ROLE_ORDER) {
    for (const t of tiles) {
      if (t.blank || roleOf(t.source, cfg) !== role) continue;
      const text = t.attribution ?? sources[t.source]?.attribution;
      if (text && !parts.includes(text)) parts.push(text);
    }
  }
  return [...parts, cfg.output.credit].join(" · ");
}

/** When the imagery was taken: the latest acquisition date of the used core tiles, else of the satellite tiles. */
function observedAtOf(tiles: Array<TileForAttribution & { acquiredAt: string | null }>, cfg: Pick<ImagesConfig, "sources">): string | null {
  for (const role of ["core", "wide"] as const) {
    const dates = tiles.filter((t) => !t.blank && roleOf(t.source, cfg) === role && t.acquiredAt !== null).map((t) => t.acquiredAt!);
    if (dates.length > 0) return dates.sort().at(-1)!;
  }
  return null;
}

export type ApproveDeps = { archive: Archive; config?: { images: Pick<ImagesConfig, "sources" | "output"> } };

/**
 * „Freigeben“: the task's candidate becomes the current image of its slot. Locks the place, reads the candidate from
 * the archive, ends the slot's current row (`valid_to` = the decision date) and inserts the new one: the camera
 * columns from `context.camera`, kind `ai_illustration`, rank 3, render, light, model, prompt version, water IoU,
 * generation key and alt text from the context, `observed_at` from the render's imagery (`observedAtOf`),
 * `attribution` (`attributionFor`), `license = output.license` and the decision. Sort order 0 for the title image;
 * a further view keeps the position of the image it replaces, else comes after the highest current one. The candidate
 * is copied to `images/places/<geoObjectId>/<placeImageId>.jpg`. `DecisionNotAllowed` for a task without candidate
 * (`reason`, no camera or render).
 */
export async function approvePlaceImage(tx: Db, task: Task, decisionId: string, now: Date, deps: ApproveDeps): Promise<{ placeImageId: string }> {
  const { geoObjectId, slot, context } = imageSubject(task);
  if (context.reason || !context.candidateKey || !context.camera || !context.renderId) {
    throw new DecisionNotAllowed(`place image task ${task.id} has no candidate to approve`);
  }
  const images = (deps.config ?? getConfig()).images;
  await lockPlaceOf(tx, geoObjectId);

  const [render] = await tx
    .select({ imageryTileIds: placeRenders.imageryTileIds, demTileIds: placeRenders.demTileIds })
    .from(placeRenders)
    .where(and(eq(placeRenders.id, context.renderId), eq(placeRenders.geoObjectId, geoObjectId)));
  if (!render) throw new DecisionNotAllowed(`render ${context.renderId} of task ${task.id} does not exist`);
  const tileIds = [...render.imageryTileIds, ...render.demTileIds];
  const tiles =
    tileIds.length === 0
      ? []
      : await tx
          .select({ source: imageryTiles.source, blank: imageryTiles.blank, attribution: imageryTiles.attribution, acquiredAt: imageryTiles.acquiredAt })
          .from(imageryTiles)
          .where(inArray(imageryTiles.id, tileIds));

  const bytes = await deps.archive.get(context.candidateKey);
  if (!bytes) throw new DecisionNotAllowed(`candidate ${context.candidateKey} of task ${task.id} is missing in the archive`);
  const meta = await sharp(bytes).metadata();
  if (!meta.width || !meta.height) throw new DecisionNotAllowed(`candidate ${context.candidateKey} is no readable image`);

  const today = now.toISOString().slice(0, 10);
  const replaced = await endCurrent(tx, geoObjectId, slot, today);
  let sortOrder = 0;
  if (slot !== "title") {
    if (replaced !== null) sortOrder = replaced;
    else {
      const [row] = await tx
        .select({ highest: sql<number | null>`max(${placeImages.sortOrder})` })
        .from(placeImages)
        .where(and(eq(placeImages.geoObjectId, geoObjectId), isNull(placeImages.validTo)));
      sortOrder = Math.max(row?.highest ?? 0, 0) + 1;
    }
  }

  const id = newId();
  const fileKey = `images/places/${geoObjectId}/${id}.jpg`;
  const camera = context.camera;
  await tx.insert(placeImages).values({
    id,
    geoObjectId,
    kind: "ai_illustration",
    slot,
    sortOrder,
    cameraPosition: sql`${geomFromGeoJson({ type: "Point", coordinates: camera.position })}`,
    cameraHeightM: camera.heightM,
    viewBearingDeg: camera.viewBearingDeg,
    cameraTiltDeg: camera.tiltDeg,
    cameraFovDeg: camera.fovDeg,
    rank: 3,
    renderId: context.renderId,
    light: context.light,
    model: context.model,
    promptVersion: String(context.promptVersion),
    waterIou: context.waterIoU,
    fileKey,
    width: meta.width,
    height: meta.height,
    alt: context.alt,
    generationKey: context.key,
    attribution: attributionFor(tiles, images),
    license: images.output.license,
    observedAt: observedAtOf(tiles, images),
    reviewDecisionId: decisionId,
    validFrom: today,
  });
  await deps.archive.put(fileKey, bytes, "image/jpeg");
  return { placeImageId: id };
}

/**
 * Applies a decision on a `place_image` task (after the task row is locked and decided):
 * - `approve_image`: `approvePlaceImage`;
 * - `no_image`: ends the slot's current image (other slots stay) when the task has a candidate; a task without one
 *   (`reason`, no candidate key) leaves the current image as it is. Either way the decided task keeps the key, so this
 *   slot is not generated again for it;
 * - `regenerate_image`: an image run of the same slot and rotation start at `zoom` (default the task's), which must be
 *   one of `allowedZooms` (any configured level when the task has none, e.g. `no_water_view`). The key includes the
 *   zoom, but the same zoom gives the same key, which the decided task now marks done: the run carries `force`, which
 *   passes over a decided task with that key (never over an open task or a current image).
 * Returns the image run to start after the commit, or null.
 */
export async function applyPlaceImageDecision(
  tx: Db,
  task: Task,
  decision: ReviewDecision,
  decisionId: string,
  now: Date,
  deps: Partial<ApproveDeps>,
): Promise<RegenerateImage | null> {
  const { geoObjectId, slot, context } = imageSubject(task);
  switch (decision.action) {
    case "approve_image":
      if (!deps.archive) throw new Error("approving a place image needs deps.archive");
      await approvePlaceImage(tx, task, decisionId, now, { archive: deps.archive, config: deps.config });
      return null;
    case "no_image":
      await lockPlaceOf(tx, geoObjectId);
      // a task without candidate (`reason`, or no candidate key) declines nothing that exists: the slot's current
      // image stays; with a candidate „Kein Bild“ ends it
      if (!context.reason && context.candidateKey !== null) await endCurrent(tx, geoObjectId, slot, now.toISOString().slice(0, 10));
      return null;
    case "regenerate_image": {
      const zoom: ZoomLevel = decision.zoom ?? context.zoom;
      const configured = Object.keys(getConfig().images.camera.zooms) as ZoomLevel[];
      const allowed = context.allowedZooms.length > 0 ? context.allowedZooms : configured;
      if (!allowed.includes(zoom)) throw new DecisionNotAllowed(`zoom ${zoom} is not allowed for task ${task.id} (${allowed.join(", ")})`);
      await lockPlaceOf(tx, geoObjectId);
      const view: ImageView = { slot, zoom, ...(context.azimuthOverride !== null ? { azimuthDeg: context.azimuthOverride } : {}) };
      return { geoObjectId, view, force: true };
    }
    default:
      throw new DecisionNotAllowed(`action ${decision.action} does not fit a place image`);
  }
}
