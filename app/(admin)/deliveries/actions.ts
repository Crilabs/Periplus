"use server";

import { z } from "zod";
import { getDb } from "@/lib/db/client";
import { getBoss } from "@/lib/jobs/boss";
import { startDeliveryRun } from "@/lib/pipeline/delivery-run";
import { requireAdmin } from "@/lib/security/require-admin";
import { startAndRedirect } from "../_components/run-start";

const buildSchema = z.object({ areaId: z.uuid() });

const fields = (input: FormData | object) => (input instanceof FormData ? Object.fromEntries(input) : input);

/**
 * „Paket bauen“ for one area: starts the run of stage `delivery.build` and goes to it; an area that cannot be built
 * (no valid area with public id and config key) returns to `/deliveries?error=<reason>`.
 */
export async function buildDeliveryAction(input: FormData | { areaId: string }): Promise<void> {
  const admin = await requireAdmin();
  const { areaId } = buildSchema.parse(fields(input));
  const db = getDb();
  const boss = await getBoss();
  await startAndRedirect(() => startDeliveryRun(db, boss, { areaGeoObjectId: areaId, triggeredBy: admin.email }), "/deliveries");
}
