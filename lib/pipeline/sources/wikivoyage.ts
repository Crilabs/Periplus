import { and, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { fetchSitelinks, type Sitelink } from "@/lib/adapters/wikidata";
import type { CallContext, Transport } from "@/lib/adapters/http";
import { getConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { crawlFrontier, geoObjects, tileGeoObjects, subdivisions, type GeoObjectType } from "@/lib/db/schema";
import { ensureDocument } from "@/lib/domain/documents/store";
import { gazetteerScope } from "@/lib/domain/gazetteer/scope";
import { subdivisionTileIds } from "@/lib/domain/gazetteer/tiles-ensure";
import { urlAllowed } from "@/lib/domain/sources/crawl-rules";
import { getSource, sourceIdByDomain, type Source } from "@/lib/domain/sources/store";
import { normalizeUrl } from "@/lib/domain/sources/urls";
import { validAt } from "@/lib/db/valid-at";

// No import of ../runs here: the job handlers import this module (import cycle through the stage registry).

export const WIKIVOYAGE_STAGE = "sources.wikivoyage";

/** Registrable domain of the Wikivoyage source (entry of `config/sources-whitelist.json`). */
export const WIKIVOYAGE_DOMAIN = "wikivoyage.org";

/** Gazetteer objects that may have a Wikivoyage article of their own. */
const ARTICLE_TYPES: GeoObjectType[] = ["area", "archipelago", "island", "islet", "settlement"];

/**
 * The Wikidata items of the subdivision `subdivisionKey`: its own (admin region) and those of the valid article-type
 * objects in its run scope tiles, sorted. A tile shared with a neighbour counts for both.
 */
export async function wikivoyageItems(db: Db, subdivisionKey: string): Promise<string[]> {
  const [sub] = await db
    .select({ id: subdivisions.id, geoObjectId: subdivisions.geoObjectId })
    .from(subdivisions)
    .where(and(eq(subdivisions.key, subdivisionKey), isNull(subdivisions.validTo)));
  if (!sub) return [];
  const scopeTiles = await subdivisionTileIds(db, sub.id);
  const inTiles = await db
    .selectDistinct({ qid: geoObjects.wikidataId })
    .from(geoObjects)
    .innerJoin(tileGeoObjects, eq(tileGeoObjects.geoObjectId, geoObjects.id))
    .where(
      and(
        inArray(tileGeoObjects.tileId, scopeTiles),
        validAt(geoObjects),
        inArray(geoObjects.type, ARTICLE_TYPES),
        isNotNull(geoObjects.wikidataId),
      ),
    );
  const [own] = await db.select({ qid: geoObjects.wikidataId }).from(geoObjects).where(eq(geoObjects.id, sub.geoObjectId));
  const qids = new Set(inTiles.map((r) => r.qid!));
  if (own?.qid) qids.add(own.qid);
  return [...qids].sort();
}

/**
 * Queues Wikivoyage articles for the source: per article its document (`travel_guide`, created when unknown) and a
 * frontier row at depth 0 `queued` (a known row stays as it is). Articles the crawl rules do not allow are left out.
 */
export async function queueArticles(db: Db, source: Source, articles: Sitelink[]): Promise<{ articles: number; newDocuments: number }> {
  const { trackingParams } = getConfig().fetch;
  const byUrl = new Map<string, Sitelink>();
  for (const article of articles) {
    const normalized = normalizeUrl(article.url, trackingParams);
    if (normalized && urlAllowed(normalized, source.crawlRules, source.domain).ok && !byUrl.has(normalized)) byUrl.set(normalized, article);
  }
  let newDocuments = 0;
  for (const [urlNormalized, article] of byUrl) {
    const doc = await ensureDocument(db, { sourceId: source.id, url: article.url, urlNormalized, docType: "travel_guide" });
    if (doc.created) newDocuments++;
    await db
      .insert(crawlFrontier)
      .values({ sourceId: source.id, url: article.url, urlNormalized, depth: 0, status: "queued" })
      .onConflictDoNothing({ target: [crawlFrontier.sourceId, crawlFrontier.urlNormalized] });
  }
  return { articles: byUrl.size, newDocuments };
}

/**
 * Job `sources.wikivoyage`: queues the Wikivoyage articles of the subdivision `subdivisionKey` for the crawl that
 * follows. The articles are the sitelinks on `<lang>wikivoyage` (languages = the subdivision's `sourceLanguages`) of
 * its own Wikidata item and of the valid areas, archipelagos, islands, islets and settlements in its tiles. Does nothing while
 * the Wikivoyage source is not approved (an admin's pause stands).
 */
export async function seedWikivoyage(
  db: Db,
  subdivisionKey: string,
  deps: { transport: Transport },
  ctx: CallContext,
): Promise<{ objects: number; articles: number; newDocuments: number }> {
  const scope = await gazetteerScope(db, subdivisionKey);
  const sourceId = await sourceIdByDomain(db, WIKIVOYAGE_DOMAIN);
  const source = sourceId ? await getSource(db, sourceId) : null;
  if (!source || source.status !== "approved") return { objects: 0, articles: 0, newDocuments: 0 };
  const qids = await wikivoyageItems(db, subdivisionKey);
  const sites = scope.sourceLanguages.map((lang) => `${lang}wikivoyage`);
  const sitelinks = await fetchSitelinks(deps.transport, qids, sites, { ...ctx, sourceId: source.id }, getConfig().gazetteer.wikidata);
  const queued = await queueArticles(db, source, [...sitelinks.values()].flat());
  return { objects: qids.length, ...queued };
}
