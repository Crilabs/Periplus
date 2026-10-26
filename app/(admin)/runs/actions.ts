"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { getDb, type Db } from "@/lib/db/client";
import { tileExists } from "@/lib/domain/geo-view";
import { getBoss } from "@/lib/jobs/boss";
import { startDatasetImportRun } from "@/lib/pipeline/datasets-run";
import { startGazetteerRun } from "@/lib/pipeline/gazetteer/stages";
import { startGeometryRun } from "@/lib/pipeline/geometry-run";
import { startRun } from "@/lib/pipeline/runs";
import { startSeedRun } from "@/lib/pipeline/seed";
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
