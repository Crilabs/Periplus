"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { getDb } from "@/lib/db/client";
import { getBoss } from "@/lib/jobs/boss";
import { startLandRun } from "@/lib/pipeline/gazetteer/stages";
import { startImageRun } from "@/lib/pipeline/images-run";
import { startResearchRun } from "@/lib/pipeline/research-run";
import { queueCountry, startSubdivisionBuild } from "@/lib/pipeline/subdivision-build";
import { startSubdivisionsBuildRun } from "@/lib/pipeline/subdivisions-run";
import { requireAdmin } from "@/lib/security/require-admin";
import { startAndRedirect } from "../_components/run-start";

const fields = (input: FormData | object) => (input instanceof FormData ? Object.fromEntries(input) : input);

const buildSchema = z.object({ subdivisionKey: z.string().min(1) });

/**
 * „Aufbauen“ for one subdivision (also a built one): starts its build and goes to the run; a build already queued or
 * running is opened instead of a second one. An unknown or excluded subdivision is refused by the starter.
 */
export async function buildSubdivisionAction(input: FormData | { subdivisionKey: string }): Promise<void> {
  const admin = await requireAdmin();
  const { subdivisionKey } = buildSchema.parse(fields(input));
  const started = await startSubdivisionBuild(getDb(), await getBoss(), subdivisionKey, admin.email);
  revalidatePath("/subdivisions");
  revalidatePath("/runs");
  redirect(`/runs/${"id" in started ? started.id : started.alreadyRunning}`);
}

const countrySchema = z.object({ country: z.string().regex(/^[A-Z]{2}$/) });

/** „Alle offenen aufbauen“ for one country: queues its never-built subdivisions and starts the first one. */
export async function queueCountryAction(input: FormData | { country: string }): Promise<void> {
  const admin = await requireAdmin();
  const { country } = countrySchema.parse(fields(input));
  const { queued } = await queueCountry(getDb(), await getBoss(), country, admin.email);
  revalidatePath("/subdivisions");
  redirect(`/subdivisions?queued=${queued}&country=${country}`);
}

/** „nur Länder“: country codes separated by commas or spaces, any case; empty for all countries. */
const rebuildSchema = z.object({
  countries: z
    .string()
    .optional()
    .transform((v) => (v ?? "").split(/[\s,;]+/).filter(Boolean).map((c) => c.toUpperCase()))
    .pipe(z.array(z.string().regex(/^[A-Z]{2}$/))),
});

/**
 * „Landesteile neu bilden“: the system run of seas, coarse gazetteer (countries, admin regions, coarse features),
 * `subdivisions.build` and the assignment of the coarse objects; built subdivisions are never replaced, only reported.
 * „nur Länder“ fetches only these countries again (one that failed). Goes to the run; without land polygons or with an
 * unconfigured country it comes back to the list with a German message.
 */
export async function rebuildSubdivisionsAction(input: FormData | { countries?: string } = {}): Promise<void> {
  const admin = await requireAdmin();
  const parsed = rebuildSchema.safeParse(fields(input));
  if (!parsed.success) return redirect("/subdivisions?error=unknown_country");
  const { countries } = parsed.data;
  const db = getDb();
  const boss = await getBoss();
  await startAndRedirect(
    () => startSubdivisionsBuildRun(db, boss, admin.email, countries.length > 0 ? { countries } : {}),
    "/subdivisions",
  );
}

/**
 * „Titelbilder erzeugen“ for one Landesteil: an image run of the title images of its spots (the plan skips images whose
 * generation key is done, at most `images.pipeline.maxGenerationsPerRun` per run). Goes to the run.
 */
export async function startSubdivisionImagesAction(input: FormData | { subdivisionKey: string }): Promise<void> {
  const admin = await requireAdmin();
  const { subdivisionKey } = buildSchema.parse(fields(input));
  const db = getDb();
  const boss = await getBoss();
  await startAndRedirect(() => startImageRun(db, boss, { subdivisionKey }, admin.email), `/subdivisions/${encodeURIComponent(subdivisionKey)}`);
}

/**
 * „Recherche starten“ for one Landesteil: a research run (search, fetch, assess) of its candidate berths. Goes to the
 * run; a Landesteil without candidates comes back with a German message.
 */
export async function startSubdivisionResearchAction(input: FormData | { subdivisionKey: string }): Promise<void> {
  const admin = await requireAdmin();
  const { subdivisionKey } = buildSchema.parse(fields(input));
  const db = getDb();
  const boss = await getBoss();
  await startAndRedirect(() => startResearchRun(db, boss, { subdivisionKey }, admin.email), `/subdivisions/${encodeURIComponent(subdivisionKey)}`);
}

/**
 * „Dinge an Land laden“ for one Landesteil: a run of the stage `gazetteer.land` (N7 4.4) around its research
 * candidates. Goes to the run; a Landesteil without candidates comes back with a German message.
 */
export async function startSubdivisionLandAction(input: FormData | { subdivisionKey: string }): Promise<void> {
  const admin = await requireAdmin();
  const { subdivisionKey } = buildSchema.parse(fields(input));
  const db = getDb();
  const boss = await getBoss();
  await startAndRedirect(() => startLandRun(db, boss, { subdivisionKey }, admin.email), `/subdivisions/${encodeURIComponent(subdivisionKey)}`);
}
