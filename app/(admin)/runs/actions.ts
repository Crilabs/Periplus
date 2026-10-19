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
import { startRun } from "@/lib/pipeline/runs";
import { startSeedRun } from "@/lib/pipeline/seed";
import { RunScopeNotReady } from "@/lib/pipeline/tile-scope";
import { requireAdmin } from "@/lib/security/require-admin";

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

/**
 * Starts a run and redirects to it. A scope lacking an input (`RunScopeNotReady`) redirects to `errorPath` with
 * `?error=<reason>` instead, which that page shows in German.
 */
async function startAndRedirect(start: () => Promise<{ id: string }>, errorPath: string): Promise<void> {
  let target: string;
  try {
    target = `/runs/${(await start()).id}`;
  } catch (e) {
    if (!(e instanceof RunScopeNotReady)) throw e;
    target = `${errorPath}?error=${e.reason}`;
  }
  revalidatePath("/runs");
  redirect(target);
}

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

/** Starts "build gazetteer" for a configured area. */
export async function startGazetteerAction(input: FormData | { areaKey: string }): Promise<void> {
  const admin = await requireAdmin();
  const { areaKey } = areaSchema.parse(fields(input));
  const run = await startGazetteerRun(getDb(), await getBoss(), areaKey, admin.email);
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
