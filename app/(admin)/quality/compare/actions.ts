"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getConfig } from "@/lib/config";
import { getDb } from "@/lib/db/client";
import { StaleComparison } from "@/lib/domain/quality/comparison-results";
import { COMPARISON_ATTRIBUTES, type ComparisonAttribute } from "@/lib/domain/quality/comparison-values";
import { loadNavilyFromEnv } from "@/lib/domain/quality/navily-assistant";
import { acceptNavilyProposals, recordManualComparison } from "@/lib/domain/quality/navily-compare";
import type { NavilySpot } from "@/lib/domain/quality/navily-sample";
import { createLogger } from "@/lib/logger";
import { requireAdmin } from "@/lib/security/require-admin";

/** An unknown subdivision (or a leftover area key) has no comparison set: the place is then not in it and the call fails. */
const subdivisionKey = z.string().min(1);
const HEX16 = /^[0-9a-f]{16}$/;

const placeSchema = z.strictObject({
  placeId: z.uuid(),
  subdivisionKey,
});

const recordSchema = placeSchema.extend({
  attribute: z.enum(COMPARISON_ATTRIBUTES),
  result: z.enum(["match", "deviation", "not_at_navily"]),
  valueHash: z.string().regex(HEX16),
});

const acceptSchema = placeSchema.extend({ digest: z.string().regex(HEX16) });

/*
 * Expected failures come back as typed results (Next: model expected errors as return values), so the page tells a
 * changed value from a missing Navily file in production too. A result holds codes and counts only, never a Navily
 * value, name or path (Grundprinzip 9; the path of an unreadable file goes to the server log only).
 */

export type RecordComparisonResult = { ok: true; written: number; tasks: number } | { ok: false; code: "stale" };

export type AcceptProposalsResult =
  | { ok: true; written: number; tasks: number; skippedManual: number }
  | { ok: false; code: "stale" | "navily_missing" | "navily_unreadable" };

/**
 * Records the outcome an admin gave for one attribute of a place (method `manual`). The current values are computed
 * here; a `valueHash` that is no longer the current value's gives `stale` (reload the page) and writes nothing.
 */
export async function recordComparisonAction(input: {
  placeId: string;
  subdivisionKey: string;
  attribute: ComparisonAttribute;
  result: "match" | "deviation" | "not_at_navily";
  valueHash: string;
}): Promise<RecordComparisonResult> {
  const admin = await requireAdmin();
  const parsed = recordSchema.parse(input);
  try {
    const { written, tasks } = await recordManualComparison(getDb(), { ...parsed, checkedBy: admin.email, cfg: getConfig().quality.navily });
    revalidatePath("/quality/compare");
    return { ok: true, written, tasks };
  } catch (e) {
    if (e instanceof StaleComparison) return { ok: false, code: "stale" };
    throw e;
  }
}

/**
 * Confirms the proposals of a place the admin saw (method `proposal_confirmed`): `digest` is the digest of the shown
 * proposals; they are recomputed here from the Navily file read now, never taken from the client, and a difference
 * gives `stale`, nothing written. Outcomes set by hand are kept (`skippedManual`).
 */
export async function acceptProposalsAction(input: {
  placeId: string;
  subdivisionKey: string;
  digest: string;
}): Promise<AcceptProposalsResult> {
  const admin = await requireAdmin();
  const parsed = acceptSchema.parse(input);
  let spots: NavilySpot[] | null;
  try {
    spots = await loadNavilyFromEnv();
  } catch (e) {
    createLogger("quality-compare").warn({ reason: (e as Error).message }, "navily file unreadable");
    return { ok: false, code: "navily_unreadable" };
  }
  if (!spots) return { ok: false, code: "navily_missing" };
  const config = getConfig();
  try {
    const { written, tasks, skippedManual } = await acceptNavilyProposals(getDb(), {
      ...parsed,
      spots,
      checkedBy: admin.email,
      cfg: config.quality.navily,
      affixes: config.nameAffixes,
    });
    revalidatePath("/quality/compare");
    return { ok: true, written, tasks, skippedManual };
  } catch (e) {
    if (e instanceof StaleComparison) return { ok: false, code: "stale" };
    throw e;
  }
}
