"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { getDb } from "@/lib/db/client";
import { ComparisonModelsInvalid, COMPARISON_VERDICTS, createModelComparison, DeviationNotInSample, rateDeviation } from "@/lib/domain/extraction/comparison";
import { getBoss } from "@/lib/jobs/boss";
import { startModelComparisonRun } from "@/lib/pipeline/text/run";
import { RunScopeNotReady } from "@/lib/pipeline/tile-scope";
import { requireAdmin } from "@/lib/security/require-admin";

const PAGE = "/compare/models";

const createSchema = z.object({ label: z.string().trim().min(1).max(80) });

/** "Vergleich anlegen": draws the sample of 200 units and stores the comparison; then shows it. */
export async function createComparisonAction(formData: FormData): Promise<void> {
  const admin = await requireAdmin();
  const parsed = createSchema.safeParse({ label: formData.get("label") });
  if (!parsed.success) return redirect(`${PAGE}?error=invalid_label`);
  let id: string;
  try {
    ({ id } = await createModelComparison(getDb(), { label: parsed.data.label, createdBy: admin.email }));
  } catch (e) {
    if (e instanceof ComparisonModelsInvalid) return redirect(`${PAGE}?error=invalid_models`);
    throw e;
  }
  revalidatePath(PAGE);
  redirect(`${PAGE}?comparison=${id}`);
}

const comparisonSchema = z.object({ comparisonId: z.uuid() });

/** "Lauf starten": the comparison run (both models, batch API); refusals come back to the comparison. */
export async function startComparisonRunAction(formData: FormData): Promise<void> {
  const admin = await requireAdmin();
  const parsed = comparisonSchema.safeParse({ comparisonId: formData.get("comparisonId") });
  if (!parsed.success) return redirect(PAGE);
  const { comparisonId } = parsed.data;
  const db = getDb();
  const boss = await getBoss();
  let target: string;
  try {
    target = `/runs/${(await startModelComparisonRun(db, boss, { comparisonId, triggeredBy: admin.email })).id}`;
  } catch (e) {
    if (!(e instanceof RunScopeNotReady)) throw e;
    target = `${PAGE}?comparison=${comparisonId}&error=${e.reason}`;
  }
  revalidatePath("/runs");
  revalidatePath(PAGE);
  redirect(target);
}

const ratingSchema = z.object({
  comparisonId: z.uuid(),
  unitKey: z.string().regex(/^[0-9a-f-]{36}:[0-9a-f-]{36}$/),
  attribute: z.string().min(1).max(200),
  verdict: z.enum(COMPARISON_VERDICTS),
  item: z.coerce.number().int().min(1),
});

/** One verdict on the shown deviation; then the next item of the sample. */
export async function rateDeviationAction(formData: FormData): Promise<void> {
  const admin = await requireAdmin();
  const parsed = ratingSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) {
    const comparison = z.uuid().safeParse(formData.get("comparisonId"));
    return redirect(comparison.success ? `${PAGE}?comparison=${comparison.data}&error=invalid_rating` : `${PAGE}?error=invalid_rating`);
  }
  const { comparisonId, unitKey, attribute, verdict, item } = parsed.data;
  try {
    await rateDeviation(getDb(), { comparisonId, unitKey, attribute, verdict, by: admin.email });
  } catch (e) {
    // A stale or forged item (not in the sample, or no such comparison) is refused, never counted.
    if (e instanceof DeviationNotInSample) return redirect(`${PAGE}?comparison=${comparisonId}&error=rating_not_in_sample`);
    throw e;
  }
  revalidatePath(PAGE);
  redirect(`${PAGE}?comparison=${comparisonId}&item=${item + 1}`);
}
