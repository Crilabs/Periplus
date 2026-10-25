import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { BlockedUrlError } from "@/lib/adapters/fetch/ssrf";
import { htmlToMarkdown } from "@/lib/adapters/fetch/local";
import { HttpError, RetryableHttpError, type Transport } from "@/lib/adapters/http";
import type { Archive } from "@/lib/adapters/s3";
import { checkPlaceWebsiteTask, MAX_PAGE_CHARS, type CheckPlaceWebsiteOutput } from "@/lib/ai/tasks/check-place-website";
import type { ModelClient } from "@/lib/ai/types";
import { getConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { geoNames, serpResults, sources, type PlaceKind, type PlaceWebsiteOrigin } from "@/lib/db/schema";
import { isIgnoredDomain } from "@/lib/domain/discovery/proposals";
import { dedupeQueries, namesByLanguage, type DiscoveryQuery } from "@/lib/domain/search/queries";
import { runQuery } from "@/lib/domain/discovery/serp";
import { normalizeForQuote } from "@/lib/domain/research/text/quote";
import { normalizeName } from "@/lib/domain/gazetteer/names";
import { DEFAULT_CRAWL_RULES } from "@/lib/domain/sources/crawl-rules";
import { isForbiddenUrl } from "@/lib/domain/sources/forbidden-domains";
import type { Source } from "@/lib/domain/sources/store";
import { registrableDomain } from "@/lib/domain/sources/urls";
import { subdivisionByKey } from "@/lib/domain/subdivisions/store";
import { validAt } from "@/lib/db/valid-at";
import { createLogger } from "@/lib/logger";
import { decodeHtml, fetchFollowing, formatOf } from "@/lib/pipeline/fetch/page";
import { PLACE_WEBSITE_STAGE } from "@/lib/pipeline/places/stage-name";
import { knownWebsites } from "./websites";

/*
 * Finding the website of a marina or port (spec 15 C „Welche Orte“, „Herkunft der Adresse“, „Ist das die Website
 * dieses Ortes?“): an address OSM or Wikidata already gives wins; otherwise a Google search (DataForSEO, level
 * `place_website`) whose hits the model checks one by one, the first confident yes with a verifiable quote wins. A
 * miss writes nothing but the search itself: no review task, and no new search before `placeWebsite.retryDays`.
 */

const DAY_MS = 86_400_000;
/** Priority of a place website query (unused for ordering: a place's queries run in template order). */
const PLACE_WEBSITE_PRIORITY = 1;

export type PlaceRef = { placeId: string; geoObjectId: string };

export type FindDeps = {
  /** The DataForSEO transport. */
  transport: Transport;
  /** The transport that fetches the hits' pages (the guarded crawl transport); default `transport`. */
  crawlTransport?: Transport;
  archive: Archive;
  model: ModelClient;
  /** Address check before every page request and redirect hop (default `isPublicHttpUrl`). */
  isAllowed?: (url: string) => Promise<boolean>;
  now?: Date;
};

export type FoundWebsite = {
  outcome: "known" | "serp" | "none" | "searched_recently";
  url?: string;
  origin?: PlaceWebsiteOrigin;
  serpQueryId?: string;
  quote?: string;
  confidence?: number;
};

/**
 * The places that need a website (spec 15 C „Welche Orte“): valid, unmerged places of kind `marina` or `port` with
 * status `candidate` or `confirmed` whose valid geo object belongs to the subdivision (its `subdivision_id`, else the
 * label of the place's tile), without any `place_websites` row. Ordered by place id. An unknown subdivision throws.
 */
export async function placesNeedingWebsite(db: Db, subdivisionKey: string): Promise<PlaceRef[]> {
  const sub = await subdivisionByKey(db, subdivisionKey);
  if (!sub) throw new Error(`Unbekannter Landesteil ${subdivisionKey}`);
  const { rows } = await db.execute<PlaceRef>(sql`
    select p.id as "placeId", p.geo_object_id as "geoObjectId"
    from places p
    join geo_objects o on o.id = p.geo_object_id and o.merged_into_id is null
      and o.valid_from <= current_date and (o.valid_to is null or o.valid_to > current_date)
    left join tiles t on t.id = p.tile_id
    where p.merged_into_id is null and p.valid_from <= current_date and (p.valid_to is null or p.valid_to > current_date)
      and p.kind in ('marina', 'port') and p.status in ('candidate', 'confirmed')
      and coalesce(o.subdivision_id, t.subdivision_id) = ${sub.id}::uuid
      and not exists (select 1 from place_websites w where w.place_id = p.id)
    order by p.id
  `);
  return rows;
}

type PlaceContext = {
  kind: PlaceKind;
  tileId: string | null;
  lon: number;
  lat: number;
  tags: Record<string, string>;
  websiteWikidata: string | null;
  /** The island (or islet) nearest up the place's hierarchy, if any. */
  islandId: string | null;
};

async function placeContext(db: Db, place: PlaceRef): Promise<PlaceContext> {
  const { rows } = await db.execute<{
    kind: PlaceKind;
    tile_id: string | null;
    lon: number;
    lat: number;
    tags: Record<string, string> | null;
    website_wikidata: string | null;
    island_id: string | null;
  }>(sql`
    with recursive up(id, parent_id, type, depth) as (
      select o.id, o.parent_id, o.type, 0 from geo_objects o where o.id = ${place.geoObjectId}::uuid
      union all
      select g.id, g.parent_id, g.type, up.depth + 1 from geo_objects g join up on g.id = up.parent_id where up.depth < 12
    )
    select p.kind, p.tile_id, ST_X(p.position) as lon, ST_Y(p.position) as lat, o.tags, o.website_wikidata,
      (select id from up where depth > 0 and type in ('island', 'islet') order by depth limit 1) as island_id
    from places p join geo_objects o on o.id = p.geo_object_id
    where p.id = ${place.placeId}::uuid
  `);
  const row = rows[0];
  if (!row) throw new Error(`place ${place.placeId} not found`);
  return {
    kind: row.kind,
    tileId: row.tile_id,
    lon: Number(row.lon),
    lat: Number(row.lat),
    tags: row.tags ?? {},
    websiteWikidata: row.website_wikidata,
    islandId: row.island_id,
  };
}

/** Every valid name of the object, preferred first, real names before fallbacks and transliterations, without duplicates. */
async function allNames(db: Db, geoObjectId: string): Promise<string[]> {
  const rows = await db
    .select({ name: geoNames.name })
    .from(geoNames)
    .where(and(eq(geoNames.geoObjectId, geoObjectId), validAt(geoNames)))
    .orderBy(
      desc(geoNames.isPreferred),
      asc(sql`${geoNames.origin} in ('fallback', 'transliteration')`),
      geoNames.name,
    );
  return [...new Set(rows.map((r) => r.name))];
}

/** The current source of the registrable domain, if any (status and type). */
async function sourceOfDomain(db: Db, domain: string) {
  const [row] = await db
    .select({ status: sources.status, type: sources.type })
    .from(sources)
    .where(and(eq(sources.domain, domain), isNull(sources.validTo)));
  return row ?? null;
}

const domainOf = (url: string): string | null => {
  try {
    return registrableDomain(url);
  } catch {
    return null;
  }
};

/**
 * The model's yes counts (spec 15 C): `isOwnSite`, confidence at least `minConfidence`, and a non-empty quote that is
 * on the page (verbatim after the quote normalisation of the fact check: Markdown, whitespace and typography; case and
 * accents kept) and names the place (one of `names` as whole words, compared without case and accents).
 */
export function acceptWebsiteCheck(out: CheckPlaceWebsiteOutput, pageText: string, names: string[], minConfidence: number): boolean {
  if (!out.isOwnSite || out.confidence < minConfidence) return false;
  const quote = normalizeForQuote(out.quote).text.trim();
  if (quote.length === 0 || !normalizeForQuote(pageText).text.includes(quote)) return false;
  const words = ` ${normalizeName(out.quote)} `;
  return names.some((n) => {
    const name = normalizeName(n);
    return name.length > 0 && words.includes(` ${name} `);
  });
}

/** The SERP queries of the place: per template its name (and island) in the template's language; missing ones skip it. */
async function websiteQueries(db: Db, place: PlaceRef, ctx: PlaceContext): Promise<DiscoveryQuery[]> {
  const { templates } = getConfig().discovery.placeWebsite;
  const languages = [...new Set(templates.map((t) => t.lang))];
  const ids = ctx.islandId ? [place.geoObjectId, ctx.islandId] : [place.geoObjectId];
  const names = await namesByLanguage(db, ids, languages);
  const queries: DiscoveryQuery[] = [];
  for (const t of templates) {
    const name = names.get(place.geoObjectId)?.get(t.lang);
    if (!name) continue;
    let keyword = t.template.replaceAll("{name}", name);
    if (t.template.includes("{island}")) {
      const island = ctx.islandId ? names.get(ctx.islandId)?.get(t.lang) : undefined;
      if (!island) continue;
      keyword = keyword.replaceAll("{island}", island);
    }
    queries.push({
      keyword,
      languageCode: t.lang,
      locationCode: t.locationCode,
      level: "place_website",
      scopeId: place.geoObjectId,
      priority: PLACE_WEBSITE_PRIORITY,
      ...(ctx.tileId ? { tileId: ctx.tileId } : {}),
    });
  }
  return dedupeQueries(queries);
}

type Hit = { url: string; urlNormalized: string; domain: string; rank: number; serpQueryId: string };

/**
 * The hits worth checking, best rank first (ties in query order), each URL once: not on a forbidden or ignored
 * domain, not on the domain of a rejected or paused source, nor of an approved or proposed source of another type than
 * `marina` (pilot guides, blogs); at most `maxResults`.
 */
async function candidateHits(db: Db, queryIds: string[], maxResults: number): Promise<Hit[]> {
  if (queryIds.length === 0) return [];
  const rows = await db
    .select({ url: serpResults.url, urlNormalized: serpResults.urlNormalized, domain: serpResults.domain, rank: serpResults.rank, serpQueryId: serpResults.serpQueryId })
    .from(serpResults)
    .where(inArray(serpResults.serpQueryId, queryIds));
  rows.sort((a, b) => a.rank - b.rank || queryIds.indexOf(a.serpQueryId) - queryIds.indexOf(b.serpQueryId) || (a.url < b.url ? -1 : 1));
  const { delivery, discovery } = getConfig();
  const seen = new Set<string>();
  const out: Hit[] = [];
  for (const hit of rows) {
    if (out.length >= maxResults) break;
    if (seen.has(hit.urlNormalized)) continue;
    seen.add(hit.urlNormalized);
    let host: string;
    try {
      host = new URL(hit.url).hostname.toLowerCase();
    } catch {
      continue;
    }
    if (isForbiddenUrl(hit.url, delivery.forbiddenDomains)) continue;
    if (isIgnoredDomain(host, discovery.proposals) || isIgnoredDomain(hit.domain, discovery.proposals)) continue;
    const source = await sourceOfDomain(db, hit.domain);
    if (source && (source.status === "rejected" || source.status === "paused" || source.type !== "marina")) continue;
    out.push(hit);
  }
  return out;
}

/**
 * The page of a hit as Markdown (at most `MAX_PAGE_CHARS`), fetched like a crawl page (`fetchFollowing`: robots.txt,
 * address check, rate per domain) with a stand-in source of the hit's domain and default crawl rules; null when the
 * page cannot be read now (stop, HTTP error, too large, not HTML, unreachable).
 */
async function pageText(db: Db, url: string, deps: FindDeps, ctx: { runId: string }): Promise<string | null> {
  const domain = domainOf(url);
  if (!domain) return null;
  const stand: Source = {
    id: "",
    domain,
    name: domain,
    type: "marina",
    weight: 0,
    status: "approved",
    statusReason: null,
    crawlRules: DEFAULT_CRAWL_RULES,
    changeRate: "normal",
    languages: [],
    origin: "place_website",
    validTo: null,
  };
  try {
    const fetched = await fetchFollowing(
      db,
      stand,
      url,
      null,
      { transport: deps.crawlTransport ?? deps.transport, archive: deps.archive, isAllowed: deps.isAllowed },
      { db, runId: ctx.runId, stage: PLACE_WEBSITE_STAGE },
    );
    if (fetched.kind === "stop") return null;
    const { res } = fetched;
    if (res.status >= 300) return null;
    if (res.truncated || res.body.byteLength > getConfig().fetch.maxRawBytes) return null;
    const contentType = res.headers["content-type"] ?? null;
    if (formatOf(contentType, fetched.finalUrl).kind !== "html") return null;
    const { markdown } = htmlToMarkdown(decodeHtml(res.body, contentType), fetched.finalUrl, []);
    return markdown.slice(0, MAX_PAGE_CHARS);
  } catch (error) {
    if (error instanceof BlockedUrlError || error instanceof HttpError || error instanceof RetryableHttpError) {
      createLogger("places.website").info({ url, err: error }, "website candidate not readable, skipped");
      return null;
    }
    throw error;
  }
}

/**
 * Finds the website of one place (spec 15 C):
 * 1. A known address (`knownWebsites`: OSM `website`, `contact:website`, Wikidata P856), the first one whose domain is
 *    not a rejected source: `known`, no search, no model.
 * 2. Else, when a `place_website` search for the geo object of another run is younger than `placeWebsite.retryDays`:
 *    `searched_recently` (a place without website does not cost money every run; a retried job of the same run searches
 *    again, which the SERP reuse answers without a call).
 * 3. Else the templates' searches (`runQuery`, level `place_website`, cost booked on the place's tile) and the model
 *    check of up to `maxResults` hits in rank order (`candidateHits`); the first accepted one (`acceptWebsiteCheck`)
 *    is `serp` with its query, quote and confidence, later hits are not checked. Nothing accepted: `none`.
 */
export async function findPlaceWebsite(
  db: Db,
  place: PlaceRef,
  deps: FindDeps,
  ctx: { runId: string; tileId?: string | null },
): Promise<FoundWebsite> {
  const cfg = getConfig().discovery.placeWebsite;
  const context = await placeContext(db, place);

  for (const known of knownWebsites({ tags: context.tags, websiteWikidata: context.websiteWikidata })) {
    const domain = domainOf(known.url);
    if (!domain || (await sourceOfDomain(db, domain))?.status === "rejected") continue;
    return { outcome: "known", url: known.url, origin: known.origin };
  }

  const now = deps.now ?? new Date();
  const since = new Date(now.getTime() - cfg.retryDays * DAY_MS);
  const { rows: recent } = await db.execute(sql`
    select 1 from serp_queries
    where level = 'place_website' and scope_id = ${place.geoObjectId} and fetched_at > ${since.toISOString()}::timestamptz
      and run_id is distinct from ${ctx.runId}::uuid
    limit 1
  `);
  if (recent.length > 0) return { outcome: "searched_recently" };

  const tileId = ctx.tileId ?? context.tileId;
  const queries = (await websiteQueries(db, place, context)).map((q) => (tileId ? { ...q, tileId } : q));
  const queryIds: string[] = [];
  for (const q of queries) {
    const { queryId } = await runQuery(db, q, { transport: deps.transport, archive: deps.archive, now }, { db, runId: ctx.runId, stage: PLACE_WEBSITE_STAGE });
    queryIds.push(queryId);
  }

  const names = await allNames(db, place.geoObjectId);
  const islandName = context.islandId ? ((await allNames(db, context.islandId))[0] ?? null) : null;
  for (const hit of await candidateHits(db, queryIds, cfg.maxResults)) {
    const text = await pageText(db, hit.url, deps, ctx);
    if (text === null) continue;
    const { output } = await deps.model.call(
      checkPlaceWebsiteTask,
      { names, island: islandName, kindProposal: context.kind, lat: context.lat, lon: context.lon, url: hit.url, pageText: text },
      { runId: ctx.runId, stage: PLACE_WEBSITE_STAGE },
    );
    if (acceptWebsiteCheck(output, text, names, cfg.minConfidence)) {
      return { outcome: "serp", url: hit.url, origin: "serp", serpQueryId: hit.serpQueryId, quote: output.quote, confidence: output.confidence };
    }
  }
  return { outcome: "none" };
}
