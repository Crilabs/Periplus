import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { and, asc, eq, ne } from "drizzle-orm";
import { z } from "zod";
import type { Archive } from "@/lib/adapters/s3";
import { getConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { changeSeverityEnum, changeTypeEnum, crawlFrontier, documents, documentVersions } from "@/lib/db/schema";
import { contentHash, normalizeMarkdown } from "@/lib/domain/documents/normalize";
import { getSource } from "@/lib/domain/sources/store";
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

const squash = (s: string) => s.trim().replace(/\s+/g, " ");

/** The document outcome each edit kind produces: a scenario typo fails at load, not as a failed verification. */
const DOCUMENT_OF_EDIT = { replace: "new_version", delete: "new_version", append: "new_version", gone: "gone", touch: "unchanged" } as const;

/**
 * A simulated revisit: one entry per recorded page it changes. Kinds are text edits of a recorded page (`replace`,
 * `delete`, `append`), a page that disappears (`gone`, 404 on every fetch) and a page fetched again unchanged
 * (`touch`). A new page is not a kind: the simulated fetch replays recorded pages only and discovers no links.
 * Scenario files in the repo are synthetic (invented text on `*.test.invalid`); a real pilot scenario quotes
 * third-party pages verbatim and lives under the git-ignored `data/sim/` (run book, step 23), never in the repo.
 */
export const revisitScenarioSchema = z
  .strictObject({ name: z.string().min(1), entries: z.array(scenarioEntrySchema).min(1) })
  .superRefine((scenario, ctx) => {
    const ids = new Set<string>();
    const urls = new Set<string>();
    scenario.entries.forEach((entry, i) => {
      const document = DOCUMENT_OF_EDIT[entry.edit.op];
      if (entry.expect.document !== document) {
        ctx.addIssue({
          code: "custom",
          path: ["entries", i, "expect", "document"],
          message: `edit ${entry.edit.op} yields document ${document}, not ${entry.expect.document}`,
        });
      }
      if (entry.edit.op === "replace" && squash(entry.edit.from) === squash(entry.edit.to)) {
        ctx.addIssue({ code: "custom", path: ["entries", i, "edit", "to"], message: "replace must change the text (from equals to)" });
      }
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
  return parseScenario((await readScenarioFile(path)).text, path);
}

/**
 * Reads a scenario file and returns its text's SHA-256 (hex) next to the validated scenario: a process caching the
 * scenario keys it by path and this hash, so an edited file is read again instead of answering from the old one.
 */
export async function readScenarioFile(path: string): Promise<{ hash: string; text: string }> {
  const text = await readFile(path, "utf8");
  return { hash: scenarioTextHash(text), text };
}

/** SHA-256 (hex) of a scenario file's text. */
export function scenarioTextHash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** Validates the text of the scenario file at `path` (named in errors only). */
export function parseScenario(text: string, path: string): RevisitScenario {
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

const WORD_CHAR = /[\p{L}\p{N}]/u;

/**
 * The one span of `markdown` that matches `text` up to whitespace (any run of whitespace matches any other), on token
 * boundaries: a text starting or ending with a letter or digit never matches inside a longer word or number
 * ("4 m" does not match in "14 m" or "4 mm").
 */
function findOnce(markdown: string, text: string, url: string): { start: number; end: number } {
  const trimmed = text.trim();
  const before = WORD_CHAR.test(trimmed.at(0)!) ? "(?<![\\p{L}\\p{N}])" : "";
  const after = WORD_CHAR.test(trimmed.at(-1)!) ? "(?![\\p{L}\\p{N}])" : "";
  const pattern = new RegExp(before + trimmed.split(/\s+/).map(escapeRegExp).join("\\s+") + after, "gu");
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

/** The version a simulated fetch of the document starts from. */
export type EditBase = { versionId: string; markdown: string; contentHash: string; simulated: boolean };

/**
 * The document's current version and its Markdown, null without one. A recorded (non-simulated) current version is
 * what the scenario edits (ruling M7-F-R3: the current one, also after a revert A → B → A, never the newest by fetch
 * time); a simulated current version already carries the edit and is answered as it is, so a repeated fetch stays
 * `unchanged` instead of editing the edit (ruling M7-P9).
 */
export async function editBase(db: Db, archive: Archive, documentId: string): Promise<EditBase | null> {
  const [version] = await db
    .select({
      id: documentVersions.id,
      mdKey: documentVersions.mdKey,
      contentHash: documentVersions.contentHash,
      simulated: documentVersions.simulated,
    })
    .from(documents)
    .innerJoin(documentVersions, eq(documentVersions.id, documents.currentVersionId))
    .where(eq(documents.id, documentId));
  if (!version) return null;
  return { versionId: version.id, markdown: await archivedMarkdown(archive, version.mdKey), contentHash: version.contentHash, simulated: version.simulated };
}

async function archivedMarkdown(archive: Archive, mdKey: string): Promise<string> {
  const md = await archive.get(mdKey);
  if (!md) throw new Error(`archived markdown ${mdKey} is missing`);
  return new TextDecoder().decode(md);
}

const hashOf = (markdown: string) => contentHash(normalizeMarkdown(markdown));

/** Whether the edit applied to one of the document's recorded versions yields `hash` (a simulated version's origin). */
async function isEditOfRecorded(db: Db, archive: Archive, documentId: string, entry: ScenarioEntry, hash: string): Promise<boolean> {
  const recorded = await db
    .select({ mdKey: documentVersions.mdKey })
    .from(documentVersions)
    .where(and(eq(documentVersions.documentId, documentId), eq(documentVersions.simulated, false)));
  for (const v of recorded) {
    try {
      if (hashOf(applyEdit(await archivedMarkdown(archive, v.mdKey), entry.edit, entry.url)) === hash) return true;
    } catch (error) {
      if (!(error instanceof ScenarioEditNotApplicable || error instanceof ScenarioEditAmbiguous)) throw error;
    }
  }
  return false;
}

/**
 * Why a revisit of the document's source would not fetch the page, null when it would: the source must be current and
 * approved, and the page's frontier row present, not `skipped` and among the first `maxPages` rows in the order of
 * `planFetchUrls` (depth, discovery). Anything else ends as a silent `unchanged`, never as the scenario's change.
 */
async function unreachable(db: Db, sourceId: string, urlNormalized: string, maxPagesOverride?: number): Promise<string | null> {
  const source = await getSource(db, sourceId);
  if (!source || source.status !== "approved" || source.validTo !== null) {
    return `source of ${urlNormalized} is ${source ? (source.validTo !== null ? "ended" : source.status) : "missing"}, a revisit does not fetch it`;
  }
  const [row] = await db
    .select({ id: crawlFrontier.id, status: crawlFrontier.status })
    .from(crawlFrontier)
    .where(and(eq(crawlFrontier.sourceId, sourceId), eq(crawlFrontier.urlNormalized, urlNormalized)));
  if (!row) return `${urlNormalized} has no frontier row, a revisit does not fetch it`;
  if (row.status === "skipped") return `${urlNormalized} is skipped in the frontier, a revisit does not fetch it`;
  const maxPages = maxPagesOverride ?? source.crawlRules.maxPages;
  const planned = await db
    .select({ id: crawlFrontier.id })
    .from(crawlFrontier)
    .where(and(eq(crawlFrontier.sourceId, sourceId), ne(crawlFrontier.status, "skipped")))
    .orderBy(asc(crawlFrontier.depth), asc(crawlFrontier.discoveredAt), asc(crawlFrontier.id))
    .limit(maxPages);
  if (!planned.some((p) => p.id === row.id)) return `${urlNormalized} is beyond the source's ${maxPages} pages, a revisit does not fetch it`;
  return null;
}

export type PreflightResult = { entryId: string; documentId: string | null; ok: boolean; error?: string };

/**
 * Checks a scenario against the database before a simulated revisit, each entry for:
 * - its URL (normalized, once) is a known active document with a current version;
 * - the revisit fetches it (`unreachable`: source approved, frontier row present and not skipped, within `maxPages`,
 *   `opts.maxPages` standing for a run's `params.maxPages`);
 * - the edit base is the current version: a recorded one takes the edit, and no simulated version with another text
 *   exists; a simulated one must be this edit of a recorded version (a repeated revisit), else it is refused.
 * A `gone` entry whose document was recorded with one miss (`consecutive_gone = 1`) turns gone at the first
 * simulated revisit already (`goneAfter` 2); that is accepted, as recorded.
 */
export async function preflightScenario(
  db: Db,
  archive: Archive,
  scenario: RevisitScenario,
  opts: { maxPages?: number } = {},
): Promise<PreflightResult[]> {
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
      .select({ id: documents.id, sourceId: documents.sourceId, status: documents.status, currentVersionId: documents.currentVersionId })
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
    const notFetched = await unreachable(db, doc.sourceId, key, opts.maxPages);
    if (notFetched) {
      results.push(fail(notFetched));
      continue;
    }
    if (entry.edit.op !== "gone") {
      const base = await editBase(db, archive, doc.id);
      if (!base) {
        results.push(fail(`document for ${key} has no current version`));
        continue;
      }
      if (base.simulated) {
        if (!(await isEditOfRecorded(db, archive, doc.id, entry, base.contentHash))) {
          results.push(fail(`document for ${key} has a simulated current version that is not this edit of a recorded version`));
          continue;
        }
      } else {
        let edited: string;
        try {
          edited = applyEdit(base.markdown, entry.edit, entry.url);
        } catch (error) {
          results.push(fail((error as Error).message));
          continue;
        }
        const hash = hashOf(edited);
        const simulated = await db
          .select({ contentHash: documentVersions.contentHash })
          .from(documentVersions)
          .where(and(eq(documentVersions.documentId, doc.id), eq(documentVersions.simulated, true)));
        if (simulated.some((v) => v.contentHash !== hash)) {
          results.push(fail(`document for ${key} has a simulated version with another text`));
          continue;
        }
      }
    }
    results.push({ entryId: entry.id, documentId: doc.id, ok: true });
  }
  return results;
}
