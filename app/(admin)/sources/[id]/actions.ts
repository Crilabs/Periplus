"use server";

import { revalidatePath } from "next/cache";
import { notFound, redirect } from "next/navigation";
import { z, ZodError } from "zod";
import { getDb } from "@/lib/db/client";
import { changeRateEnum, DOC_TYPES } from "@/lib/db/schema";
import type { CrawlRules } from "@/lib/domain/sources/crawl-rules";
import { ForbiddenSourceDomain } from "@/lib/domain/sources/forbidden-domains";
import {
  endSource,
  pauseSource,
  resumeSource,
  SourceEnded,
  updateSourceSettings,
} from "@/lib/domain/sources/store";
import { requireAdmin } from "@/lib/security/require-admin";
import { parseCrawlRulesForm } from "../../_components/crawl-rules-fields";

const sourceIdSchema = z.object({ sourceId: z.uuid() });

const settingsFieldsSchema = z.object({
  name: z.string().trim().min(1).max(200),
  type: z.enum(DOC_TYPES),
  // A blank field is invalid, never 0.
  weight: z.string().trim().min(1).pipe(z.coerce.number<string>().min(0).max(1)),
  changeRate: z.enum(changeRateEnum.enumValues),
});

/** The form's `sourceId`; a malformed one (only tampered input) is a 404, like the page of that id. */
function sourceIdOf(formData: FormData): string {
  const parsed = sourceIdSchema.safeParse({ sourceId: formData.get("sourceId") });
  if (!parsed.success) notFound();
  return parsed.data.sourceId;
}
const sourcePath = (sourceId: string) => `/sources/${sourceId}`;

/**
 * Saves name, type, weight, change rate and crawl rules from the settings form. Invalid fields redirect back with
 * `?invalid=<field>,…` and write nothing.
 */
export async function saveSourceAction(formData: FormData): Promise<void> {
  await requireAdmin();
  const sourceId = sourceIdOf(formData);
  const values = settingsFieldsSchema.safeParse({
    name: formData.get("name") ?? "",
    type: formData.get("type"),
    weight: formData.get("weight") ?? "",
    changeRate: formData.get("changeRate"),
  });
  const invalid = values.success ? [] : values.error.issues.map((i) => String(i.path[0]));
  let crawlRules: CrawlRules | undefined;
  try {
    crawlRules = parseCrawlRulesForm(formData);
  } catch (e) {
    if (!(e instanceof ZodError)) throw e;
    invalid.push(...e.issues.map((i) => String(i.path[0])));
  }
  if (!values.success || !crawlRules) {
    return redirect(`${sourcePath(sourceId)}?invalid=${[...new Set(invalid)].join(",")}`);
  }
  try {
    await updateSourceSettings(getDb(), sourceId, { ...values.data, crawlRules });
  } catch (e) {
    if (!(e instanceof SourceEnded)) throw e;
    return redirect(`${sourcePath(sourceId)}?error=source_ended`);
  }
  revalidatePath(sourcePath(sourceId));
  redirect(`${sourcePath(sourceId)}?saved=1`);
}

/** "Pausieren": only an approved source; any other status comes back with an error. */
export async function pauseSourceAction(formData: FormData): Promise<void> {
  await requireAdmin();
  const sourceId = sourceIdOf(formData);
  const changed = await pauseSource(getDb(), sourceId);
  revalidatePath(sourcePath(sourceId));
  redirect(changed ? sourcePath(sourceId) : `${sourcePath(sourceId)}?error=not_approved`);
}

/** "Fortsetzen": only a paused source on an allowed domain; anything else comes back with an error. */
export async function resumeSourceAction(formData: FormData): Promise<void> {
  await requireAdmin();
  const sourceId = sourceIdOf(formData);
  let target: string;
  try {
    const changed = await resumeSource(getDb(), sourceId);
    target = changed ? sourcePath(sourceId) : `${sourcePath(sourceId)}?error=not_paused`;
  } catch (e) {
    if (!(e instanceof ForbiddenSourceDomain)) throw e;
    target = `${sourcePath(sourceId)}?error=forbidden_domain`;
  }
  revalidatePath(sourcePath(sourceId));
  redirect(target);
}

/**
 * „Quelle beenden“ (ruling M6-H-R1): ends an approved or paused source (`endSource`). Back to the source with
 * `?ended=<n objects>` (the objects that had facts from it); `?error=not_endable` for any other status.
 */
export async function endSourceAction(formData: FormData): Promise<void> {
  await requireAdmin();
  const sourceId = sourceIdOf(formData);
  const result = await endSource(getDb(), sourceId);
  revalidatePath(sourcePath(sourceId));
  if (!result.ended) return redirect(`${sourcePath(sourceId)}?error=not_endable`);
  redirect(`${sourcePath(sourceId)}?ended=${result.geoObjectIds.length}`);
}
