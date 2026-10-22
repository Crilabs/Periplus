import { and, eq, isNull, sql } from "drizzle-orm";
import { getConfig, type AppConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { placeWebsites, sources, type DocType, type PlaceWebsiteOrigin } from "@/lib/db/schema";
import { suggestType } from "@/lib/domain/discovery/proposals";
import { openTaskFor } from "@/lib/domain/review";
import { decideReviewTask, sourceSettingsKey } from "@/lib/domain/review-decisions";
import { crawlRulesSchema, DEFAULT_CRAWL_RULES } from "@/lib/domain/sources/crawl-rules";
import { isForbiddenHost, isForbiddenUrl } from "@/lib/domain/sources/forbidden-domains";
import { bindingKey, bindingKeySql } from "@/lib/domain/mentions/bound";
import { setSourceStatus } from "@/lib/domain/sources/store";
import { normalizeUrl, registrableDomain } from "@/lib/domain/sources/urls";

/*
 * Approval of a place's website and its binding to the place (spec 16 C „Freigabe“, „Crawl“, „Bindung an den Ort“).
 * The address of a place becomes (or joins) an approved source without a review task; the `place_websites` row records
 * it and whether the source's pages are bound to the place.
 */

type AttachConfig = Pick<AppConfig, "discovery" | "sourceTypes" | "delivery" | "fetch">;

export type AttachInput = {
  placeId: string;
  geoObjectId: string;
  url: string;
  origin: PlaceWebsiteOrigin;
  serpQueryId?: string;
  quote?: string;
  confidence?: number;
  runId: string;
};

/** Who decides the open approval task of a proposed source the website of a place approves. */
const SYSTEM_ACTOR = "system";
/** `crawlRulesSchema` caps `maxPages` at 5000. */
const MAX_PAGES = 5000;

const normalized = (url: string, cfg: AttachConfig) => normalizeUrl(url, cfg.fetch.trackingParams) ?? url;

/**
 * Adds `url` to the start URLs of the (locked) source unless it is one already. A source whose start list is empty
 * crawled its root (`https://<domain>/`), which stays a start URL. A `place_website` source gets
 * `crawl.maxPagesPerStartUrl` more pages per start URL (30 × n); a source of another origin keeps its rules (spec 16 C
 * „Crawl“: „Kommt die Start-URL zu einer bestehenden Quelle, gelten deren Regeln“).
 */
async function addStartUrl(tx: Db, sourceId: string, url: string, cfg: AttachConfig): Promise<void> {
  const [row] = await tx
    .select({ domain: sources.domain, origin: sources.origin, crawlRules: sources.crawlRules })
    .from(sources)
    .where(eq(sources.id, sourceId))
    .for("update");
  if (!row) throw new Error(`source ${sourceId} not found`);
  const rules = crawlRulesSchema.parse(row.crawlRules);
  const wanted = normalized(url, cfg);
  if (rules.startUrls.some((u) => normalized(u, cfg) === wanted)) return;
  const root = `https://${row.domain}/`;
  const startUrls = rules.startUrls.length > 0 ? [...rules.startUrls, url] : normalized(root, cfg) === wanted ? [url] : [root, url];
  const maxPages =
    row.origin === "place_website" ? Math.min(MAX_PAGES, rules.maxPages + cfg.discovery.placeWebsite.crawl.maxPagesPerStartUrl) : rules.maxPages;
  await tx
    .update(sources)
    .set({ crawlRules: { ...rules, startUrls, maxPages } })
    .where(eq(sources.id, sourceId));
}

/**
 * The approved source the website `url` belongs to, by registrable domain (spec 16 C „Freigabe“):
 * - none: a new approved source of origin `place_website`, of `type` (`marina`; `authority` for a domain the source
 *   finding recognises as one), weight and change rate of that type, start URL `url`, depth `crawl.maxDepth`,
 *   `crawl.maxPagesPerStartUrl` pages;
 * - `approved`: the start URL is added (`addStartUrl`); type and weight stay;
 * - `proposed`: approved with its proposed settings (the open `source_approval` task decided by `system`, else the
 *   status set), then the start URL is added;
 * - `paused`, `rejected`: null, the address is passed over.
 */
async function approvedSourceFor(tx: Db, url: string, type: DocType, cfg: AttachConfig): Promise<string | null> {
  const domain = registrableDomain(normalized(url, cfg));
  const current = async () =>
    (
      await tx
        .select()
        .from(sources)
        .where(and(eq(sources.domain, domain), isNull(sources.validTo)))
    )[0];
  let source = await current();
  if (!source) {
    const { crawl } = cfg.discovery.placeWebsite;
    const [inserted] = await tx
      .insert(sources)
      .values({
        domain,
        name: domain,
        type,
        weight: cfg.sourceTypes[type].weight,
        changeRate: cfg.sourceTypes[type].changeRate,
        status: "approved",
        crawlRules: { ...DEFAULT_CRAWL_RULES, startUrls: [url], maxDepth: crawl.maxDepth, maxPages: crawl.maxPagesPerStartUrl },
        origin: "place_website",
      })
      .onConflictDoNothing({ target: sources.domain, where: sql`${sources.validTo} is null` })
      .returning({ id: sources.id });
    if (inserted) return inserted.id;
    source = await current();
    if (!source) throw new Error(`source of ${domain} vanished`);
  }
  if (source.status === "paused" || source.status === "rejected") return null;
  if (source.status === "proposed") {
    const settings = { type: source.type, weight: source.weight, changeRate: source.changeRate, crawlRules: crawlRulesSchema.parse(source.crawlRules) };
    const task = await openTaskFor(tx, "source_approval", source.id);
    if (task) {
      // the address at the place is the stronger evidence: the open approval is decided with the proposed settings
      await decideReviewTask(tx, {
        taskId: task.id,
        decision: { action: "approve", ...settings },
        decidedBy: SYSTEM_ACTOR,
        valueKey: sourceSettingsKey(settings),
      });
    } else {
      await setSourceStatus(tx, source.id, "approved", null, { from: "proposed" });
    }
  }
  await addStartUrl(tx, source.id, url, cfg);
  return source.id;
}

/**
 * Records the website of a place (append-only `place_websites` row) and approves its source (`approvedSourceFor`;
 * none on a forbidden domain). `bound` (the source's pages below the start URL belong to the place, spec 16 C
 * „Bindung an den Ort“) is false without a source, for an `authority` domain (`suggestType`; created as `authority`,
 * not `marina`) and for a start URL another place's current website already has (by `bindingKey`): then that place's
 * binding ends too, by a new row of it with `bound` false (a municipality or port authority page for several harbours
 * binds none).
 * Serialised per binding key, so two places attaching the same URL at once see each other.
 */
export async function attachPlaceWebsite(
  tx: Db,
  input: AttachInput,
  cfg: AttachConfig = getConfig(),
): Promise<{ sourceId: string | null; bound: boolean }> {
  const urlNormalized = normalized(input.url, cfg);
  // one start URL whatever its scheme, `www.` or trailing slash (`bindingKey`, final review 2)
  const key = bindingKey(urlNormalized);
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`place-website:${key}`}))`);
  const domain = registrableDomain(urlNormalized);
  const authority = suggestType([input.url], cfg.discovery.proposals) === "authority";
  const forbidden = isForbiddenHost(domain, cfg.delivery.forbiddenDomains) || isForbiddenUrl(input.url, cfg.delivery.forbiddenDomains);
  const sourceId = forbidden ? null : await approvedSourceFor(tx, input.url, authority ? "authority" : "marina", cfg);

  // the current website of every other place, where it is this URL
  const { rows: others } = await tx.execute<{ id: string; place_id: string; bound: boolean }>(sql`
    select * from (
      select distinct on (w.place_id) w.id, w.place_id, w.url_normalized, w.bound
      from place_websites w
      where w.place_id <> ${input.placeId}::uuid
        and w.place_id in (select place_id from place_websites where ${bindingKeySql(sql`url_normalized`)} = ${key})
      order by w.place_id, w.created_at desc, w.id desc
    ) c where ${bindingKeySql(sql`c.url_normalized`)} = ${key}
  `);
  for (const other of others.filter((o) => o.bound)) {
    const [row] = await tx.select().from(placeWebsites).where(eq(placeWebsites.id, other.id));
    const w = row!;
    await tx.insert(placeWebsites).values({
      placeId: w.placeId,
      geoObjectId: w.geoObjectId,
      url: w.url,
      urlNormalized: w.urlNormalized,
      origin: w.origin,
      serpQueryId: w.serpQueryId,
      quote: w.quote,
      confidence: w.confidence,
      sourceId: w.sourceId,
      bound: false,
      runId: input.runId,
    });
  }

  const bound = sourceId !== null && !authority && others.length === 0;
  await tx.insert(placeWebsites).values({
    placeId: input.placeId,
    geoObjectId: input.geoObjectId,
    url: input.url,
    urlNormalized,
    origin: input.origin,
    serpQueryId: input.serpQueryId ?? null,
    quote: input.quote ?? null,
    confidence: input.confidence ?? null,
    sourceId,
    bound,
    runId: input.runId,
  });
  return { sourceId, bound };
}
