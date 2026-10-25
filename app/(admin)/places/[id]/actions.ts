"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { getConfig } from "@/lib/config";
import { getDb } from "@/lib/db/client";
import { placeStatusEnum } from "@/lib/db/schema";
import { setAnchorPosition } from "@/lib/domain/geometry/anchor-correction";
import { setPlacePosition } from "@/lib/domain/geometry/place-position";
import { placeBelongsTo, placeGeoObjectId } from "@/lib/domain/geo-view";
import { endPlaceImage, PlaceImageNotRemovable } from "@/lib/domain/images/remove";
import { placeImageView } from "@/lib/domain/images/view";
import { mergePlaceInto, PlaceMergeNotAllowed } from "@/lib/domain/place-merge";
import { ADMIN_PLACE_STATUSES, PlaceStatusNotAllowed, setPlaceStatusByAdmin } from "@/lib/domain/place-status";
import { ProfileChanged, removeProfileEntry } from "@/lib/domain/profile-entry-removal";
import { DecisionNotAllowed } from "@/lib/domain/review-decisions";
import { getBoss } from "@/lib/jobs/boss";
import { nextViewSlot, startImageRun } from "@/lib/pipeline/images-run";
import { geometryAfter } from "@/lib/pipeline/follow-ups";
import { requireAdmin } from "@/lib/security/require-admin";
import { RUN_SCOPE_REASON_LABELS } from "../../_components/labels";
import { startAndRedirect } from "../../_components/run-start";

const anchorSchema = z.object({
  placeId: z.uuid(),
  lon: z.coerce.number().min(-180).max(180),
  lat: z.coerce.number().min(-90).max(90),
});

export type SetAnchorResult = { ok: true; runId: string | null; message: string } | { ok: false; error: string };

const fields = (input: FormData | object) => (input instanceof FormData ? Object.fromEntries(input) : input);

/**
 * "Ankerposition übernehmen": sets the admin's anchor position of a place (review fact), then starts a geometry
 * run for that place alone. A position too far from the place is returned as a German error; when the run cannot
 * start for lack of inputs, the anchor stays set and the message says why.
 */
export async function setAnchorAction(
  input: FormData | { placeId: string; lon: number; lat: number },
): Promise<SetAnchorResult> {
  const admin = await requireAdmin();
  const { placeId, lon, lat } = anchorSchema.parse(fields(input));
  const db = getDb();
  try {
    await setAnchorPosition(db, { placeId, position: { lon, lat }, decidedBy: admin.email });
  } catch (e) {
    if (!(e instanceof DecisionNotAllowed)) throw e;
    const maxKm = getConfig().geometry.anchorArea.correctionMaxDistanceM / 1000;
    return { ok: false, error: `Ankerposition zu weit vom Ort entfernt (max. ${maxKm.toLocaleString("de-DE")} km)` };
  }
  revalidatePath(`/places/${placeId}`);
  // the anchor stands whatever the follow-up does (UI-7): never an error page after the commit
  const run = await geometryAfter(db, getBoss, { placeId, triggeredBy: admin.email });
  if (run.status === "started") return { ok: true, runId: run.runId, message: "Ankerposition übernommen, Geometrie wird neu berechnet." };
  return {
    ok: true,
    runId: null,
    message:
      run.status === "not_ready"
        ? `Ankerposition übernommen. Geometrie nicht neu berechnet: ${RUN_SCOPE_REASON_LABELS[run.reason]}.`
        : "Ankerposition übernommen. Die Neuberechnung der Geometrie konnte nicht gestartet werden – bitte im Reiter „Geometrie“ erneut starten.",
  };
}

/**
 * „Position korrigieren“ (ruling M6-H-R1): sets the place point (`setPlacePosition`), the remedy when the package
 * check `spot_location` finds a spot on land or outside the area. After that commit (never inside it) a geometry run
 * for the place recomputes shelter and depths. Back to the geometry tab with
 * `position=moved&run=<id>`, `position=moved_no_run` (the position stands), or `position=too_far`.
 */
export async function setPlacePositionAction(input: FormData | { placeId: string; lon: number; lat: number }): Promise<void> {
  const admin = await requireAdmin();
  const { placeId, lon, lat } = anchorSchema.parse(fields(input));
  const db = getDb();
  const back = `/places/${placeId}?tab=geometry`;
  try {
    await setPlacePosition(db, { placeId, position: { lon, lat }, decidedBy: admin.email });
  } catch (e) {
    if (!(e instanceof DecisionNotAllowed)) throw e;
    return redirect(`${back}&position=too_far`);
  }
  revalidatePath(`/places/${placeId}`);
  const run = await geometryAfter(db, getBoss, { placeId, triggeredBy: admin.email });
  redirect(run.status === "started" ? `${back}&position=moved&run=${run.runId}` : `${back}&position=moved_no_run`);
}

/** `from`: the status the page showed; another status now refuses with `changed` (W4-2). */
const placeStatusSchema = z.object({ placeId: z.uuid(), status: z.enum(ADMIN_PLACE_STATUSES), from: z.enum(placeStatusEnum.enumValues) });

/**
 * „Bestätigen“ / „Verwerfen“ / „Kein Ankerplatz“ in the place header (spec 09, gesamt review UI-3): sets the status
 * (`setPlaceStatusByAdmin`). Back to the place with `?status=<status>`, or
 * with `?statusError=<reason>` when refused.
 */
export async function setPlaceStatusAction(input: FormData | z.input<typeof placeStatusSchema>): Promise<void> {
  const admin = await requireAdmin();
  const f = placeStatusSchema.parse(fields(input));
  const db = getDb();
  let target = `/places/${f.placeId}`;
  try {
    await setPlaceStatusByAdmin(db, { placeId: f.placeId, status: f.status, from: f.from, decidedBy: admin.email });
    target += `?status=${f.status}`;
    revalidatePath(`/places/${f.placeId}`);
  } catch (e) {
    if (!(e instanceof PlaceStatusNotAllowed)) throw e;
    target += `?statusError=${e.reason}`;
  }
  redirect(target);
}
const removeEntrySchema = z.object({
  geoObjectId: z.uuid(),
  attribute: z.string().min(1).max(64),
  entryKey: z.string().min(1).max(2000),
  version: z.coerce.number().int().min(1),
  /** The place page the form is on (it must belong to the geo object); without it the geo page. */
  placeId: z.uuid().optional(),
});

/**
 * „Eintrag entfernen“ on a safety-list entry of the profile tab (place page) or the profile section (geo page): writes
 * the review fact (`removeProfileEntry`) and returns to the attribute with a notice: `entry_removed`, `changed` when the profile has a newer
 * version than the one shown, `error` when the entry cannot be removed.
 */
export async function removeProfileEntryAction(input: FormData | z.input<typeof removeEntrySchema>): Promise<void> {
  const admin = await requireAdmin();
  const raw = fields(input) as Record<string, unknown>;
  const f = removeEntrySchema.parse({ ...raw, placeId: raw.placeId || undefined });
  const db = getDb();
  if (f.placeId && !(await placeBelongsTo(db, f.placeId, f.geoObjectId))) {
    throw new Error(`Place ${f.placeId} does not belong to geo object ${f.geoObjectId}`);
  }
  const back = f.placeId
    ? `/places/${f.placeId}?tab=profile&attr=${encodeURIComponent(f.attribute)}`
    : `/geo/${f.geoObjectId}?attr=${encodeURIComponent(f.attribute)}`;
  let notice: string;
  try {
    await removeProfileEntry(db, { geoObjectId: f.geoObjectId, attribute: f.attribute, entryKey: f.entryKey, version: f.version, decidedBy: admin.email });
    notice = "entry_removed";
    revalidatePath(f.placeId ? `/places/${f.placeId}` : `/geo/${f.geoObjectId}`);
  } catch (e) {
    if (e instanceof ProfileChanged) notice = "changed";
    else if (e instanceof DecisionNotAllowed) notice = "error";
    else throw e;
  }
  redirect(`${back}&notice=${notice}`);
}

const mergeSchema = z.object({
  placeId: z.uuid(),
  intoPlaceId: z.uuid(),
  /** Checkbox „über Landesteilgrenzen“: present when ticked. */
  confirmAcrossSubdivisions: z.union([z.literal("on"), z.literal("true"), z.boolean()]).optional(),
});

/**
 * „Mit Ort zusammenlegen“ of a confirmed place (ruling M6-P15): merges it into the chosen confirmed place
 * (`mergePlaceInto`) and goes to the surviving place with `?merged=<placeId>`. A refusal returns to the place with
 * `?mergeError=<reason>`.
 */
export async function mergePlaceAction(
  input: FormData | { placeId: string; intoPlaceId: string; confirmAcrossSubdivisions?: boolean },
): Promise<void> {
  const admin = await requireAdmin();
  const raw = fields(input) as Record<string, unknown>;
  const f = mergeSchema.parse({ ...raw, confirmAcrossSubdivisions: raw.confirmAcrossSubdivisions || undefined });
  const db = getDb();
  let target: string;
  try {
    await mergePlaceInto(db, {
      placeId: f.placeId,
      intoPlaceId: f.intoPlaceId,
      decidedBy: admin.email,
      confirmAcrossSubdivisions: f.confirmAcrossSubdivisions !== undefined,
    });
    target = `/places/${f.intoPlaceId}?merged=${f.placeId}`;
    revalidatePath(`/places/${f.placeId}`);
    revalidatePath(`/places/${f.intoPlaceId}`);
  } catch (e) {
    if (!(e instanceof PlaceMergeNotAllowed)) throw e;
    target = `/places/${f.placeId}?mergeError=${e.reason}`;
  }
  redirect(target);
}

const addViewSchema = z.object({
  placeId: z.uuid(),
  zoom: z.enum(["z1", "z2", "z3"]),
  /** Optional view bearing the camera rotation starts at: 0-359 degrees; an empty field means the automatic direction. */
  azimuthDeg: z.preprocess((v) => (v === "" || v === undefined ? undefined : v), z.coerce.number().int().min(0).max(359).optional()),
});

/**
 * „Weitere Ansicht erzeugen“ on the image tab: an image run of one more view of the place, in the next free slot
 * (`nextViewSlot`) at the chosen zoom (one the place's core imagery resolution allows) and, optionally, starting the
 * rotation at a view bearing. The run page follows; a refusal returns to the tab with `?error=<reason>`, a zoom the
 * imagery does not support with `?imageError=zoom`.
 */
export async function addPlaceViewAction(input: FormData | z.input<typeof addViewSchema>): Promise<void> {
  const admin = await requireAdmin();
  const f = addViewSchema.parse(fields(input));
  const db = getDb();
  const back = `/places/${f.placeId}?tab=image`;
  const geoObjectId = await placeGeoObjectId(db, f.placeId);
  if (!geoObjectId) throw new Error(`Unknown place ${f.placeId}`);
  if (!(await placeImageView(db, geoObjectId)).zooms.includes(f.zoom)) return redirect(`${back}&imageError=zoom`);
  const boss = await getBoss();
  const view = { slot: await nextViewSlot(db, geoObjectId), zoom: f.zoom, ...(f.azimuthDeg !== undefined ? { azimuthDeg: f.azimuthDeg } : {}) };
  await startAndRedirect(() => startImageRun(db, boss, { geoObjectId, view }, admin.email), back);
}

const removeImageSchema = z.object({ placeId: z.uuid(), imageId: z.uuid() });

/**
 * „Bild entfernen“ on the image tab: ends the image the page showed (`imageId`) via `valid_to`, so it drops out of the
 * next package. An image that is already ended or not the place's (the tab was stale) is refused. Back to the tab with
 * `?imageNotice=removed` or `?imageNotice=changed`.
 */
export async function removePlaceImageAction(input: FormData | z.input<typeof removeImageSchema>): Promise<void> {
  await requireAdmin();
  const f = removeImageSchema.parse(fields(input));
  const back = `/places/${f.placeId}?tab=image`;
  try {
    await endPlaceImage(getDb(), { placeId: f.placeId, imageId: f.imageId });
  } catch (e) {
    if (!(e instanceof PlaceImageNotRemovable)) throw e;
    return redirect(`${back}&imageNotice=changed`);
  }
  revalidatePath(`/places/${f.placeId}`);
  redirect(`${back}&imageNotice=removed`);
}
