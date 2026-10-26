import { eq, sql } from "drizzle-orm";
import { getConfig, type AppConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { placeWebsites, type PlaceWebsiteOrigin } from "@/lib/db/schema";
import { ensureResearchSource } from "@/lib/domain/research/sources";
import { isForbiddenHost, isForbiddenUrl } from "@/lib/domain/sources/forbidden-domains";
import { suggestType } from "@/lib/domain/sources/type-hints";
import { normalizeUrl, registrableDomain } from "@/lib/domain/sources/urls";
import { bindingKey, bindingKeySql } from "./binding-key";

/*
 * Binding of a place's website to the place (spec 15 C „Bindung an den Ort“, N3b): the address of a place is recorded
 * (`place_websites`) under the research source of its domain (`ensureResearchSource`: no crawl rules, no approval task)
 * and, where it is the place's own page, bound to it: the research takes a bound website as the place's official page
 * (`recordWebsiteHit`).
 */

type AttachConfig = Pick<AppConfig, "discovery" | "delivery" | "fetch">;

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

const normalized = (url: string, cfg: AttachConfig) => normalizeUrl(url, cfg.fetch.trackingParams) ?? url;

/**
 * Records the website of a place (append-only `place_websites` row) under the research source of its domain
 * (`ensureResearchSource`; none on a forbidden domain). `bound` (the website is the place's own page, spec 15 C
 * „Bindung an den Ort“) is false without a source, for an `authority` domain (`suggestType`) and for a start URL
 * another place's current website already has (by `bindingKey`): then that place's binding ends too, by a new row of
 * it with `bound` false (a municipality or port authority page for several harbours binds none).
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
  const sourceId = forbidden ? null : (await ensureResearchSource(tx, domain)).id;

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
