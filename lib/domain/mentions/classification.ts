import { and, eq, isNull, ne, or, sql } from "drizzle-orm";
import { resolveTaskModel } from "@/lib/ai/cost";
import { classifyDocumentTask, type ClassifyDocumentOutput } from "@/lib/ai/tasks/classify-document";
import { getConfig, type AppConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { documents, documentVersions } from "@/lib/db/schema";
import type { DocType, ObservedAtBasis } from "@/lib/db/schema/sources";

/*
 * Document classification (spec 06, ruling M4-P11): stored on the version in the technical `classified_*` columns, the
 * only ones its append-only trigger releases; the fetch-time columns never change. "Ohne explizites Beobachtungsdatum
 * gilt `published_at`, sonst Abrufdatum"; "Mai 2024" → `2024-05-15`.
 */

const MAX_LANGUAGES = 5;
const MAX_AREAS = 10;
const MAX_REASON_CHARS = 300;
const LANGUAGE = /^[a-z]{2}$/;
const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const MONTH = /^(\d{4})-(\d{2})$/;
/** Day a month-only observation is placed on. */
const MID_MONTH = 15;

/** The text up to the end of its `n`-th word (words = runs of non-whitespace). */
export function firstWords(md: string, n: number): string {
  if (n <= 0) return "";
  let count = 0;
  for (const m of md.matchAll(/\S+/g)) {
    if (++count === n) return md.slice(0, m.index + m[0].length).trim();
  }
  return md.trim();
}

/** A real calendar date `YYYY-MM-DD`, or `null`. */
function calendarDate(y: number, m: number, d: number): string | null {
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null;
  return date.toISOString().slice(0, 10);
}

/**
 * A model date as `YYYY-MM-DD` (a month `YYYY-MM` only when `allowMonth`, placed on day 15, or on the fetch date when
 * that is earlier in the fetch month, ruling M4-D-R3), kept only between `earliest` and the fetch date; anything else
 * is `null`. Also used for the observation dates of extracted facts.
 */
export function plausibleDate(value: string | null, fetchedAt: Date, earliest: string, allowMonth: boolean): string | null {
  if (value === null) return null;
  const v = value.trim();
  const fetched = fetchedAt.toISOString().slice(0, 10);
  const day = DAY.exec(v);
  const month = allowMonth ? MONTH.exec(v) : null;
  let date = day
    ? calendarDate(Number(day[1]), Number(day[2]), Number(day[3]))
    : month
      ? calendarDate(Number(month[1]), Number(month[2]), MID_MONTH)
      : null;
  if (month && date !== null && date > fetched && date.slice(0, 7) === fetched.slice(0, 7)) date = fetched;
  if (date === null || date < earliest || date > fetched) return null;
  return date;
}

/**
 * The observation date of a classified version: the explicit observation date of the text (only with
 * `observed_at_explicit`), else the stated publication date, else the fetch date. A month becomes day 15; a date
 * before `earliest` or after the fetch date is ignored.
 */
export function resolveObservedAt(
  out: Pick<ClassifyDocumentOutput, "observed_at" | "observed_at_explicit" | "published_at">,
  fetchedAt: Date,
  earliest: string,
): { observedAt: string; basis: ObservedAtBasis; publishedAt: string | null } {
  const publishedAt = plausibleDate(out.published_at, fetchedAt, earliest, false);
  const explicit = out.observed_at_explicit ? plausibleDate(out.observed_at, fetchedAt, earliest, true) : null;
  if (explicit) return { observedAt: explicit, basis: "explicit", publishedAt };
  if (publishedAt) return { observedAt: publishedAt, basis: "published", publishedAt };
  return { observedAt: fetchedAt.toISOString().slice(0, 10), basis: "fetched", publishedAt };
}

function cleanList(values: string[], max: number, keep: (v: string) => boolean = () => true): string[] {
  return [...new Set(values.map((v) => v.trim()).filter((v) => v.length > 0 && keep(v)))].slice(0, max);
}

/** The model and prompt version the configuration classifies with now. */
export function activeClassifier(config: AppConfig = getConfig()): { model: string; promptVersion: number } {
  const { model, taskConfig } = resolveTaskModel(config, classifyDocumentTask.name);
  return { model, promptVersion: taskConfig.promptVersion };
}

/**
 * Stores a classification on the version (conditional update, ruling M4-P11): only a result of the active model and
 * prompt version (`active`) writes, so a late batch of an older configuration never overwrites a newer
 * classification; a version already classified by the same model and prompt version is left as it is, so a repeated
 * or doubled distribution changes nothing. Languages are ISO 639-1 codes (≤ 5), areas ≤ 10, the reason ≤ 300
 * characters. Returns whether the version was written.
 */
export async function storeClassification(
  db: Db,
  versionId: string,
  out: ClassifyDocumentOutput,
  meta: { model: string; promptVersion: number; runId: string; fetchedAt: Date },
  earliest: string = getConfig().extraction.earliestDate,
  active: { model: string; promptVersion: number } = activeClassifier(),
): Promise<boolean> {
  if (meta.model !== active.model || meta.promptVersion !== active.promptVersion) return false;
  const observed = resolveObservedAt(out, meta.fetchedAt, earliest);
  const reason = out.observed_at_reason?.trim().slice(0, MAX_REASON_CHARS) || null;
  const written = await db
    .update(documentVersions)
    .set({
      classifiedDocType: out.doc_type,
      classifiedLanguages: cleanList(
        out.languages.map((l) => l.toLowerCase()),
        MAX_LANGUAGES,
        (l) => LANGUAGE.test(l),
      ),
      classifiedPublishedAt: observed.publishedAt,
      classifiedObservedAt: observed.observedAt,
      classifiedObservedAtBasis: observed.basis,
      observedAtReason: observed.basis === "explicit" ? reason : null,
      areaHints: cleanList(out.areas, MAX_AREAS),
      classifiedModel: meta.model,
      classifiedPromptVersion: meta.promptVersion,
      classifiedRunId: meta.runId,
      classifiedAt: sql`now()`,
    })
    .where(
      and(
        eq(documentVersions.id, versionId),
        or(
          isNull(documentVersions.classifiedModel),
          ne(documentVersions.classifiedModel, meta.model),
          isNull(documentVersions.classifiedPromptVersion),
          ne(documentVersions.classifiedPromptVersion, meta.promptVersion),
        ),
      ),
    )
    .returning({ id: documentVersions.id });
  return written.length > 0;
}

export type EffectiveVersionMeta = {
  docType: DocType;
  languages: string[];
  observedAt: string;
  basis: ObservedAtBasis;
  areaHints: string[];
  sourceId: string;
  fetchedAt: Date;
};

/** Type, languages, observation date and area hints of a version: its classification, else its fetch-time columns. */
export async function effectiveVersionMeta(db: Db, versionId: string): Promise<EffectiveVersionMeta> {
  const [row] = await db
    .select({ version: documentVersions, sourceId: documents.sourceId })
    .from(documentVersions)
    .innerJoin(documents, eq(documents.id, documentVersions.documentId))
    .where(eq(documentVersions.id, versionId));
  if (!row) throw new Error(`document version ${versionId} does not exist`);
  const v = row.version;
  return {
    docType: v.classifiedDocType ?? v.docType,
    languages: v.classifiedLanguages?.length ? v.classifiedLanguages : v.language ? [v.language] : [],
    observedAt: v.classifiedObservedAt ?? v.observedAt,
    basis: v.classifiedObservedAtBasis ?? v.observedAtBasis,
    areaHints: v.areaHints ?? [],
    sourceId: row.sourceId,
    fetchedAt: v.fetchedAt,
  };
}
