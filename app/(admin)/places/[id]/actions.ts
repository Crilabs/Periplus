"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { getConfig } from "@/lib/config";
import { getDb } from "@/lib/db/client";
import { setAnchorPosition } from "@/lib/domain/geometry/anchor-correction";
import { setPlacePosition } from "@/lib/domain/geometry/place-position";
import { placeBelongsTo, placeGeoObjectId } from "@/lib/domain/geo-view";
import { mergePlaceInto, PlaceMergeNotAllowed } from "@/lib/domain/place-merge";
import { ADMIN_PLACE_STATUSES, PlaceStatusNotAllowed, setPlaceStatusByAdmin } from "@/lib/domain/place-status";
import { ProfileChanged, removeProfileEntry } from "@/lib/domain/profile-entry-removal";
import { DecisionNotAllowed } from "@/lib/domain/review-decisions";
import { getBoss } from "@/lib/jobs/boss";
import { startConsolidationRun } from "@/lib/pipeline/consolidation/run";
import { CONSOLIDATION_SUMMARY_STAGE } from "@/lib/pipeline/consolidation/stages";
import { afterPlaceMerge, afterPositionChange, consolidateAfter, geometryAfter } from "@/lib/pipeline/follow-ups";
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
 * for the place recomputes shelter and depths and consolidates the profile; when the place lacks geometry inputs, a
 * consolidation run takes the new position into the profile instead. Back to the geometry tab with
 * `position=moved&run=<id>`, `position=moved_no_run` (the position stands), or `position=too_far`.
 */
export async function setPlacePositionAction(input: FormData | { placeId: string; lon: number; lat: number }): Promise<void> {
  const admin = await requireAdmin();
  const { placeId, lon, lat } = anchorSchema.parse(fields(input));
  const db = getDb();
  const back = `/places/${placeId}?tab=geometry`;
  let moved: { geoObjectId: string };
  try {
    moved = await setPlacePosition(db, { placeId, position: { lon, lat }, decidedBy: admin.email });
  } catch (e) {
    if (!(e instanceof DecisionNotAllowed)) throw e;
    return redirect(`${back}&position=too_far`);
  }
  revalidatePath(`/places/${placeId}`);
  const run = await afterPositionChange(db, getBoss, { placeId, geoObjectId: moved.geoObjectId, triggeredBy: admin.email });
  redirect(run.status === "started" ? `${back}&position=moved&run=${run.runId}` : `${back}&position=moved_no_run`);
}

const placeSchema = z.object({ placeId: z.uuid() });
const placeStatusSchema = z.object({ placeId: z.uuid(), status: z.enum(ADMIN_PLACE_STATUSES) });

/**
 * „Bestätigen“ / „Verwerfen“ / „Kein Ankerplatz“ in the place header (spec 09, gesamt review UI-3): sets the status
 * (`setPlaceStatusByAdmin`), then, after that commit, a consolidation run takes it into the profile. Back to the place
 * with `?status=<status>` (and `&run=<id>`, or `&statusNoRun=1` when the run did not start: the status stands), or
 * with `?statusError=<reason>` when refused.
 */
export async function setPlaceStatusAction(input: FormData | z.input<typeof placeStatusSchema>): Promise<void> {
  const admin = await requireAdmin();
  const f = placeStatusSchema.parse(fields(input));
  const db = getDb();
  let target = `/places/${f.placeId}`;
  try {
    const { geoObjectId } = await setPlaceStatusByAdmin(db, { placeId: f.placeId, status: f.status, decidedBy: admin.email });
    const run = await consolidateAfter(db, getBoss, { geoObjectIds: [geoObjectId], triggeredBy: admin.email });
    target += `?status=${f.status}${run.status === "started" ? `&run=${run.runId}` : "&statusNoRun=1"}`;
    revalidatePath(`/places/${f.placeId}`);
  } catch (e) {
    if (!(e instanceof PlaceStatusNotAllowed)) throw e;
    target += `?statusError=${e.reason}`;
  }
  redirect(target);
}
const geoObjectSchema = z.object({ geoObjectId: z.uuid() });

/**
 * "Profil neu berechnen" of a place: a consolidation run for the place's geo object (scope `place`); a refusal
 * returns to the place page with `?error=<reason>`.
 */
export async function recomputePlaceProfileAction(input: FormData | { placeId: string }): Promise<void> {
  const admin = await requireAdmin();
  const { placeId } = placeSchema.parse(fields(input));
  const db = getDb();
  const geoObjectId = await placeGeoObjectId(db, placeId);
  if (!geoObjectId) throw new Error(`Unknown place ${placeId}`);
  const boss = await getBoss();
  await startAndRedirect(
    () => startConsolidationRun(db, boss, { scope: { geoObjectIds: [geoObjectId] }, triggeredBy: admin.email }),
    `/places/${placeId}`,
  );
}

/**
 * "Profil neu berechnen" of a geo object (geo page): a consolidation run for that object; a refusal returns to the
 * geo page with `?error=<reason>`.
 */
export async function recomputeGeoProfileAction(input: FormData | { geoObjectId: string }): Promise<void> {
  const admin = await requireAdmin();
  const { geoObjectId } = geoObjectSchema.parse(fields(input));
  const db = getDb();
  const boss = await getBoss();
  await startAndRedirect(
    () => startConsolidationRun(db, boss, { scope: { geoObjectIds: [geoObjectId] }, triggeredBy: admin.email }),
    `/geo/${geoObjectId}`,
  );
}

const regenerateSummarySchema = z.object({
  geoObjectId: z.uuid(),
  /** The place page the form is on (it must belong to the geo object); without it the geo page. */
  placeId: z.uuid().optional(),
});

/**
 * „Summary neu erzeugen“ on the profile tab (ruling M6-H-R1): a consolidation run of only the summary stage for the
 * object that writes a new summary of its newest profile version even when an `ok` one exists (e.g. one the package
 * check `verbatim_text` rejects); the run page follows. Nothing is decided or written before the run starts. A refusal
 * returns to the page with `?error=<reason>`.
 */
export async function regenerateSummaryAction(input: FormData | z.input<typeof regenerateSummarySchema>): Promise<void> {
  const admin = await requireAdmin();
  const raw = fields(input) as Record<string, unknown>;
  const f = regenerateSummarySchema.parse({ ...raw, placeId: raw.placeId || undefined });
  const db = getDb();
  if (f.placeId && !(await placeBelongsTo(db, f.placeId, f.geoObjectId))) {
    throw new Error(`Place ${f.placeId} does not belong to geo object ${f.geoObjectId}`);
  }
  const boss = await getBoss();
  await startAndRedirect(
    () =>
      startConsolidationRun(db, boss, {
        scope: { geoObjectIds: [f.geoObjectId] },
        triggeredBy: admin.email,
        stagesOnly: [CONSOLIDATION_SUMMARY_STAGE],
        regenerateSummary: true,
      }),
    f.placeId ? `/places/${f.placeId}` : `/geo/${f.geoObjectId}`,
  );
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
 * the review fact (`removeProfileEntry`), then, after that commit, starts a consolidation run for the object (never
 * inside the decision, ruling M5-F-R4) and returns to the attribute with a notice: `entry_removed` (with `run`),
 * `entry_removed_no_run` when the run did not start (the removal stands), `changed` when the profile has a newer
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
    const run = await consolidateAfter(db, getBoss, { geoObjectIds: [f.geoObjectId], triggeredBy: admin.email });
    notice = run.status === "started" ? `entry_removed&run=${run.runId}` : "entry_removed_no_run";
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
  /** Checkbox „über Reviergrenzen“: present when ticked. */
  confirmAcrossAreas: z.union([z.literal("on"), z.literal("true"), z.boolean()]).optional(),
});

/**
 * „Mit Ort zusammenlegen“ of a confirmed place (ruling M6-P15): merges it into the chosen confirmed place
 * (`mergePlaceInto`). After that commit (never inside the merge, ruling M5-F-R4) it consolidates the merged geo object,
 * which only waits for a consolidation of it still running and dismisses the open tasks that one opened after the
 * merge locked its tasks (`object_ended`, review minor 1; a run's scope refuses a merged object), then starts a
 * consolidation run for the surviving place's geo object and goes to the surviving place with `?merged=<placeId>` (and
 * `&run=<id>`, or `&mergedNoRun=1` when the run did not start: the merge stands). A refusal returns to the place with
 * `?mergeError=<reason>`.
 */
export async function mergePlaceAction(
  input: FormData | { placeId: string; intoPlaceId: string; confirmAcrossAreas?: boolean },
): Promise<void> {
  const admin = await requireAdmin();
  const raw = fields(input) as Record<string, unknown>;
  const f = mergeSchema.parse({ ...raw, confirmAcrossAreas: raw.confirmAcrossAreas || undefined });
  const db = getDb();
  let target: string;
  try {
    const merged = await mergePlaceInto(db, {
      placeId: f.placeId,
      intoPlaceId: f.intoPlaceId,
      decidedBy: admin.email,
      confirmAcrossAreas: f.confirmAcrossAreas !== undefined,
    });
    const run = await afterPlaceMerge(db, getBoss, { ...merged, triggeredBy: admin.email });
    target = `/places/${f.intoPlaceId}?merged=${f.placeId}${run.status === "started" ? `&run=${run.runId}` : "&mergedNoRun=1"}`;
    revalidatePath(`/places/${f.placeId}`);
    revalidatePath(`/places/${f.intoPlaceId}`);
  } catch (e) {
    if (!(e instanceof PlaceMergeNotAllowed)) throw e;
    target = `/places/${f.placeId}?mergeError=${e.reason}`;
  }
  redirect(target);
}
