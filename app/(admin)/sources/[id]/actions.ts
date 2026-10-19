"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z, ZodError } from "zod";
import { getArchive } from "@/lib/adapters/s3";
import { getDb } from "@/lib/db/client";
import { changeRateEnum, DOC_TYPES } from "@/lib/db/schema";
import type { CrawlRules } from "@/lib/domain/sources/crawl-rules";
import { NotAPdf, pauseSource, resumeSource, updateSourceSettings, uploadPdf } from "@/lib/domain/sources/store";
import { getBoss } from "@/lib/jobs/boss";
import { startFetchRun, startTestCrawl, startUploadFetchRun } from "@/lib/pipeline/fetch/run";
import { requireAdmin } from "@/lib/security/require-admin";
import { parseCrawlRulesForm } from "../../_components/crawl-rules-fields";
import { startAndRedirect } from "../../_components/run-start";

/** Largest PDF the source page accepts (the server action body limit in `next.config.ts` is the same). */
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

const sourceIdSchema = z.object({ sourceId: z.uuid() });

const settingsFieldsSchema = z.object({
  name: z.string().trim().min(1).max(200),
  type: z.enum(DOC_TYPES),
  // A blank field is invalid, never 0.
  weight: z.string().trim().min(1).pipe(z.coerce.number<string>().min(0).max(1)),
  changeRate: z.enum(changeRateEnum.enumValues),
});

const sourceIdOf = (formData: FormData) => sourceIdSchema.parse({ sourceId: formData.get("sourceId") }).sourceId;
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
  await updateSourceSettings(getDb(), sourceId, { ...values.data, crawlRules });
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

/** "Fortsetzen": only a paused source; any other status comes back with an error. */
export async function resumeSourceAction(formData: FormData): Promise<void> {
  await requireAdmin();
  const sourceId = sourceIdOf(formData);
  const changed = await resumeSource(getDb(), sourceId);
  revalidatePath(sourcePath(sourceId));
  redirect(changed ? sourcePath(sourceId) : `${sourcePath(sourceId)}?error=not_paused`);
}

/** "Testcrawl 10 Seiten". A refusal (not approved, already being fetched) comes back as a German error. */
export async function testCrawlAction(formData: FormData): Promise<void> {
  const admin = await requireAdmin();
  const sourceId = sourceIdOf(formData);
  const db = getDb();
  const boss = await getBoss();
  await startAndRedirect(() => startTestCrawl(db, boss, sourceId, admin.email), sourcePath(sourceId));
}

/** "Crawlen": a full crawl of this source. A refusal comes back as a German error. */
export async function crawlAction(formData: FormData): Promise<void> {
  const admin = await requireAdmin();
  const sourceId = sourceIdOf(formData);
  const db = getDb();
  const boss = await getBoss();
  await startAndRedirect(() => startFetchRun(db, boss, { sourceIds: [sourceId], triggeredBy: admin.email }), sourcePath(sourceId));
}

/** "PDF hochladen": stores the file (at most 100 MB, must be a PDF) and starts its upload run. */
export async function uploadPdfAction(formData: FormData): Promise<void> {
  const admin = await requireAdmin();
  const sourceId = sourceIdOf(formData);
  const file = formData.get("file");
  if (!(file instanceof Blob) || file.size === 0) return redirect(`${sourcePath(sourceId)}?error=no_file`);
  if (file.size > MAX_UPLOAD_BYTES) return redirect(`${sourcePath(sourceId)}?error=too_large`);
  const db = getDb();
  let documentId: string;
  try {
    ({ documentId } = await uploadPdf(db, getArchive(), { sourceId, bytes: new Uint8Array(await file.arrayBuffer()) }));
  } catch (e) {
    if (!(e instanceof NotAPdf)) throw e;
    return redirect(`${sourcePath(sourceId)}?error=not_pdf`);
  }
  const boss = await getBoss();
  revalidatePath(sourcePath(sourceId));
  await startAndRedirect(() => startUploadFetchRun(db, boss, documentId, admin.email), sourcePath(sourceId));
}
