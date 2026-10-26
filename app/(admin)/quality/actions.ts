"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { getDb } from "@/lib/db/client";
import { saveComparisonSelection } from "@/lib/domain/comparison";
import { subdivisionByKey } from "@/lib/domain/subdivisions/store";
import { requireAdmin } from "@/lib/security/require-admin";

/** A valid subdivision key (a leftover area key, an unknown or an ended subdivision is invalid input). */
const subdivisionKeySchema = z.string().refine(async (key) => (await subdivisionByKey(getDb(), key)) !== null, "unknown subdivision");
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
