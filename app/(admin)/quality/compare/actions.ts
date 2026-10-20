"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getConfig } from "@/lib/config";
import { getDb } from "@/lib/db/client";
import { COMPARISON_ATTRIBUTES, type ComparisonAttribute } from "@/lib/domain/quality/comparison-values";
import { loadNavilyFromEnv } from "@/lib/domain/quality/navily-assistant";
import { acceptNavilyProposals, recordManualComparison } from "@/lib/domain/quality/navily-compare";
import { requireAdmin } from "@/lib/security/require-admin";

const areaKey = z.string().refine((key) => getConfig().areas.some((a) => a.key === key), "unknown area");

const placeSchema = z.strictObject({
  placeId: z.uuid(),
  areaKey,
  evaluationRunId: z.uuid().optional(),
});

const recordSchema = placeSchema.extend({
  attribute: z.enum(COMPARISON_ATTRIBUTES),
  result: z.enum(["match", "deviation", "not_at_navily"]),
  valueHash: z.string().regex(/^[0-9a-f]{16}$/),
});

/**
 * Records the outcome an admin gave for one attribute of a place (method `manual`). The current values are computed
 * here; a `valueHash` that is no longer the current value's fails with `StaleComparison` (reload the page) and
 * writes nothing.
 */
export async function recordComparisonAction(input: {
  placeId: string;
  areaKey: string;
  attribute: ComparisonAttribute;
  result: "match" | "deviation" | "not_at_navily";
  valueHash: string;
  evaluationRunId?: string;
}): Promise<void> {
  const admin = await requireAdmin();
  const parsed = recordSchema.parse(input);
  await recordManualComparison(getDb(), { ...parsed, checkedBy: admin.email, cfg: getConfig().quality.navily });
  revalidatePath("/quality/compare");
}

/**
 * Confirms all proposals of a place (method `proposal_confirmed`): the proposals are recomputed here from the Navily
 * file read now, never taken from the client.
 */
export async function acceptProposalsAction(input: {
  placeId: string;
  areaKey: string;
  evaluationRunId?: string;
}): Promise<{ written: number; tasks: number }> {
  const admin = await requireAdmin();
  const parsed = placeSchema.parse(input);
  const spots = await loadNavilyFromEnv();
  if (!spots) throw new Error("Navily-Datei nicht geladen");
  const config = getConfig();
  const out = await acceptNavilyProposals(getDb(), {
    ...parsed,
    spots,
    checkedBy: admin.email,
    cfg: config.quality.navily,
    affixes: config.nameAffixes,
  });
  revalidatePath("/quality/compare");
  return out;
}
