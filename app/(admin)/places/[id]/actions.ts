"use server";

import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { getConfig } from "@/lib/config";
import { getDb, type Db } from "@/lib/db/client";
import { places } from "@/lib/db/schema";
import { consolidateGeo } from "@/lib/domain/consolidation/store";
import { setAnchorPosition } from "@/lib/domain/geometry/anchor-correction";
import { mergePlaceInto, PlaceMergeNotAllowed } from "@/lib/domain/place-merge";
import { ProfileChanged, removeProfileEntry } from "@/lib/domain/profile-entry-removal";
import { DecisionNotAllowed } from "@/lib/domain/review-decisions";
import { getBoss } from "@/lib/jobs/boss";
import { createLogger } from "@/lib/logger";
import { startConsolidationRun } from "@/lib/pipeline/consolidation/run";
import { CONSOLIDATION_SUMMARY_STAGE } from "@/lib/pipeline/consolidation/stages";
import { startGeometryRun } from "@/lib/pipeline/geometry-run";
import { RunScopeNotReady } from "@/lib/pipeline/tile-scope";
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
  try {
    const run = await startGeometryRun(db, await getBoss(), { placeId }, admin.email);
    return { ok: true, runId: run.id, message: "Ankerposition übernommen, Geometrie wird neu berechnet." };
  } catch (e) {
    if (!(e instanceof RunScopeNotReady)) throw e;
    return {
      ok: true,
      runId: null,
      message: `Ankerposition übernommen. Geometrie nicht neu berechnet: ${RUN_SCOPE_REASON_LABELS[e.reason]}.`,
    };
  }
}

const placeSchema = z.object({ placeId: z.uuid() });
const geoObjectSchema = z.object({ geoObjectId: z.uuid() });

/**
 * "Profil neu berechnen" of a place: a consolidation run for the place's geo object (scope `place`); a refusal
 * returns to the place page with `?error=<reason>`.
 */
export async function recomputePlaceProfileAction(input: FormData | { placeId: string }): Promise<void> {
  const admin = await requireAdmin();
  const { placeId } = placeSchema.parse(fields(input));
  const db = getDb();
  const [place] = await db.select({ geoObjectId: places.geoObjectId }).from(places).where(eq(places.id, placeId));
  if (!place) throw new Error(`Unknown place ${placeId}`);
  const boss = await getBoss();
  await startAndRedirect(
    () => startConsolidationRun(db, boss, { scope: { geoObjectIds: [place.geoObjectId] }, triggeredBy: admin.email }),
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
  if (f.placeId) {
    const [place] = await db.select({ id: places.id }).from(places).where(and(eq(places.id, f.placeId), eq(places.geoObjectId, f.geoObjectId)));
    if (!place) throw new Error(`Place ${f.placeId} does not belong to geo object ${f.geoObjectId}`);
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
  if (f.placeId) {
    const [place] = await db.select({ id: places.id }).from(places).where(and(eq(places.id, f.placeId), eq(places.geoObjectId, f.geoObjectId)));
    if (!place) throw new Error(`Place ${f.placeId} does not belong to geo object ${f.geoObjectId}`);
  }
  const back = f.placeId
    ? `/places/${f.placeId}?tab=profile&attr=${encodeURIComponent(f.attribute)}`
    : `/geo/${f.geoObjectId}?attr=${encodeURIComponent(f.attribute)}`;
  let notice: string;
  try {
    await removeProfileEntry(db, { geoObjectId: f.geoObjectId, attribute: f.attribute, entryKey: f.entryKey, version: f.version, decidedBy: admin.email });
    notice = await startAfterRemoval(db, f.geoObjectId, admin.email);
    revalidatePath(f.placeId ? `/places/${f.placeId}` : `/geo/${f.geoObjectId}`);
  } catch (e) {
    if (e instanceof ProfileChanged) notice = "changed";
    else if (e instanceof DecisionNotAllowed) notice = "error";
    else throw e;
  }
  redirect(`${back}&notice=${notice}`);
}

/**
 * The consolidation run after a committed removal: `entry_removed&run=<id>`, or `entry_removed_no_run` (logged) when
 * it does not start — the removal stands either way.
 */
async function startAfterRemoval(db: Db, geoObjectId: string, triggeredBy: string): Promise<string> {
  try {
    const run = await startConsolidationRun(db, await getBoss(), { scope: { geoObjectIds: [geoObjectId] }, triggeredBy });
    return `entry_removed&run=${run.id}`;
  } catch (e) {
    const log = createLogger("profile");
    if (e instanceof RunScopeNotReady) log.warn({ geoObjectId, reason: e.reason }, "consolidation run not started after an entry removal");
    else log.error({ geoObjectId, err: e }, "consolidation run failed to start after an entry removal");
    return "entry_removed_no_run";
  }
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
    target = `/places/${f.intoPlaceId}?merged=${f.placeId}`;
    const log = createLogger("place-merge");
    try {
      await consolidateGeo(db, merged.dropGeoObjectId);
    } catch (e) {
      log.error({ geoObjectId: merged.dropGeoObjectId, err: e }, "merged object not settled after a place merge");
    }
    try {
      const run = await startConsolidationRun(db, await getBoss(), { scope: { geoObjectIds: [merged.keepGeoObjectId] }, triggeredBy: admin.email });
      target += `&run=${run.id}`;
    } catch (e) {
      if (e instanceof RunScopeNotReady) log.warn({ geoObjectId: merged.keepGeoObjectId, reason: e.reason }, "consolidation run not started after a place merge");
      else log.error({ geoObjectId: merged.keepGeoObjectId, err: e }, "consolidation run failed to start after a place merge");
      target += "&mergedNoRun=1";
    }
    revalidatePath(`/places/${f.placeId}`);
    revalidatePath(`/places/${f.intoPlaceId}`);
  } catch (e) {
    if (!(e instanceof PlaceMergeNotAllowed)) throw e;
    target = `/places/${f.placeId}?mergeError=${e.reason}`;
  }
  redirect(target);
}
