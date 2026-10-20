"use server";

import { z } from "zod";
import { getDb } from "@/lib/db/client";
import { getBoss } from "@/lib/jobs/boss";
import { startDeliveryRun } from "@/lib/pipeline/delivery-run";
import { requireAdmin } from "@/lib/security/require-admin";
import { startAndRedirect } from "../_components/run-start";

const buildSchema = z.object({ subdivisionKey: z.string().min(1) });

const fields = (input: FormData | object) => (input instanceof FormData ? Object.fromEntries(input) : input);

/**
 * „Paket bauen“ for one subdivision: starts the run of stage `delivery.build` and goes to it. An unknown or excluded
 * subdivision is rejected by the run starter (`requireSubdivision`).
 */
export async function buildDeliveryAction(input: FormData | { subdivisionKey: string }): Promise<void> {
  const admin = await requireAdmin();
  const { subdivisionKey } = buildSchema.parse(fields(input));
  const db = getDb();
  const boss = await getBoss();
  await startAndRedirect(() => startDeliveryRun(db, boss, subdivisionKey, admin.email), "/deliveries");
}
