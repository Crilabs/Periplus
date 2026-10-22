"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { getDb, type Db } from "@/lib/db/client";
import { getConfig } from "@/lib/config";
import { estimateReprocessCostEur, type ReprocessEstimate } from "@/lib/domain/extraction/reprocess-estimate";
import { tileExists } from "@/lib/domain/geo-view";
import { getBoss } from "@/lib/jobs/boss";
import { startDatasetImportRun } from "@/lib/pipeline/datasets-run";
import { startGazetteerRun } from "@/lib/pipeline/gazetteer/stages";
import { startGeometryRun } from "@/lib/pipeline/geometry-run";
import { startPlaceWebsiteRun } from "@/lib/pipeline/place-website-run";
import { startRevisitRun } from "@/lib/pipeline/revisit-run";
import { startRun } from "@/lib/pipeline/runs";
import { startSeedRun } from "@/lib/pipeline/seed";
import { startReprocessRun, startTextRun } from "@/lib/pipeline/text/run";
import { createLogger } from "@/lib/logger";
import { requireAdmin } from "@/lib/security/require-admin";
import { startAndRedirect } from "../_components/run-start";

const pingSchema = z.object({ count: z.coerce.number().int().min(1).max(50) });
const tileIdSchema = z.string().regex(/^q025:\d+:\d+$/);
const subdivisionKeySchema = z.string().min(1);
/** Exactly one of tileId and subdivisionKey: a payload with both, or a rejected tile next to a subdivision, never falls back. */
const tileOrSubdivisionSchema = (db: Db) =>
  z.union([
    z.object({ tileId: tileIdSchema.refine((id) => tileExists(db, id), "unknown tile"), subdivisionKey: z.undefined().optional() }),
    z.object({ subdivisionKey: subdivisionKeySchema, tileId: z.undefined().optional() }),
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

const subdivisionSchema = z.object({ subdivisionKey: subdivisionKeySchema });

/** Starts "build gazetteer" for a subdivision (an unknown or excluded one is rejected by the run starter). */
export async function startGazetteerAction(input: FormData | { subdivisionKey: string }): Promise<void> {
  const admin = await requireAdmin();
  const { subdivisionKey } = subdivisionSchema.parse(fields(input));
  const run = await startGazetteerRun(getDb(), await getBoss(), subdivisionKey, admin.email);
  revalidatePath("/runs");
  redirect(`/runs/${run.id}`);
}

/** Starts a seed run for a subdivision or for one existing tile. */
export async function startSeedAction(input: FormData | { subdivisionKey: string } | { tileId: string }): Promise<void> {
  const admin = await requireAdmin();
  const db = getDb();
  const scope = await tileOrSubdivisionSchema(db).parseAsync(fields(input));
  const run = await startSeedRun(db, await getBoss(), scope, admin.email);
  revalidatePath("/runs");
  redirect(`/runs/${run.id}`);
}

/** Starts "Datensätze laden" (bathymetry, seabed, restricted areas …) for a subdivision. */
export async function startDatasetImportAction(input: FormData | { subdivisionKey: string }): Promise<void> {
  const admin = await requireAdmin();
  const { subdivisionKey } = subdivisionSchema.parse(fields(input));
  const db = getDb();
  const boss = await getBoss();
  await startAndRedirect(() => startDatasetImportRun(db, boss, subdivisionKey, admin.email), "/runs");
}

/** Starts "Geometrie" for a subdivision or for one existing tile; missing inputs return to the calling page. */
export async function startGeometryAction(input: FormData | { subdivisionKey: string } | { tileId: string }): Promise<void> {
  const admin = await requireAdmin();
  const db = getDb();
  const scope = await tileOrSubdivisionSchema(db).parseAsync(fields(input));
  const boss = await getBoss();
  const errorPath = "tileId" in scope && scope.tileId ? `/tiles/${encodeURIComponent(scope.tileId)}` : "/runs";
  await startAndRedirect(() => startGeometryRun(db, boss, scope, admin.email), errorPath);
}

/** Where a refused text run of this scope returns to (the tile page for a tile, else the runs page). */
const textRunErrorPath = (scope: { tileId?: string; subdivisionKey?: string }) =>
  scope.tileId ? `/tiles/${encodeURIComponent(scope.tileId)}` : "/runs";

/**
 * "Texte auswerten" for a subdivision or one existing tile: a text run over the versions mentioning objects there
 * plus the pending versions of its sources; refusals return to the calling page.
 */
export async function startTextRunAction(input: FormData | { subdivisionKey: string } | { tileId: string }): Promise<void> {
  const admin = await requireAdmin();
  const db = getDb();
  const scope = await tileOrSubdivisionSchema(db).parseAsync(fields(input));
  const boss = await getBoss();
  await startAndRedirect(() => startTextRun(db, boss, { ...scope, triggeredBy: admin.email }), textRunErrorPath(scope));
}

/**
 * "Reprozessieren (Stufen 6–7)" for a subdivision or one existing tile: every mention there is extracted again
 * into a new extraction run (the old facts stay); refusals return to the calling page.
 */
export async function startReprocessAction(input: FormData | { subdivisionKey: string } | { tileId: string }): Promise<void> {
  const admin = await requireAdmin();
  const db = getDb();
  const parsed = await tileOrSubdivisionSchema(db).parseAsync(fields(input));
  const scope = parsed.tileId ? { tileId: parsed.tileId } : { subdivisionKey: parsed.subdivisionKey! };
  const boss = await getBoss();
  await startAndRedirect(() => startReprocessRun(db, boss, { scope, triggeredBy: admin.email }), textRunErrorPath(parsed));
}

/**
 * „Revisit für Landesteil“ (spec 10, ruling M7-P22): crawls every approved source again and evaluates what changed for a
 * subdivision, up to the consolidation and its change events; refusals (no tiles, no approved source, a source
 * being fetched) return to the runs page.
 */
export async function startRevisitAction(input: FormData | { subdivisionKey: string }): Promise<void> {
  const admin = await requireAdmin();
  const { subdivisionKey } = subdivisionSchema.parse(fields(input));
  const db = getDb();
  const boss = await getBoss();
  await startAndRedirect(() => startRevisitRun(db, boss, { subdivisionKey, triggeredBy: admin.email }), "/runs");
}

/**
 * „Marina-Websites suchen“ (spec 16 C „Crawl“): finds the websites of the subdivision's marinas and ports, approves them
 * as sources, crawls them and evaluates the new pages; refusals return to the runs page.
 */
export async function startPlaceWebsiteAction(input: FormData | { subdivisionKey: string }): Promise<void> {
  const admin = await requireAdmin();
  const { subdivisionKey } = subdivisionSchema.parse(fields(input));
  const db = getDb();
  const boss = await getBoss();
  await startAndRedirect(() => startPlaceWebsiteRun(db, boss, { subdivisionKey }, admin.email), "/runs");
}

/**
 * The cost estimate of „Reprozessieren“ for one subdivision, asked by the start dialog when a subdivision is chosen (not
 * on every refresh of the runs page). A failure is logged and reported as `ok: false`, never as „no estimate“.
 */
export async function reprocessEstimateAction(subdivisionKey: string): Promise<{ ok: true; estimate: ReprocessEstimate } | { ok: false }> {
  await requireAdmin();
  try {
    return { ok: true, estimate: await estimateReprocessCostEur(getDb(), subdivisionKeySchema.parse(subdivisionKey), getConfig()) };
  } catch (error) {
    createLogger("runs").error({ err: error, subdivisionKey }, "reprocess estimate failed");
    return { ok: false };
  }
}
