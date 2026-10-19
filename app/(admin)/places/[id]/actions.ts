"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getConfig } from "@/lib/config";
import { getDb } from "@/lib/db/client";
import { places } from "@/lib/db/schema";
import { setAnchorPosition } from "@/lib/domain/geometry/anchor-correction";
import { DecisionNotAllowed } from "@/lib/domain/review-decisions";
import { getBoss } from "@/lib/jobs/boss";
import { startConsolidationRun } from "@/lib/pipeline/consolidation/run";
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
