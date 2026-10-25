"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { getDb } from "@/lib/db/client";
import { saveComparisonSelection } from "@/lib/domain/comparison";
import { subdivisionByKey } from "@/lib/domain/subdivisions/store";
import { activateCandidate, RegressionGateClosed } from "@/lib/domain/quality/regression";
import { getBoss } from "@/lib/jobs/boss";
import { MEASUREMENT_LABEL_MAX, startMeasurement } from "@/lib/pipeline/quality-run";
import { requireAdmin } from "@/lib/security/require-admin";
import { startAndRedirect } from "../_components/run-start";

/** A valid subdivision key (a leftover area key, an unknown or an ended subdivision is invalid input). */
const subdivisionKeySchema = z.string().refine(async (key) => (await subdivisionByKey(getDb(), key)) !== null, "unknown subdivision");
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
const qualityPath = (subdivisionKey: string) => `/quality?${new URLSearchParams({ subdivision: subdivisionKey })}`;

/**
 * Invalid form input returns to `/quality` with a German notice (`?error=invalid_input`) instead of an error page; the
 * subdivision of the form when it is a valid one.
 */
async function invalidInput(input: FormData | object): Promise<never> {
  const key = (fields(input) as { subdivisionKey?: unknown }).subdivisionKey;
  const known = typeof key === "string" && (await subdivisionByKey(getDb(), key)) !== null;
  redirect(known ? `${qualityPath(key)}&error=invalid_input` : "/quality?error=invalid_input");
}

const selectionSchema = z.object({
  subdivisionKey: subdivisionKeySchema,
  shown: z.array(z.uuid()).max(5000),
  included: z.array(z.uuid()).max(5000),
});

/**
 * „Auswahl speichern“ of the comparison set list (UI-11): every place the list showed (`shown`) joins the set when its
 * box is ticked (`include=<placeId>`) and leaves it otherwise, all in one save.
 */
export async function saveComparisonSelectionAction(formData: FormData): Promise<void> {
  const admin = await requireAdmin();
  const parsed = await selectionSchema.safeParseAsync({
    subdivisionKey: formData.get("subdivisionKey"),
    shown: formData.getAll("shown"),
    included: formData.getAll("include"),
  });
  if (!parsed.success) return invalidInput(formData);
  await saveComparisonSelection(getDb(), { ...parsed.data, by: admin.email });
  revalidatePath("/quality");
}

const measurementSchema = z.object({
  subdivisionKey: subdivisionKeySchema,
  label: z.string().trim().min(1).max(MEASUREMENT_LABEL_MAX),
  from: optional(fromBound),
  to: optional(toBound),
});

/**
 * „Messen“: starts a measurement of the subdivision and opens its run page; a refused start or invalid input returns to
 * `/quality` with the reason. A date „bis“ includes that day.
 */
export async function startMeasurementAction(input: FormData | { subdivisionKey: string; label: string; from?: string; to?: string }): Promise<void> {
  const admin = await requireAdmin();
  const parsed = await measurementSchema.safeParseAsync(fields(input));
  if (!parsed.success) return invalidInput(input);
  const { subdivisionKey, label, from, to } = parsed.data;
  const db = getDb();
  const boss = await getBoss();
  await startAndRedirect(
    () => startMeasurement(db, boss, { subdivisionKey, label, ...(from ? { from } : {}), ...(to ? { to } : {}), triggeredBy: admin.email }),
    qualityPath(subdivisionKey),
  );
}

const activationSchema = z.object({ subdivisionKey: subdivisionKeySchema, evaluationRunId: z.uuid() });

/**
 * „Aktivieren“ (a deliberate click): activates the evaluated candidate when its old/new comparison passes; a closed gate
 * returns to `/quality` with `?error=regression_gate_closed` (the reasons stand at the evaluation).
 */
export async function activateCandidateAction(input: FormData | { subdivisionKey: string; evaluationRunId: string }): Promise<void> {
  const admin = await requireAdmin();
  const parsed = await activationSchema.safeParseAsync(fields(input));
  if (!parsed.success) return invalidInput(input);
  const { subdivisionKey, evaluationRunId } = parsed.data;
  let target = `${qualityPath(subdivisionKey)}&notice=activated`;
  try {
    await activateCandidate(getDb(), { evaluationRunId, activatedBy: admin.email });
  } catch (e) {
    if (!(e instanceof RegressionGateClosed)) throw e;
    target = `${qualityPath(subdivisionKey)}&error=regression_gate_closed`;
  }
  revalidatePath("/quality");
  revalidatePath("/settings");
  redirect(target);
}
