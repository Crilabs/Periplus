import { createHash } from "node:crypto";
import { and, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { z } from "zod";
import type { Archive } from "@/lib/adapters/s3";
import { getConfig, type AppConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import {
  changeRateEnum,
  DOC_TYPES,
  documents,
  sources,
  type ChangeRate,
  type DocType,
  type SourceOrigin,
  type SourceStatus,
} from "@/lib/db/schema";
import { ensureDocument } from "@/lib/domain/documents/store";
import { takesFactsSql } from "@/lib/domain/facts/levels";
import { createLogger } from "@/lib/logger";
import { crawlRulesSchema, DEFAULT_CRAWL_RULES, type CrawlRules } from "./crawl-rules";
import { assertAllowedSourceDomain, isForbiddenHost } from "./forbidden-domains";
import { registrableDomain } from "./urls";

export type Source = {
  id: string;
  domain: string;
  name: string;
  type: DocType;
  weight: number;
  status: SourceStatus;
  statusReason: string | null;
  crawlRules: CrawlRules;
  changeRate: ChangeRate;
  languages: string[];
  origin: SourceOrigin;
  /** Set when the source has ended (never deleted, spec 02); an ended source is neither crawled nor changed. */
  validTo: string | null;
};

/** The source `id` with its crawl rules parsed (defaults filled in; invalid stored rules throw); null when unknown. */
export async function getSource(db: Db, id: string): Promise<Source | null> {
  const [row] = await db
    .select({
      id: sources.id,
      domain: sources.domain,
      name: sources.name,
      type: sources.type,
      weight: sources.weight,
      status: sources.status,
      statusReason: sources.statusReason,
      crawlRules: sources.crawlRules,
      changeRate: sources.changeRate,
      languages: sources.languages,
      origin: sources.origin,
      validTo: sources.validTo,
    })
    .from(sources)
    .where(eq(sources.id, id));
  if (!row) return null;
  return { ...row, crawlRules: crawlRulesSchema.parse(row.crawlRules) };
}

/**
 * Sets status and reason of the source `id` (the history trigger records the change); throws for an unknown id.
 * With `from`, only a source still in that status and not ended changes; returns whether it changed.
 */
export async function setSourceStatus(
  db: Db,
  id: string,
  status: SourceStatus,
  reason: string | null,
  opts: { from?: SourceStatus } = {},
): Promise<boolean> {
  const updated = await db
    .update(sources)
    .set({ status, statusReason: reason })
    .where(opts.from ? and(eq(sources.id, id), eq(sources.status, opts.from), isNull(sources.validTo)) : eq(sources.id, id))
    .returning({ id: sources.id });
  if (updated.length > 0) return true;
  if (opts.from) return false;
  throw new Error(`source ${id} not found`);
}

/**
 * Creates every source of `config/sources-whitelist.json` as `approved` (origin `whitelist`, weight of its type from
 * `config/source-types.json`, crawl rules = defaults + the entry's), stored under its registrable domain. A domain
 * that has any source row already is left alone: the admin's changes (a pause, other rules) win. An entry on a
 * forbidden domain (`delivery.forbiddenDomains`) is never created (ruling M6-D-R2).
 */
export async function ensureWhitelistSources(
  db: Db,
  cfg: Pick<AppConfig, "whitelist" | "sourceTypes" | "delivery"> = getConfig(),
): Promise<{ created: number }> {
  let created = 0;
  for (const entry of cfg.whitelist) {
    const domain = registrableDomain(`https://${entry.domain}/`);
    if (isForbiddenHost(domain, cfg.delivery.forbiddenDomains) || isForbiddenHost(entry.domain, cfg.delivery.forbiddenDomains)) {
      createLogger("sources").warn({ domain }, "whitelist entry on a forbidden domain skipped");
      continue;
    }
    const [known] = await db.select({ id: sources.id }).from(sources).where(eq(sources.domain, domain)).limit(1);
    if (known) continue;
    const inserted = await db
      .insert(sources)
      .values({
        domain,
        name: entry.name,
        type: entry.type,
        weight: cfg.sourceTypes[entry.type].weight,
        status: "approved",
        crawlRules: crawlRulesSchema.parse(entry.crawlRules),
        changeRate: entry.changeRate,
        origin: "whitelist",
      })
      .onConflictDoNothing()
      .returning({ id: sources.id });
    created += inserted.length;
  }
  return { created };
}

/** The current (not ended) source of the registrable domain `domain`, or null. */
export async function sourceIdByDomain(db: Db, domain: string): Promise<string | null> {
  const [row] = await db
    .select({ id: sources.id })
    .from(sources)
    .where(and(eq(sources.domain, domain), isNull(sources.validTo)));
  return row?.id ?? null;
}

/** Editable settings of a source (the form of the source page). */
export const sourceSettingsSchema = z.object({
  name: z.string().trim().min(1).max(200),
  type: z.enum(DOC_TYPES),
  weight: z.number().min(0).max(1),
  changeRate: z.enum(changeRateEnum.enumValues),
  crawlRules: crawlRulesSchema,
});

export type SourceSettings = z.input<typeof sourceSettingsSchema>;

/** The source has ended (`valid_to` set): it is shown read-only and nothing on it changes any more. */
export class SourceEnded extends Error {
  constructor(id: string) {
    super(`source ${id} has ended`);
    this.name = "SourceEnded";
  }
}

/**
 * Saves name, type, weight, change rate and crawl rules of the source `id`. Everything is validated first
 * (`ZodError`, nothing written); an ended source throws `SourceEnded`, an unknown id throws.
 */
export async function updateSourceSettings(db: Db, id: string, input: SourceSettings): Promise<void> {
  const settings = sourceSettingsSchema.parse(input);
  const updated = await db
    .update(sources)
    .set(settings)
    .where(and(eq(sources.id, id), isNull(sources.validTo)))
    .returning({ id: sources.id });
  if (updated.length > 0) return;
  const [known] = await db.select({ id: sources.id }).from(sources).where(eq(sources.id, id));
  if (known) throw new SourceEnded(id);
  throw new Error(`source ${id} not found`);
}

/** Status reason of a source the admin paused on the source page. */
export const ADMIN_PAUSE_REASON = "vom Admin pausiert";

/** Pauses the source `id` if it is approved and not ended (the only pause the source page offers); returns whether it changed. */
export function pauseSource(db: Db, id: string): Promise<boolean> {
  return setSourceStatus(db, id, "paused", ADMIN_PAUSE_REASON, { from: "approved" });
}

/**
 * Approves the paused source `id` again; returns whether it changed (a proposed, rejected or ended source never does).
 * A source on a forbidden domain throws `ForbiddenSourceDomain` (ruling M6-D-R2).
 */
export async function resumeSource(db: Db, id: string, cfg: Pick<AppConfig, "delivery"> = getConfig()): Promise<boolean> {
  const [row] = await db.select({ domain: sources.domain }).from(sources).where(eq(sources.id, id));
  if (row) assertAllowedSourceDomain(row.domain, cfg.delivery.forbiddenDomains);
  return setSourceStatus(db, id, "approved", null, { from: "paused" });
}

/**
 * „Quelle beenden“ (ruling M6-H-R1, the remedy of a package blocked by `foreign_content`): ends the approved or paused
 * source `id` on today's UTC date (`valid_to`; the history trigger records it). From then on its facts count in no
 * consolidation (`countingSourceSql`), it is neither crawled nor resumed, and its documents leave the delivered
 * `sources` with the next profile. Returns whether it ended (a proposed, rejected or already ended source does not)
 * and the geo objects to consolidate again after the commit: those with a fact from one of its documents, a merged one
 * replaced by its final target, only valid objects that take facts, sorted.
 */
export async function endSource(db: Db, id: string): Promise<{ ended: boolean; geoObjectIds: string[] }> {
  return db.transaction(async (tx) => {
    const ended = await tx
      .update(sources)
      .set({ validTo: sql`(now() at time zone 'UTC')::date` })
      .where(and(eq(sources.id, id), inArray(sources.status, ["approved", "paused"]), isNull(sources.validTo)))
      .returning({ id: sources.id });
    if (ended.length === 0) return { ended: false, geoObjectIds: [] };
    const { rows } = await tx.execute<{ id: string }>(sql`
      with recursive hit as (
        select distinct f.geo_object_id as id
        from facts f
        join mentions m on m.id = f.mention_id
        join document_versions v on v.id = m.document_version_id
        join documents d on d.id = v.document_id
        where d.source_id = ${id}
      ),
      chain(id, merged_into_id, depth) as (
        select o.id, o.merged_into_id, 0 from hit h join geo_objects o on o.id = h.id
        union all
        select n.id, n.merged_into_id, c.depth + 1 from chain c join geo_objects n on n.id = c.merged_into_id where c.depth < 100
      )
      select distinct o.id
      from chain c
      join geo_objects o on o.id = c.id
      where c.merged_into_id is null
        and o.valid_from <= (now() at time zone 'UTC')::date
        and (o.valid_to is null or o.valid_to > (now() at time zone 'UTC')::date)
        and ${takesFactsSql}
      order by o.id
    `);
    return { ended: true, geoObjectIds: rows.map((r) => r.id) };
  });
}

/** The domain of a manual source is known already (any source row of its registrable domain, ended ones too). */
export class SourceDomainKnown extends Error {
  constructor(readonly domain: string) {
    super(`a source for ${domain} exists already`);
    this.name = "SourceDomainKnown";
  }
}

/** The input is no domain or URL with a host. */
export class InvalidSourceDomain extends Error {
  constructor(input: string) {
    super(`not a domain: ${input}`);
    this.name = "InvalidSourceDomain";
  }
}

/** The URL of a domain or URL the admin typed. */
const typedUrl = (input: string) => {
  const trimmed = input.trim();
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
};

/** Registrable domain of a domain or URL the admin typed (`www.example.com`, `https://example.com/x`). */
export function sourceDomainOf(input: string): string {
  const url = typedUrl(input);
  let domain: string;
  try {
    const parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol) || !parsed.hostname.includes(".")) throw new InvalidSourceDomain(input);
    domain = registrableDomain(url);
  } catch {
    throw new InvalidSourceDomain(input);
  }
  return domain.toLowerCase();
}

/**
 * Creates an approved manual source (`origin manual`) for the registrable domain of `input.domain`, with the weight
 * and change rate of its type (`config/source-types.json`) and the default crawl rules. A domain that has any source
 * row already throws `SourceDomainKnown` (ruling: `sources.domain` is always the registrable domain); a forbidden domain
 * (`delivery.forbiddenDomains`) throws `ForbiddenSourceDomain` (ruling M6-D-R2).
 */
export async function createManualSource(
  db: Db,
  input: { domain: string; name: string; type: DocType },
  cfg: Pick<AppConfig, "sourceTypes" | "delivery"> = getConfig(),
): Promise<{ id: string }> {
  const domain = sourceDomainOf(input.domain);
  // the registrable domain and the typed host (a forbidden entry may be a subdomain)
  assertAllowedSourceDomain(domain, cfg.delivery.forbiddenDomains);
  assertAllowedSourceDomain(new URL(typedUrl(input.domain)).hostname, cfg.delivery.forbiddenDomains);
  const name = z.string().trim().min(1).max(200).parse(input.name);
  const [known] = await db.select({ id: sources.id }).from(sources).where(eq(sources.domain, domain)).limit(1);
  if (known) throw new SourceDomainKnown(domain);
  const [row] = await db
    .insert(sources)
    .values({
      domain,
      name,
      type: input.type,
      weight: cfg.sourceTypes[input.type].weight,
      changeRate: cfg.sourceTypes[input.type].changeRate,
      status: "approved",
      crawlRules: DEFAULT_CRAWL_RULES,
      origin: "manual",
    })
    .onConflictDoNothing({ target: sources.domain, where: sql`${sources.validTo} is null` })
    .returning({ id: sources.id });
  if (!row) throw new SourceDomainKnown(domain);
  return { id: row.id };
}

/** An uploaded file does not start with `%PDF-`. */
export class NotAPdf extends Error {
  constructor() {
    super("the file is not a PDF");
    this.name = "NotAPdf";
  }
}

/** A PDF can be uploaded only for a current source that is approved, proposed or paused (not rejected or ended). */
export class SourceNotUploadable extends Error {
  constructor(id: string) {
    super(`source ${id} takes no uploads`);
    this.name = "SourceNotUploadable";
  }
}

/**
 * Statuses of a (current) source that takes PDF uploads. A pause stops crawling only (spec 05; a robots.txt ban does
 * not cover a file the admin bought), so a paused source takes uploads too (ruling M3-E-R2).
 */
const UPLOAD_STATUSES: readonly SourceStatus[] = ["approved", "proposed", "paused"];

const PDF_MAGIC = new TextEncoder().encode("%PDF-");

/**
 * Stores an uploaded PDF for the source: `uploads/<sha256>.pdf` in the archive and the document `upload://<sha256>`
 * (document type = source type). The same file again is the same document (`created` false); `sourceId` is the
 * source that document belongs to, which is another source when the file was archived there first (URLs are unique
 * across sources). A file not starting with `%PDF-` throws `NotAPdf`, a source that is not current and approved,
 * proposed or paused throws `SourceNotUploadable` (both before anything is stored); an unknown source throws. The archiving
 * itself is a run (`startUploadFetchRun`).
 */
export async function uploadPdf(
  db: Db,
  archive: Archive,
  input: { sourceId: string; bytes: Uint8Array },
): Promise<{ documentId: string; sourceId: string; created: boolean }> {
  if (!PDF_MAGIC.every((b, i) => input.bytes[i] === b)) throw new NotAPdf();
  const [source] = await db
    .select({ id: sources.id, type: sources.type, status: sources.status, validTo: sources.validTo })
    .from(sources)
    .where(eq(sources.id, input.sourceId));
  if (!source) throw new Error(`source ${input.sourceId} not found`);
  if (source.validTo !== null || !UPLOAD_STATUSES.includes(source.status)) throw new SourceNotUploadable(source.id);
  const sha = createHash("sha256").update(input.bytes).digest("hex");
  const key = `uploads/${sha}.pdf`;
  if (!(await archive.exists(key))) await archive.put(key, input.bytes, "application/pdf");
  const url = `upload://${sha}`;
  const doc = await ensureDocument(db, { sourceId: source.id, url, urlNormalized: url, docType: source.type });
  if (doc.created) return { documentId: doc.id, sourceId: source.id, created: true };
  const [existing] = await db.select({ sourceId: documents.sourceId }).from(documents).where(eq(documents.id, doc.id));
  return { documentId: doc.id, sourceId: existing!.sourceId, created: false };
}

/**
 * The IDs of the current sources a crawl or revisit run takes: approved, not ended, and not of origin `research`
 * (research sources only hold single hit pages fetched on their own; they are never crawled from their domain root).
 */
export async function crawlableSourceIds(db: Db): Promise<string[]> {
  const rows = await db
    .select({ id: sources.id })
    .from(sources)
    .where(and(eq(sources.status, "approved"), isNull(sources.validTo), ne(sources.origin, "research")));
  return rows.map((r) => r.id);
}
