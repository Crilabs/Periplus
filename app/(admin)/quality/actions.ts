"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getConfig } from "@/lib/config";
import { getDb } from "@/lib/db/client";
import { addToComparisonSet, removeFromComparisonSet } from "@/lib/domain/comparison";
import { requireAdmin } from "@/lib/security/require-admin";

const toggleSchema = z.object({
  placeId: z.uuid(),
  areaKey: z.string().refine((key) => getConfig().areas.some((a) => a.key === key), "unknown area"),
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
