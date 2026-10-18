"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { getConfig } from "@/lib/config";
import { getDb, type Db } from "@/lib/db/client";
import { tileExists } from "@/lib/domain/geo-view";
import { getBoss } from "@/lib/jobs/boss";
import { startGazetteerRun } from "@/lib/pipeline/gazetteer/stages";
import { startRun } from "@/lib/pipeline/runs";
import { startSeedRun } from "@/lib/pipeline/seed";
import { requireAdmin } from "@/lib/security/require-admin";

const pingSchema = z.object({ count: z.coerce.number().int().min(1).max(50) });
const areaKeySchema = z.string().refine((key) => getConfig().areas.some((a) => a.key === key), "unknown area");
const tileIdSchema = z.string().regex(/^q025:\d+:\d+$/);
const gazetteerSchema = z.object({ areaKey: areaKeySchema });
/** Exactly one of tileId and areaKey: a payload with both, or a rejected tile next to an area, never falls back. */
const seedSchema = (db: Db) =>
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

/** Starts "build gazetteer" for a configured area. */
export async function startGazetteerAction(input: FormData | { areaKey: string }): Promise<void> {
  const admin = await requireAdmin();
  const { areaKey } = gazetteerSchema.parse(fields(input));
  const run = await startGazetteerRun(getDb(), await getBoss(), areaKey, admin.email);
  revalidatePath("/runs");
  redirect(`/runs/${run.id}`);
}

/** Starts a seed run for a configured area or for one existing tile. */
export async function startSeedAction(input: FormData | { areaKey: string } | { tileId: string }): Promise<void> {
  const admin = await requireAdmin();
  const db = getDb();
  const scope = await seedSchema(db).parseAsync(fields(input));
  const run = await startSeedRun(db, await getBoss(), scope, admin.email);
  revalidatePath("/runs");
  redirect(`/runs/${run.id}`);
}
