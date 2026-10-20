"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { getConfig } from "@/lib/config";
import { getDb, type Db } from "@/lib/db/client";
import { tileExists } from "@/lib/domain/geo-view";
import { getBoss } from "@/lib/jobs/boss";
import { startDatasetImportRun } from "@/lib/pipeline/datasets-run";
import { startGazetteerRun } from "@/lib/pipeline/gazetteer/stages";
import { startGeometryRun } from "@/lib/pipeline/geometry-run";
import { startRevisitRun } from "@/lib/pipeline/revisit-run";
import { startRun } from "@/lib/pipeline/runs";
import { startSeedRun } from "@/lib/pipeline/seed";
import { startReprocessRun, startTextRun } from "@/lib/pipeline/text/run";
import { requireAdmin } from "@/lib/security/require-admin";
import { startAndRedirect } from "../_components/run-start";

const pingSchema = z.object({ count: z.coerce.number().int().min(1).max(50) });
const areaKeySchema = z.string().refine((key) => getConfig().areas.some((a) => a.key === key), "unknown area");
const tileIdSchema = z.string().regex(/^q025:\d+:\d+$/);
const areaSchema = z.object({ areaKey: areaKeySchema });
/** Exactly one of tileId and areaKey: a payload with both, or a rejected tile next to an area, never falls back. */
const tileOrAreaSchema = (db: Db) =>
  z.union([
    z.object({ tileId: tileIdSchema.refine((id) => tileExists(db, id), "unknown tile"), areaKey: z.undefined().optional() }),
    z.object({ areaKey: areaKeySchema, tileId: z.undefined().optional() }),
  ]);

const fields = (input: FormData | object) => (input instanceof FormData ? Object.fromEntries(input) : input);

export async function startPingRun(input: FormData | { count: number | string }): Promise<void> {
  const admin = await requireAdmin();
  const { count } = pingSchema.parse(fields(input));
  await startRun(getDb(), await getBoss(), {
    kind: "system",
    scope: { type: "system", id: "ping" },
    stages: ["ping"],
    params: { count },
    triggeredBy: admin.email,
  });
  revalidatePath("/runs");
  redirect("/runs");
}

const subdivisionSchema = z.object({ subdivisionKey: z.string().min(1) });

/** Starts "build gazetteer" for a subdivision (an unknown or excluded one is rejected by the run starter). */
// TODO(plan 14a task 7): the start dialog still posts an area key; it picks a subdivision there
export async function startGazetteerAction(input: FormData | { subdivisionKey: string }): Promise<void> {
  const admin = await requireAdmin();
  const { subdivisionKey } = subdivisionSchema.parse(fields(input));
  const run = await startGazetteerRun(getDb(), await getBoss(), subdivisionKey, admin.email);
  revalidatePath("/runs");
  redirect(`/runs/${run.id}`);
}

/** Starts a seed run for a configured area or for one existing tile. */
export async function startSeedAction(input: FormData | { areaKey: string } | { tileId: string }): Promise<void> {
  const admin = await requireAdmin();
  const db = getDb();
  const scope = await tileOrAreaSchema(db).parseAsync(fields(input));
  const run = await startSeedRun(db, await getBoss(), scope, admin.email);
  revalidatePath("/runs");
  redirect(`/runs/${run.id}`);
}

/** Starts "Datensätze laden" (bathymetry, seabed, restricted areas …) for a configured area. */
export async function startDatasetImportAction(input: FormData | { areaKey: string }): Promise<void> {
  const admin = await requireAdmin();
  const { areaKey } = areaSchema.parse(fields(input));
  const db = getDb();
  const boss = await getBoss();
  await startAndRedirect(() => startDatasetImportRun(db, boss, areaKey, admin.email), "/runs");
}

/** Starts "Geometrie" for a configured area or for one existing tile; missing inputs return to the calling page. */
export async function startGeometryAction(input: FormData | { areaKey: string } | { tileId: string }): Promise<void> {
  const admin = await requireAdmin();
  const db = getDb();
  const scope = await tileOrAreaSchema(db).parseAsync(fields(input));
  const boss = await getBoss();
  const errorPath = "tileId" in scope && scope.tileId ? `/tiles/${encodeURIComponent(scope.tileId)}` : "/runs";
  await startAndRedirect(() => startGeometryRun(db, boss, scope, admin.email), errorPath);
}

/** Where a refused text run of this scope returns to (the tile page for a tile, else the runs page). */
const textRunErrorPath = (scope: { tileId?: string; areaKey?: string }) =>
  scope.tileId ? `/tiles/${encodeURIComponent(scope.tileId)}` : "/runs";

/**
 * "Texte auswerten" for a configured area or one existing tile: a text run over the versions mentioning objects there
 * plus the pending versions of its sources; refusals return to the calling page.
 */
export async function startTextRunAction(input: FormData | { areaKey: string } | { tileId: string }): Promise<void> {
  const admin = await requireAdmin();
  const db = getDb();
  const scope = await tileOrAreaSchema(db).parseAsync(fields(input));
  const boss = await getBoss();
  await startAndRedirect(() => startTextRun(db, boss, { ...scope, triggeredBy: admin.email }), textRunErrorPath(scope));
}

/**
 * "Reprozessieren (Stufen 6–7)" for a configured area or one existing tile: every mention there is extracted again
 * into a new extraction run (the old facts stay); refusals return to the calling page.
 */
export async function startReprocessAction(input: FormData | { areaKey: string } | { tileId: string }): Promise<void> {
  const admin = await requireAdmin();
  const db = getDb();
  const parsed = await tileOrAreaSchema(db).parseAsync(fields(input));
  const scope = parsed.tileId ? { tileId: parsed.tileId } : { areaKey: parsed.areaKey! };
  const boss = await getBoss();
  await startAndRedirect(() => startReprocessRun(db, boss, { scope, triggeredBy: admin.email }), textRunErrorPath(parsed));
}

/**
 * „Revisit für Revier“ (spec 10, ruling M7-P22): crawls every approved source again and evaluates what changed for a
 * configured area, up to the consolidation and its change events; refusals (no tiles, no approved source, a source
 * being fetched) return to the runs page.
 */
export async function startRevisitAction(input: FormData | { areaKey: string }): Promise<void> {
  const admin = await requireAdmin();
  const { areaKey } = areaSchema.parse(fields(input));
  const db = getDb();
  const boss = await getBoss();
  await startAndRedirect(() => startRevisitRun(db, boss, { areaKey, triggeredBy: admin.email }), "/runs");
}
