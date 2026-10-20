"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { getConfig } from "@/lib/config";
import { getDb } from "@/lib/db/client";
import { addToComparisonSet, removeFromComparisonSet } from "@/lib/domain/comparison";
import { activateCandidate, RegressionGateClosed } from "@/lib/domain/quality/regression";
import { getBoss } from "@/lib/jobs/boss";
import { MEASUREMENT_LABEL_MAX, startEvaluation, startMeasurement } from "@/lib/pipeline/quality-run";
import { requireAdmin } from "@/lib/security/require-admin";
import { startAndRedirect } from "../_components/run-start";

const areaKeySchema = z.string().refine((key) => getConfig().areas.some((a) => a.key === key), "unknown area");
/** An empty form field is no value. */
const optional = <T extends z.ZodType>(schema: T) => z.preprocess((v) => (v === "" || v === null ? undefined : v), schema.optional());
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;
/** A window bound as typed: a date (`YYYY-MM-DD`) or an ISO timestamp. */
const bound = z
  .string()
  .trim()
  .refine((v) => /^\d{4}-\d{2}-\d{2}(T.+)?$/.test(v) && !Number.isNaN(new Date(v).getTime()), "invalid date");
/** „von“: a date starts at midnight UTC. */
const fromBound = bound.transform((v) => new Date(DATE_ONLY.test(v) ? `${v}T00:00:00Z` : v));
/** „bis“ is inclusive: a date ends at the end of that day (midnight UTC of the next), never later than now. */
const toBound = bound.transform((v) => {
  if (!DATE_ONLY.test(v)) return new Date(v);
  const end = new Date(new Date(`${v}T00:00:00Z`).getTime() + DAY_MS);
  const now = new Date();
  return end.getTime() > now.getTime() ? now : end;
});

const fields = (input: FormData | object) => (input instanceof FormData ? Object.fromEntries(input) : input);
const qualityPath = (areaKey: string) => `/quality?${new URLSearchParams({ area: areaKey })}`;

/**
 * Invalid form input returns to `/quality` with a German notice (`?error=invalid_input`) instead of an error page; the
 * area of the form when it is a configured one.
 */
function invalidInput(input: FormData | object): never {
  const area = (fields(input) as { areaKey?: unknown }).areaKey;
  const known = typeof area === "string" && getConfig().areas.some((a) => a.key === area);
  redirect(known ? `${qualityPath(area)}&error=invalid_input` : "/quality?error=invalid_input");
}

const toggleSchema = z.object({
  placeId: z.uuid(),
  areaKey: areaKeySchema,
  include: z.boolean(),
});

type ToggleInput = { placeId: string; areaKey: string; include: boolean };

/** Adds a place to the comparison set or removes it. A form sends `include=true` for a ticked checkbox, nothing otherwise. */
export async function toggleComparisonAction(input: FormData | ToggleInput): Promise<void> {
  const admin = await requireAdmin();
  const raw =
    input instanceof FormData
      ? { placeId: input.get("placeId"), areaKey: input.get("areaKey"), include: input.get("include") === "true" }
      : input;
  const { placeId, areaKey, include } = toggleSchema.parse(raw);
  const db = getDb();
  if (include) await addToComparisonSet(db, placeId, areaKey, admin.email);
  else await removeFromComparisonSet(db, placeId);
  revalidatePath("/quality");
}

const measurementSchema = z.object({
  areaKey: areaKeySchema,
  label: z.string().trim().min(1).max(MEASUREMENT_LABEL_MAX),
  from: optional(fromBound),
  to: optional(toBound),
});

/**
 * „Messen“: starts a measurement of the area and opens its run page; a refused start or invalid input returns to
 * `/quality` with the reason. A date „bis“ includes that day.
 */
export async function startMeasurementAction(input: FormData | { areaKey: string; label: string; from?: string; to?: string }): Promise<void> {
  const admin = await requireAdmin();
  const parsed = measurementSchema.safeParse(fields(input));
  if (!parsed.success) return invalidInput(input);
  const { areaKey, label, from, to } = parsed.data;
  const db = getDb();
  const boss = await getBoss();
  await startAndRedirect(
    () => startMeasurement(db, boss, { areaKey, label, ...(from ? { from } : {}), ...(to ? { to } : {}), triggeredBy: admin.email }),
    qualityPath(areaKey),
  );
}

const evaluationSchema = z
  .object({
    areaKey: areaKeySchema,
    rulesVersion: optional(z.string().regex(/^v[1-9][0-9]*$/)),
    model: optional(z.string().trim().min(1).max(120)),
    promptVersion: optional(z.coerce.number().int().min(1)),
  })
  .refine((v) => (v.model === undefined) === (v.promptVersion === undefined), "model and prompt version go together");

/**
 * „Bewertung starten“: an evaluation run of a rules version and/or an extraction candidate over the area's comparison
 * set; opens its run page, or returns to `/quality` with the reason of a refused start or invalid input. An empty rules
 * version („unverändert“) leaves the rules out of the candidate.
 */
export async function startEvaluationAction(
  input: FormData | { areaKey: string; rulesVersion?: string; model?: string; promptVersion?: number | string },
): Promise<void> {
  const admin = await requireAdmin();
  const parsed = evaluationSchema.safeParse(fields(input));
  if (!parsed.success) return invalidInput(input);
  const { areaKey, rulesVersion, model, promptVersion } = parsed.data;
  const db = getDb();
  const boss = await getBoss();
  const candidate = {
    ...(rulesVersion ? { rulesVersion } : {}),
    ...(model && promptVersion ? { extraction: { model, promptVersion } } : {}),
  };
  await startAndRedirect(() => startEvaluation(db, boss, { areaKey, candidate, triggeredBy: admin.email }), qualityPath(areaKey));
}

const activationSchema = z.object({ areaKey: areaKeySchema, evaluationRunId: z.uuid() });

/**
 * „Aktivieren“ (a deliberate click): activates the evaluated candidate when its old/new comparison passes; a closed gate
 * returns to `/quality` with `?error=regression_gate_closed` (the reasons stand at the evaluation).
 */
export async function activateCandidateAction(input: FormData | { areaKey: string; evaluationRunId: string }): Promise<void> {
  const admin = await requireAdmin();
  const parsed = activationSchema.safeParse(fields(input));
  if (!parsed.success) return invalidInput(input);
  const { areaKey, evaluationRunId } = parsed.data;
  let target = `${qualityPath(areaKey)}&notice=activated`;
  try {
    await activateCandidate(getDb(), { evaluationRunId, activatedBy: admin.email });
  } catch (e) {
    if (!(e instanceof RegressionGateClosed)) throw e;
    target = `${qualityPath(areaKey)}&error=regression_gate_closed`;
  }
  revalidatePath("/quality");
  revalidatePath("/settings");
  redirect(target);
}
