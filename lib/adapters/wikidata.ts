import type { GazetteerConfig } from "@/lib/config";
import type { Bbox } from "@/lib/domain/tiles";
import { RetryableHttpError, httpCall, type CallContext, type Transport } from "./http";

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
