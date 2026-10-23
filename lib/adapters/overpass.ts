import type { CategoriesConfig, GazetteerConfig } from "@/lib/config";
import type { Bbox } from "@/lib/domain/tiles";
import { RetryableHttpError, httpCall, type CallContext, type Transport } from "./http";

export type OverpassElement = {
  type: "node" | "way" | "relation";
  id: number;
  tags?: Record<string, string>;
  lat?: number;
  lon?: number;
  geometry?: Array<{ lat: number; lon: number }>;
  bounds?: { minlat: number; minlon: number; maxlat: number; maxlon: number };
  nodes?: number[];
  members?: Array<{ type: string; ref: number; role: string; geometry?: Array<{ lat: number; lon: number }> }>;
};

/** Escapes a string for use inside a double-quoted Overpass QL literal. */
function qlString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/** Escapes regex metacharacters so a configured tag value matches literally. */
function regexLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Overpass QL for the gazetteer sources of one box (Spec 03, step 1): seas and gulfs, bays, islands,
 * coastal settlements, capes, straits, harbours, marinas and the named POIs of every category rule.
 */
export function buildGazetteerQuery(bbox: Bbox, categories: CategoriesConfig, timeoutSeconds: number): string {
  const [west, south, east, north] = bbox;
  const box = `(${south},${west},${north},${east})`;
  const statements = [
    'relation["place"~"sea|gulf"]',
    'relation["natural"="bay"]',
    'way["natural"="bay"]',
    'nwr["place"~"^(island|islet|archipelago)$"]',
    'node["place"~"^(town|village|hamlet)$"]',
    'nwr["natural"~"^(bay|cape|strait|peninsula)$"]',
    'nwr["seamark:type"~"^(harbour|anchorage|mooring|small_craft_facility)$"]',
    'nwr["leisure"="marina"]',
    'nwr["harbour"]',
    ...categories.osm.map((rule) => {
      const key = qlString(rule.key);
      const filter =
        rule.values === "*"
          ? `["${key}"]`
          : `["${key}"~"^(${rule.values.map((v) => qlString(regexLiteral(v))).join("|")})$"]`;
      return `nwr${filter}["name"]`;
    }),
  ];
  return [
    `[out:json][timeout:${timeoutSeconds}];`,
    "(",
    ...statements.map((s) => `  ${s}${box};`),
    ");",
    "out geom;",
    "",
  ].join("\n");
}

/** `[out:json]` query for `statements`, each limited to `bbox`, answered with full geometry. */
function boxQuery(statements: string[], bbox: Bbox, timeoutSeconds: number): string {
  const [west, south, east, north] = bbox;
  const box = `(${south},${west},${north},${east})`;
  return [`[out:json][timeout:${timeoutSeconds}];`, "(", ...statements.map((s) => `  ${s}${box};`), ");", "out geom;", ""].join(
    "\n",
  );
}

/** Overpass QL for the road ways of `highways` in a box. */
export function buildRoadsQuery(bbox: Bbox, highways: string[], timeoutSeconds: number): string {
  const values = highways.map((h) => qlString(regexLiteral(h))).join("|");
  return boxQuery([`way["highway"~"^(${values})$"]`], bbox, timeoutSeconds);
}

/**
 * Overpass QL for submarine cables in a box: seamark cables, power cables under water or under ground
 * (the caller drops those on land) and telecom lines under water.
 */
export function buildCablesQuery(bbox: Bbox, timeoutSeconds: number): string {
  return boxQuery(
    [
      'way["seamark:type"="cable_submarine"]',
      'way["power"="cable"]["location"~"^(underwater|underground)$"]',
      'way["telecom"="line"]["location"="underwater"]',
    ],
    bbox,
    timeoutSeconds,
  );
}

/**
 * Overpass QL for the administrative boundaries of one country (spec 14): the relations of `levels` inside the
 * country's area plus the country relation itself (`admin_level=2`). No levels (a whole-country entry) = the
 * country relation only. `country` is an ISO 3166-1 alpha-2 code.
 */
export function buildBoundaryQuery(country: string, levels: number[], timeoutSeconds: number): string {
  const cc = qlString(country);
  const statements = [`relation["ISO3166-1"="${cc}"][admin_level=2][boundary=administrative];`];
  if (levels.length > 0) {
    statements.unshift(`relation[boundary=administrative][admin_level~"^(${levels.join("|")})$"](area.c);`);
  }
  return [
    `[out:json][timeout:${timeoutSeconds}];`,
    ...(levels.length > 0 ? [`area["ISO3166-1"="${cc}"][admin_level=2]->.c;`] : []),
    "(",
    ...statements.map((s) => `  ${s}`),
    ");",
    "out geom;",
    "",
  ].join("\n");
}

/** One named part of a split Overpass job: `part` names it in errors and archive keys. */
export type OverpassPart = { part: string; ql: string };

/**
 * The boundary queries of one country as parts (B15): `country` (the country relation itself, `admin_level=2`) and
 * one `level-<n>` query per level, each inside the country's area. A level that times out is fetched again alone.
 */
export function buildBoundaryQueries(country: string, levels: number[], timeoutSeconds: number): OverpassPart[] {
  return [
    { part: "country", ql: buildBoundaryQuery(country, [], timeoutSeconds) },
    ...levels.map((level) => ({
      part: `level-${level}`,
      ql: [
        `[out:json][timeout:${timeoutSeconds}];`,
        `area["ISO3166-1"="${qlString(country)}"][admin_level=2]->.c;`,
        "(",
        `  relation[boundary=administrative][admin_level=${level}](area.c);`,
        ");",
        "out geom;",
        "",
      ].join("\n"),
    })),
  ];
}

/** The kinds the coarse feature import asks Overpass for, one query each (B15). */
export const COARSE_KINDS = ["islands", "bays", "towns"] as const;
export type CoarseKind = (typeof COARSE_KINDS)[number];

/**
 * The coarse feature query of one kind for one country (B15): inside the country's `admin_level=2` area and, when
 * given, `box` (a block of a part that failed for the whole country), with full geometry. `islands`: islands and
 * archipelagos; `bays`: named bays (the caller keeps the large ones as gulfs); `towns`: the nodes of `cfg.placeTypes`.
 * One query for all kinds of a large country overloaded the public Overpass server (HTTP 502). `country` is an
 * ISO 3166-1 alpha-2 code.
 */
export function buildCoarseKindQuery(
  country: string,
  cfg: GazetteerConfig["coarse"],
  kind: CoarseKind,
  timeoutSeconds: number,
  box?: Bbox,
): string {
  const places = cfg.placeTypes.map((t) => qlString(regexLiteral(t))).join("|");
  const statements = {
    islands: ['way[place~"^(island|archipelago)$"]', 'relation[place~"^(island|archipelago)$"]'],
    bays: ["way[natural=bay][name]", "relation[natural=bay][name]"],
    towns: [`node[place~"^(${places})$"]`],
  }[kind];
  const filter = box ? `(area.c)(${box[1]},${box[0]},${box[3]},${box[2]})` : "(area.c)";
  return [
    `[out:json][timeout:${timeoutSeconds}];`,
    `area["ISO3166-1"="${qlString(country)}"][admin_level=2]->.c;`,
    "(",
    ...statements.map((st) => `  ${st}${filter};`),
    ");",
    "out geom;",
    "",
  ].join("\n");
}

/** Overpass QL for single relations by OSM id (the `extra` entries of the subdivision config), full geometry. */
export function buildRelationQuery(relationIds: number[], timeoutSeconds: number): string {
  return [`[out:json][timeout:${timeoutSeconds}];`, `relation(id:${relationIds.join(",")});`, "out geom;", ""].join("\n");
}

/** Client-side margin over the server-side `[timeout:…]`, so Overpass can answer with its own remark. */
const CLIENT_TIMEOUT_MARGIN_MS = 30_000;

/**
 * Runs one Overpass query. Overpass reports overload and timeouts as HTML or as a `remark` in an
 * otherwise valid 200 answer; both become `RetryableHttpError`.
 */
export async function overpassQuery(
  transport: Transport,
  ql: string,
  ctx: CallContext,
  cfg: GazetteerConfig["overpass"],
): Promise<{ raw: string; elements: OverpassElement[] }> {
  const res = await httpCall(
    transport,
    {
      service: "overpass",
      operation: "interpreter",
      url: cfg.endpoint,
      method: "POST",
      body: `data=${encodeURIComponent(ql)}`,
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      timeoutMs: cfg.timeoutSeconds * 1000 + CLIENT_TIMEOUT_MARGIN_MS,
      ratePerMinute: cfg.ratePerMinute,
    },
    ctx,
  );
  const raw = res.text();
  let parsed: { elements?: unknown; remark?: unknown };
  try {
    parsed = JSON.parse(raw) as typeof parsed;
  } catch (error) {
    throw new RetryableHttpError(`overpass returned invalid JSON (${raw.length} chars)`, res.status, { cause: error });
  }
  if (typeof parsed.remark === "string" && /runtime error|timed out/i.test(parsed.remark)) {
    throw new RetryableHttpError(`overpass: ${parsed.remark}`, res.status);
  }
  if (!Array.isArray(parsed.elements)) {
    throw new RetryableHttpError("overpass answer has no elements array", res.status);
  }
  return { raw, elements: parsed.elements as OverpassElement[] };
}

/**
 * `overpassQuery` with repetition (B15): a `RetryableHttpError` (429, 502, 504, timeout, a `remark` with a runtime
 * error, an HTML answer) is tried again up to `cfg.retries` times, waiting `cfg.retryDelaySeconds` and doubling it
 * per attempt. After the last attempt it throws a `RetryableHttpError` that names `opts.part` and keeps the last
 * failure as its cause (a job retry later may still succeed). Errors that are not retryable pass through at once.
 * `opts.sleep` replaces the wait (tests).
 */
export async function overpassQueryRetrying(
  transport: Transport,
  ql: string,
  ctx: CallContext,
  cfg: GazetteerConfig["overpass"],
  opts: { sleep?: (ms: number) => Promise<void>; part?: string } = {},
): Promise<{ raw: string; elements: OverpassElement[] }> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  for (let attempt = 0; ; attempt++) {
    try {
      return await overpassQuery(transport, ql, ctx, cfg);
    } catch (error) {
      if (!(error instanceof RetryableHttpError)) throw error;
      if (attempt >= cfg.retries) {
        throw new RetryableHttpError(`overpass part ${opts.part ?? "query"} failed after ${attempt + 1} attempts: ${error.message}`, error.status, { cause: error });
      }
      await sleep(cfg.retryDelaySeconds * 1000 * 2 ** attempt);
    }
  }
}
