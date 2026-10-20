import { readFile } from "node:fs/promises";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import type { Archive } from "@/lib/adapters/s3";
import { getConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { changeSeverityEnum, changeTypeEnum, documents, documentVersions } from "@/lib/db/schema";
import { contentHash, normalizeMarkdown } from "@/lib/domain/documents/normalize";
import { normalizeUrl } from "@/lib/domain/sources/urls";

const nonBlank = z.string().refine((s) => s.trim() !== "", "must not be blank");

export const scenarioEditSchema = z.discriminatedUnion("op", [
  z.strictObject({ op: z.literal("replace"), from: nonBlank, to: z.string() }),
  z.strictObject({ op: z.literal("delete"), text: nonBlank }),
  z.strictObject({ op: z.literal("append"), text: nonBlank }),
  z.strictObject({ op: z.literal("gone") }),
  z.strictObject({ op: z.literal("touch") }),
]);

export const expectedEventSchema = z.strictObject({
  /** Public id of the place, region, area or POI the event is about. */
  subject: z.string().regex(/^(sp|rg|ar|hl)_[0-9A-Za-z]+$/, "must be a public id sp_/rg_/ar_/hl_"),
  /** Attribute key; `<prefix>.*` matches every attribute under the prefix (e.g. `depth.*`); null for the object itself. */
  attribute: z.string().min(1).nullable(),
  type: z.enum(changeTypeEnum.enumValues),
  severity: z.enum(changeSeverityEnum.enumValues),
});

export const scenarioEntrySchema = z.strictObject({
  id: z.string().min(1),
  url: z.url({ protocol: /^https?$/ }),
  edit: scenarioEditSchema,
  expect: z.strictObject({
    document: z.enum(["new_version", "gone", "unchanged"]),
    events: z.array(expectedEventSchema),
  }),
  note: z.string().optional(),
});

/** The URL as the crawl stores it (`documents.url_normalized`); the URL itself when it does not normalize. */
export function scenarioUrlKey(url: string): string {
  return normalizeUrl(url, getConfig().fetch.trackingParams) ?? url;
}

export const revisitScenarioSchema = z
  .strictObject({ name: z.string().min(1), entries: z.array(scenarioEntrySchema).min(1) })
  .superRefine((scenario, ctx) => {
    const ids = new Set<string>();
    const urls = new Set<string>();
    scenario.entries.forEach((entry, i) => {
      if (ids.has(entry.id)) ctx.addIssue({ code: "custom", path: ["entries", i, "id"], message: `duplicate entry id ${entry.id}` });
      ids.add(entry.id);
      const key = scenarioUrlKey(entry.url);
      if (urls.has(key)) ctx.addIssue({ code: "custom", path: ["entries", i, "url"], message: `duplicate url ${key}` });
      urls.add(key);
    });
  });

export type ScenarioEdit = z.infer<typeof scenarioEditSchema>;
export type ExpectedEvent = z.infer<typeof expectedEventSchema>;
export type ScenarioEntry = z.infer<typeof scenarioEntrySchema>;
export type RevisitScenario = z.infer<typeof revisitScenarioSchema>;

/** Reads and validates a scenario file; an invalid one fails with the path and the zod issues. */
export async function loadScenario(path: string): Promise<RevisitScenario> {
  const text = await readFile(path, "utf8");
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new Error(`scenario ${path} is not valid JSON`, { cause: error });
  }
  const parsed = revisitScenarioSchema.safeParse(json);
  if (!parsed.success) throw new Error(`scenario ${path} is invalid: ${z.prettifyError(parsed.error)}`);
  return parsed.data;
}

/** A `replace`/`delete` whose text the page does not contain. */
export class ScenarioEditNotApplicable extends Error {
  constructor(url: string, text: string) {
    super(`scenario edit for ${url}: text not found: "${text}"`);
    this.name = "ScenarioEditNotApplicable";
  }
}

/** A `replace`/`delete` whose text the page contains more than once. */
export class ScenarioEditAmbiguous extends Error {
  constructor(url: string, text: string, count: number) {
    super(`scenario edit for ${url}: text found ${count} times: "${text}"`);
    this.name = "ScenarioEditAmbiguous";
  }
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The one span of `markdown` that matches `text` up to whitespace (any run of whitespace matches any other). */
function findOnce(markdown: string, text: string, url: string): { start: number; end: number } {
  const pattern = new RegExp(text.trim().split(/\s+/).map(escapeRegExp).join("\\s+"), "g");
  const matches = [...markdown.matchAll(pattern)];
  if (matches.length === 0) throw new ScenarioEditNotApplicable(url, text);
  if (matches.length > 1) throw new ScenarioEditAmbiguous(url, text, matches.length);
  const start = matches[0]!.index;
  return { start, end: start + matches[0]![0].length };
}

/**
 * The page's Markdown after the scenario edit. `replace`/`delete` need their text exactly once (compared with
 * whitespace runs as equal; the original around it is kept); `append` adds a paragraph at the end; `touch` adds
 * only trailing whitespace (the normalized content hash stays the same). `gone` has no text (the page answers 404).
 */
export function applyEdit(markdown: string, edit: ScenarioEdit, url: string): string {
  switch (edit.op) {
    case "replace": {
      const { start, end } = findOnce(markdown, edit.from, url);
      return markdown.slice(0, start) + edit.to + markdown.slice(end);
    }
    case "delete": {
      const { start, end } = findOnce(markdown, edit.text, url);
      return markdown.slice(0, start) + markdown.slice(end);
    }
    case "append":
      return `${markdown.replace(/\s+$/, "")}\n\n${edit.text.trim()}\n`;
    case "touch":
      return `${markdown} \n\n`;
    case "gone":
      throw new Error(`scenario edit for ${url}: gone has no text to edit`);
  }
}

/**
 * The newest version of the document that was really fetched (`simulated = false`) and its Markdown: the base every
 * simulated fetch edits (ruling M7-P9), so a second fetch yields the same text instead of editing the edit.
 */
export async function recordedVersion(
  db: Db,
  archive: Archive,
  documentId: string,
): Promise<{ id: string; markdown: string } | null> {
  const [version] = await db
    .select({ id: documentVersions.id, mdKey: documentVersions.mdKey })
    .from(documentVersions)
    .where(and(eq(documentVersions.documentId, documentId), eq(documentVersions.simulated, false)))
    .orderBy(desc(documentVersions.fetchedAt), desc(documentVersions.id))
    .limit(1);
  if (!version) return null;
  const md = await archive.get(version.mdKey);
  if (!md) throw new Error(`archived markdown ${version.mdKey} is missing`);
  return { id: version.id, markdown: new TextDecoder().decode(md) };
}

export type PreflightResult = { entryId: string; documentId: string | null; ok: boolean; error?: string };

/**
 * Checks a scenario against the database before a simulated revisit: every URL (normalized, once) is a known active
 * document with a current version, its edit applies to the recorded version, and a simulated version that exists
 * already has exactly the edited text (a repeated revisit), never another one.
 */
export async function preflightScenario(db: Db, archive: Archive, scenario: RevisitScenario): Promise<PreflightResult[]> {
  const seen = new Set<string>();
  const results: PreflightResult[] = [];
  for (const entry of scenario.entries) {
    const key = scenarioUrlKey(entry.url);
    if (seen.has(key)) {
      results.push({ entryId: entry.id, documentId: null, ok: false, error: `duplicate url ${key}` });
      continue;
    }
    seen.add(key);
    const [doc] = await db
      .select({ id: documents.id, status: documents.status, currentVersionId: documents.currentVersionId })
      .from(documents)
      .where(eq(documents.urlNormalized, key));
    const fail = (error: string): PreflightResult => ({ entryId: entry.id, documentId: doc?.id ?? null, ok: false, error });
    if (!doc) {
      results.push(fail(`no document for ${key}`));
      continue;
    }
    if (doc.status !== "active" || !doc.currentVersionId) {
      results.push(fail(`document for ${key} is ${doc.status}${doc.currentVersionId ? "" : " without a current version"}`));
      continue;
    }
    const recorded = await recordedVersion(db, archive, doc.id);
    if (!recorded) {
      results.push(fail(`document for ${key} has no recorded version`));
      continue;
    }
    if (entry.edit.op !== "gone") {
      let edited: string;
      try {
        edited = applyEdit(recorded.markdown, entry.edit, entry.url);
      } catch (error) {
        results.push(fail((error as Error).message));
        continue;
      }
      const hash = contentHash(normalizeMarkdown(edited));
      const simulated = await db
        .select({ contentHash: documentVersions.contentHash })
        .from(documentVersions)
        .where(and(eq(documentVersions.documentId, doc.id), eq(documentVersions.simulated, true)));
      if (simulated.some((v) => v.contentHash !== hash)) {
        results.push(fail(`document for ${key} has a simulated version with another text`));
        continue;
      }
    }
    results.push({ entryId: entry.id, documentId: doc.id, ok: true });
  }
  return results;
}
