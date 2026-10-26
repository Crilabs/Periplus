import { desc, eq } from "drizzle-orm";
import { getConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { placeWebsites } from "@/lib/db/schema";
import { isIgnoredDomain } from "@/lib/domain/sources/type-hints";
import { isForbiddenUrl } from "@/lib/domain/sources/forbidden-domains";

export type PlaceWebsiteRow = typeof placeWebsites.$inferSelect;

export type KnownWebsite = { url: string; origin: "osm" | "wikidata" };

/**
 * The website addresses a geo object already carries, in order of trust: OSM `website`, OSM `contact:website`, the
 * Wikidata item's `P856`. Only http(s); addresses on a forbidden domain (delivery `forbiddenDomains`) or an ignored one
 * (discovery `proposals.ignoreDomains`: social media, booking portals) are dropped.
 */
export function knownWebsites(geo: { tags: Record<string, string>; websiteWikidata: string | null }): KnownWebsite[] {
  const { delivery, discovery } = getConfig();
  const candidates: KnownWebsite[] = [];
  for (const key of ["website", "contact:website"]) {
    const url = geo.tags[key]?.trim();
    if (url) candidates.push({ url, origin: "osm" });
  }
  const wd = geo.websiteWikidata?.trim();
  if (wd) candidates.push({ url: wd, origin: "wikidata" });
  return candidates.filter(({ url }) => {
    let host: string;
    try {
      const u = new URL(url);
      if (u.protocol !== "http:" && u.protocol !== "https:") return false;
      host = u.hostname.toLowerCase();
    } catch {
      return false;
    }
    return !isForbiddenUrl(url, delivery.forbiddenDomains) && !isIgnoredDomain(host, discovery.proposals);
  });
}

/** The current website of a place: its newest `place_websites` row. */
export async function currentPlaceWebsite(db: Db, placeId: string): Promise<PlaceWebsiteRow | null> {
  const [row] = await db
    .select()
    .from(placeWebsites)
    .where(eq(placeWebsites.placeId, placeId))
    .orderBy(desc(placeWebsites.createdAt), desc(placeWebsites.id))
    .limit(1);
  return row ?? null;
}
