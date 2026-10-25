"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { getDb } from "@/lib/db/client";
import { OutputNotRateable, rateConverterOutput } from "@/lib/domain/converter-comparison";
import { CONVERTERS } from "@/lib/domain/sources/crawl-rules";
import { requireAdmin } from "@/lib/security/require-admin";

const PAGE = "/compare/converters";

const checkbox = z.literal("on").optional().transform((v) => v === "on");
const ratingFormSchema = z.object({
  sampleId: z.uuid(),
  converter: z.enum(CONVERTERS),
  mainContent: checkbox,
  boilerplateRemoved: checkbox,
  // "Keine Tabellen" (empty) means the page has none: the criterion does not count for it.
  tablesKept: z.enum(["", "yes", "no"]).transform((v) => (v === "" ? null : v === "yes")),
});

/** "Speichern" of one column: the rating of that converter's output; back to the same page. */
export async function rateOutputAction(formData: FormData): Promise<void> {
  const admin = await requireAdmin();
  const parsed = ratingFormSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) {
    // Back to the open page when its id is valid (only a tampered form gets here at all).
    const sample = z.uuid().safeParse(formData.get("sampleId"));
    return redirect(sample.success ? `${PAGE}?sample=${sample.data}&error=invalid_rating` : `${PAGE}?error=invalid_rating`);
  }
  const { sampleId, converter, ...rating } = parsed.data;
  try {
    await rateConverterOutput(getDb(), { sampleId, converter, rating, by: admin.email });
  } catch (e) {
    if (e instanceof OutputNotRateable) return redirect(`${PAGE}?sample=${sampleId}&error=not_rateable`);
    throw e;
  }
  revalidatePath(PAGE);
  redirect(`${PAGE}?sample=${sampleId}#${converter}`);
}
