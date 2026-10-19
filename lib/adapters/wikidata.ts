import type { GazetteerConfig } from "@/lib/config";
import type { Bbox } from "@/lib/domain/tiles";
import { HttpError, RetryableHttpError, httpCall, type CallContext, type Transport } from "./http";

export type WikidataItem = {
  id: string;
  classes: string[];
  lon: number;
  lat: number;
  labels: Array<{ language: string; value: string; alias: boolean }>;
  osmRelationId?: string;
};

const QID = /^Q\d+$/;
const LANGUAGE = /^[a-z]{2,3}(-[a-z0-9]+)*$/i;

/**
 * SPARQL for items with a coordinate in the box whose class is (a subclass of) one of `classes`,
 * with labels and aliases in `languages` (one row per name) and the OSM relation id (P402).
 */
export function buildWikidataQuery(bbox: Bbox, classes: string[], languages: string[]): string {
  for (const c of classes) if (!QID.test(c)) throw new Error(`invalid Wikidata class ${c}`);
  for (const l of languages) if (!LANGUAGE.test(l)) throw new Error(`invalid language ${l}`);
  const [west, south, east, north] = bbox;
  const langs = languages.map((l) => `"${l}"`).join(", ");
  return `SELECT ?item ?class ?coord ?name ?lang ?isAlias ?osmRel WHERE {
  SERVICE wikibase:box {
    ?item wdt:P625 ?coord .
    bd:serviceParam wikibase:cornerSouthWest "Point(${west} ${south})"^^geo:wktLiteral .
    bd:serviceParam wikibase:cornerNorthEast "Point(${east} ${north})"^^geo:wktLiteral .
  }
  VALUES ?class { ${classes.map((c) => `wd:${c}`).join(" ")} }
  ?item wdt:P31/wdt:P279* ?class .
  OPTIONAL {
    { ?item rdfs:label ?name . BIND(false AS ?isAlias) }
    UNION
    { ?item skos:altLabel ?name . BIND(true AS ?isAlias) }
    BIND(LANG(?name) AS ?lang)
    FILTER(?lang IN (${langs}))
  }
  OPTIONAL { ?item wdt:P402 ?osmRel . }
}
`;
}

type Binding = { type: string; value: string; datatype?: string; "xml:lang"?: string };
type Row = Partial<Record<"item" | "class" | "coord" | "name" | "lang" | "isAlias" | "osmRel", Binding>>;

const WKT_POINT = /^Point\(\s*(-?[\d.eE+-]+)\s+(-?[\d.eE+-]+)\s*\)$/i;

function entityId(binding: Binding): string {
  return binding.value.slice(binding.value.lastIndexOf("/") + 1);
}

/** WDQS cuts queries at 60 s server-side; wait a little longer so its own error arrives. */
const TIMEOUT_MS = 70_000;

/** Runs one SPARQL query against WDQS and folds the one-row-per-name result into one item per entity. */
export async function wikidataQuery(
  transport: Transport,
  sparql: string,
  ctx: CallContext,
  cfg: GazetteerConfig["wikidata"],
): Promise<WikidataItem[]> {
  const res = await httpCall(
    transport,
    {
      service: "wikidata",
      operation: "sparql",
      url: `${cfg.endpoint}?format=json&query=${encodeURIComponent(sparql)}`,
      headers: { Accept: "application/sparql-results+json" },
      timeoutMs: TIMEOUT_MS,
      ratePerMinute: cfg.ratePerMinute,
    },
    ctx,
  );
  let rows: Row[];
  try {
    rows = (JSON.parse(res.text()) as { results: { bindings: Row[] } }).results.bindings;
  } catch (error) {
    throw new RetryableHttpError("wikidata returned an unreadable answer", res.status, { cause: error });
  }

  const items = new Map<string, WikidataItem>();
  for (const row of rows) {
    if (!row.item) continue;
    const id = entityId(row.item);
    let item = items.get(id);
    if (!item) {
      const point = row.coord && WKT_POINT.exec(row.coord.value);
      if (!point) continue;
      item = { id, classes: [], lon: Number(point[1]), lat: Number(point[2]), labels: [] };
      items.set(id, item);
    }
    if (row.class) {
      const cls = entityId(row.class);
      if (!item.classes.includes(cls)) item.classes.push(cls);
    }
    if (row.name) {
      const language = row.lang?.value ?? row.name["xml:lang"];
      const alias = row.isAlias?.value === "true";
      if (
        language &&
        !item.labels.some((l) => l.language === language && l.value === row.name!.value && l.alias === alias)
      ) {
        item.labels.push({ language, value: row.name.value, alias });
      }
    }
    if (row.osmRel && item.osmRelationId === undefined) item.osmRelationId = row.osmRel.value;
  }
  return [...items.values()];
}

export type Sitelink = { site: string; title: string; url: string };

/** Items per `wbgetentities` request (the API's limit for anonymous clients). */
const MAX_IDS_PER_REQUEST = 50;
const SITE = /^[a-z0-9_]+$/;
const API_TIMEOUT_MS = 30_000;

type EntitiesAnswer = {
  entities?: Record<
    string,
    {
      id?: string;
      missing?: string;
      redirects?: { from?: string; to?: string };
      sitelinks?: Record<string, { site?: unknown; title?: unknown; url?: unknown }>;
    }
  >;
  error?: { code?: string; info?: string };
};

/** Sorted, distinct, validated item ids. */
function itemIds(qids: string[]): string[] {
  const ids = [...new Set(qids)].sort();
  for (const id of ids) if (!QID.test(id)) throw new Error(`invalid Wikidata item ${id}`);
  return ids;
}

/**
 * One `wbgetentities` request for `ids` with `query` (props, filters) in the bucket of all Wikidata calls. An API
 * error is an `HttpError`, except `maxlag` and unreadable answers (`RetryableHttpError`).
 */
async function getEntities(
  transport: Transport,
  ids: string[],
  query: string,
  operation: string,
  ctx: CallContext,
  cfg: GazetteerConfig["wikidata"],
): Promise<NonNullable<EntitiesAnswer["entities"]>> {
  const res = await httpCall(
    transport,
    {
      service: "wikidata",
      operation,
      url: `${cfg.apiEndpoint}?action=wbgetentities&ids=${ids.join("|")}&${query}&format=json`,
      headers: { Accept: "application/json" },
      timeoutMs: API_TIMEOUT_MS,
      ratePerMinute: cfg.ratePerMinute,
      meta: { items: ids.length },
    },
    ctx,
  );
  let answer: EntitiesAnswer;
  try {
    answer = JSON.parse(res.text()) as EntitiesAnswer;
    if (typeof answer !== "object" || answer === null) throw new Error("not an object");
  } catch (error) {
    throw new RetryableHttpError("wikidata returned an unreadable answer", res.status, { cause: error });
  }
  if (answer.error) {
    const message = `wikidata wbgetentities: ${answer.error.code ?? "error"}: ${answer.error.info ?? ""}`;
    if (answer.error.code === "maxlag") throw new RetryableHttpError(message, res.status);
    throw new HttpError(message, res.status);
  }
  return answer.entities ?? {};
}

/**
 * The sitelinks of the items `qids` on the wikis `sites` (e.g. `enwikivoyage`), with their article URLs: one
 * `wbgetentities` call (`props=sitelinks/urls`) per 50 items, ids and sites sorted (stable URLs). Items without such a
 * sitelink (or unknown items) are missing from the map. Rate limit `cfg.ratePerMinute` in the bucket of all Wikidata
 * calls; an API error is an `HttpError`, except `maxlag` and unreadable answers (`RetryableHttpError`).
 */
export async function fetchSitelinks(
  transport: Transport,
  qids: string[],
  sites: string[],
  ctx: CallContext,
  cfg: GazetteerConfig["wikidata"],
): Promise<Map<string, Sitelink[]>> {
  const ids = itemIds(qids);
  const wikis = [...new Set(sites)].sort();
  for (const site of wikis) if (!SITE.test(site)) throw new Error(`invalid site ${site}`);
  const result = new Map<string, Sitelink[]>();
  if (ids.length === 0 || wikis.length === 0) return result;
  for (let i = 0; i < ids.length; i += MAX_IDS_PER_REQUEST) {
    const batch = ids.slice(i, i + MAX_IDS_PER_REQUEST);
    const entities = await getEntities(transport, batch, `props=sitelinks/urls&sitefilter=${wikis.join("|")}`, "sitelinks", ctx, cfg);
    for (const [key, entity] of Object.entries(entities)) {
      if (entity.missing !== undefined) continue;
      const links: Sitelink[] = [];
      for (const link of Object.values(entity.sitelinks ?? {})) {
        if (typeof link.site !== "string" || typeof link.title !== "string" || typeof link.url !== "string") continue;
        if (!wikis.includes(link.site)) continue;
        links.push({ site: link.site, title: link.title, url: link.url });
      }
      links.sort((a, b) => (a.site < b.site ? -1 : a.site > b.site ? 1 : 0));
      if (links.length > 0) result.set(entity.id ?? key, links);
    }
  }
  return result;
}

/**
 * The number of sitelinks (all wikis, as `wikibase:sitelinks` counts them) of the items `qids`, an importance signal
 * (spec 07): one `wbgetentities` call (`props=sitelinks`, no site filter) per 50 items, ids sorted, in the bucket of
 * all Wikidata calls (ruling M5-P1). A redirected item counts under the asked id (and its target under its own id when
 * both were asked); a missing (deleted) item is absent from the map. Errors as `fetchSitelinks`.
 */
export async function sitelinkCounts(
  transport: Transport,
  qids: string[],
  ctx: CallContext,
  cfg: GazetteerConfig["wikidata"],
): Promise<Map<string, number>> {
  const ids = itemIds(qids);
  const result = new Map<string, number>();
  for (let i = 0; i < ids.length; i += MAX_IDS_PER_REQUEST) {
    const batch = ids.slice(i, i + MAX_IDS_PER_REQUEST);
    const entities = await getEntities(transport, batch, "props=sitelinks", "sitelink_counts", ctx, cfg);
    for (const [key, entity] of Object.entries(entities)) {
      if (entity.missing !== undefined) continue;
      // a redirect answers under its target: count it for each asked id (the redirect, and the target if asked too)
      const count = Object.keys(entity.sitelinks ?? {}).length;
      for (const id of new Set([entity.redirects?.from, entity.id ?? key])) {
        if (id !== undefined && batch.includes(id)) result.set(id, count);
      }
    }
  }
  return result;
}
