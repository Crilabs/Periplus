"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { getConfig } from "@/lib/config";
import { getDb } from "@/lib/db/client";
import { DOC_TYPES } from "@/lib/db/schema";
import { tileExists } from "@/lib/domain/geo-view";
import { ForbiddenSourceDomain } from "@/lib/domain/sources/forbidden-domains";
import { createManualSource, InvalidSourceDomain, SourceDomainKnown } from "@/lib/domain/sources/store";
import { getBoss } from "@/lib/jobs/boss";
import { startDiscoveryRun, startProposalRun } from "@/lib/pipeline/discovery-run";
import { startEmbedBackfillRun, startFetchRun, startWikivoyageRun } from "@/lib/pipeline/fetch/run";
import { startTextRun } from "@/lib/pipeline/text/run";
import { RunScopeNotReady } from "@/lib/pipeline/tile-scope";
import { requireAdmin } from "@/lib/security/require-admin";
import { startAndRedirect } from "../_components/run-start";

const fields = (input: FormData | object) => (input instanceof FormData ? Object.fromEntries(input) : input);

const areaSchema = z.object({
  areaKey: z.string().refine((key) => getConfig().areas.some((a) => a.key === key), "unknown area"),
});
const tileSchema = z.object({ tileId: z.string().regex(/^q025:\d+:\d+$/) });
const newSourceSchema = z.object({
  domain: z.string().trim().min(1).max(500),
  name: z.string().trim().min(1).max(200),
  type: z.enum(DOC_TYPES),
});

/**
 * "Neue Quelle": an approved manual source for the registrable domain; a known or forbidden domain comes back with an
 * error.
 */
export async function createSourceAction(formData: FormData): Promise<void> {
  await requireAdmin();
  const parsed = newSourceSchema.safeParse(fields(formData));
  if (!parsed.success) return redirect("/sources?error=invalid_source");
  let target: string;
  try {
    const { id } = await createManualSource(getDb(), parsed.data);
    target = `/sources/${id}`;
  } catch (e) {
    if (e instanceof SourceDomainKnown) target = "/sources?error=domain_known";
    else if (e instanceof InvalidSourceDomain) target = "/sources?error=invalid_domain";
    else if (e instanceof ForbiddenSourceDomain) target = "/sources?error=forbidden_domain";
    else throw e;
  }
  revalidatePath("/sources");
  redirect(target);
}

/**
 * "Alle freigegebenen crawlen": one crawl run over every approved source. Sources another run is fetching are
 * skipped (ruling M3-D-R3) and named on the sources page (`?run=<id>&skipped=<ids>`).
 */
export async function crawlAllApprovedAction(): Promise<void> {
  const admin = await requireAdmin();
  let target: string;
  try {
    const { id, skipped } = await startFetchRun(getDb(), await getBoss(), {
      sourceIds: "approved",
      triggeredBy: admin.email,
      skipBusy: true,
    });
    target = `/sources?run=${id}${skipped.length > 0 ? `&skipped=${skipped.join(",")}` : ""}`;
  } catch (e) {
    if (!(e instanceof RunScopeNotReady)) throw e;
    target = `/sources?error=${e.reason}`;
  }
  revalidatePath("/runs");
  revalidatePath("/sources");
  redirect(target);
}

/** "Quellenfindung" for a configured area. */
export async function discoveryAreaAction(input: FormData | { areaKey: string }): Promise<void> {
  const admin = await requireAdmin();
  const { areaKey } = areaSchema.parse(fields(input));
  const db = getDb();
  const boss = await getBoss();
  await startAndRedirect(() => startDiscoveryRun(db, boss, { areaKey }, admin.email), "/sources");
}

/** "Quellenfindung" for one existing tile (button of the tile page); refusals return to the tile page. */
export async function discoveryTileAction(input: FormData | { tileId: string }): Promise<void> {
  const admin = await requireAdmin();
  const db = getDb();
  const { tileId } = await tileSchema.refine(({ tileId }) => tileExists(db, tileId), "unknown tile").parseAsync(fields(input));
  const boss = await getBoss();
  await startAndRedirect(() => startDiscoveryRun(db, boss, { tileId }, admin.email), `/tiles/${encodeURIComponent(tileId)}`);
}

/** "Linkgraph-Vorschläge": proposals from SERP hits and the link graph collected so far. */
export async function proposalRunAction(): Promise<void> {
  const admin = await requireAdmin();
  const db = getDb();
  const boss = await getBoss();
  await startAndRedirect(() => startProposalRun(db, boss, admin.email), "/sources");
}

/** "Wikivoyage" for a configured area. */
export async function wikivoyageRunAction(input: FormData | { areaKey: string }): Promise<void> {
  const admin = await requireAdmin();
  const { areaKey } = areaSchema.parse(fields(input));
  const db = getDb();
  const boss = await getBoss();
  await startAndRedirect(() => startWikivoyageRun(db, boss, areaKey, admin.email), "/sources");
}

/** "Einbettungen nachholen": embeds every chunk still without an embedding. */
export async function embedBackfillAction(): Promise<void> {
  const admin = await requireAdmin();
  const db = getDb();
  const boss = await getBoss();
  await startAndRedirect(() => startEmbedBackfillRun(db, boss, admin.email), "/sources");
}

/**
 * "Neue Texte auswerten": a text run over every current version (of all sources) the match has not passed with the
 * current configuration; with nothing to do it still starts and finishes at once.
 */
export async function pendingTextRunAction(): Promise<void> {
  const admin = await requireAdmin();
  const db = getDb();
  const boss = await getBoss();
  await startAndRedirect(() => startTextRun(db, boss, { pending: true, triggeredBy: admin.email }), "/sources");
}
