import type { Feature } from "geojson";
import type { DatasetsConfig } from "@/lib/config";
import type { Bbox } from "@/lib/domain/tiles";
import { HttpError, RetryableHttpError, httpCall, type CallContext, type Transport } from "./http";

/** A WCS 2.0.1 coverage; `subsettingCrs` when the native grid is not EPSG:4326, `time` for one slice of a time axis. */
export type WcsCoverage = Pick<DatasetsConfig["bathymetry"], "wcsUrl" | "coverageId"> & {
  subsettingCrs?: string;
  time?: string;
};

type WcsFetchConfig = WcsCoverage & Pick<DatasetsConfig["bathymetry"], "timeoutSeconds" | "ratePerMinute">;

/** WFS paging stops with an error after this many pages: a box that large is a configuration mistake. */
const MAX_WFS_PAGES = 50;

const CRS84 = "urn:ogc:def:crs:OGC:1.3:CRS84";

/** Start of a response for error messages: enough to show an OGC exception code. */
const snippet = (text: string) => text.slice(0, 200);

/**
 * GetCoverage URL for `bbox` as GeoTIFF. Axis labels `Long`/`Lat` as in EMODnet's DescribeCoverage
 * (`axisLabels="Lat Long"` for the DTM); the values are URL-encoded, the server rejects raw quotes.
 */
export function coverageUrl(cfg: WcsCoverage, bbox: Bbox): string {
  const [west, south, east, north] = bbox;
  const params = new URLSearchParams({
    service: "WCS",
    version: "2.0.1",
    request: "GetCoverage",
    coverageId: cfg.coverageId,
    format: "image/tiff",
  });
  if (cfg.subsettingCrs) params.set("subsettingCrs", cfg.subsettingCrs);
  params.append("subset", `Long(${west},${east})`);
  params.append("subset", `Lat(${south},${north})`);
  if (cfg.time) params.append("subset", `time("${cfg.time}")`);
  return `${cfg.wcsUrl}?${params}`;
}

function isTiff(body: Uint8Array): boolean {
  const [a, b, c, d] = body;
  return (a === 0x49 && b === 0x49 && c === 0x2a && d === 0x00) || (a === 0x4d && b === 0x4d && c === 0x00 && d === 0x2a);
}

/**
 * Downloads the coverage for `bbox` as GeoTIFF bytes. WCS servers answer a bad request with an OGC
 * exception report and status 200; anything that is not a TIFF becomes a non-retryable `HttpError`.
 */
export async function fetchCoverage(
  transport: Transport,
  bbox: Bbox,
  ctx: CallContext,
  cfg: WcsFetchConfig,
  service = "emodnet-bathymetry",
): Promise<Uint8Array> {
  const res = await httpCall(
    transport,
    {
      service,
      operation: "GetCoverage",
      url: coverageUrl(cfg, bbox),
      timeoutMs: cfg.timeoutSeconds * 1000,
      ratePerMinute: cfg.ratePerMinute,
    },
    ctx,
  );
  if (!isTiff(res.body)) {
    throw new HttpError(`${service} GetCoverage ${cfg.coverageId} returned no TIFF: ${snippet(res.text())}`, res.status);
  }
  return res.body;
}

/**
 * One WFS 2.0.0 GetFeature page as GeoJSON. Box and output in CRS84, i.e. lon/lat order: with
 * EPSG:4326 WFS 2.0 servers read the box as lat/lon and return features from the wrong region.
 * `sortBy` gives the pages a stable order where the server has no primary key to page by (GeoServer
 * refuses `startIndex` then: "Cannot do natural order without a primary key").
 */
export function wfsPageUrl(input: {
  url: string;
  typeName: string;
  bbox: Bbox;
  startIndex: number;
  count: number;
  sortBy?: string;
}): string {
  const [west, south, east, north] = input.bbox;
  const params = new URLSearchParams({
    service: "WFS",
    version: "2.0.0",
    request: "GetFeature",
    typeNames: input.typeName,
    outputFormat: "application/json",
    srsName: CRS84,
    bbox: `${west},${south},${east},${north},${CRS84}`,
    count: String(input.count),
    startIndex: String(input.startIndex),
  });
  if (input.sortBy) params.set("sortBy", input.sortBy);
  return `${input.url}?${params}`;
}

type WfsPage = { features: Feature[]; numberMatched: number | undefined };

/** The server's count of all matching features: `numberMatched` (WFS 2.0), else GeoServer's `totalFeatures`; undefined when absent or "unknown". */
function matchedCount(parsed: { numberMatched?: unknown; totalFeatures?: unknown }): number | undefined {
  for (const value of [parsed.numberMatched, parsed.totalFeatures]) {
    if (typeof value === "number" && Number.isInteger(value) && value >= 0) return value;
  }
  return undefined;
}

function parsePage(text: string, where: string, status: number): WfsPage {
  if (text.trimStart().startsWith("<") && text.includes("ExceptionReport")) {
    throw new HttpError(`${where} returned an OGC exception: ${snippet(text)}`, status);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new RetryableHttpError(`${where} returned invalid JSON (${text.length} chars): ${snippet(text)}`, status, {
      cause: error,
    });
  }
  const answer = (parsed ?? {}) as { features?: unknown; numberMatched?: unknown; totalFeatures?: unknown };
  if (!Array.isArray(answer.features)) throw new RetryableHttpError(`${where} answer has no features array`, status);
  return { features: answer.features as Feature[], numberMatched: matchedCount(answer) };
}

/**
 * All features of one WFS layer in `bbox`, fetched in pages of `pageSize` until a page comes back
 * short. Returns the raw page texts (for archiving) and the features in order. Invalid JSON is
 * retryable (overloaded servers answer with HTML), an OGC exception report is not; more than
 * 50 pages is an error. When the first page states how many features match (`numberMatched`, else
 * `totalFeatures`), a different number of fetched features is a `RetryableHttpError`: a server
 * capping pages below `pageSize`, or data changing between pages, would otherwise silently drop
 * features (a missing restriction area allows anchoring).
 */
export async function fetchWfsFeatures(
  transport: Transport,
  input: {
    service: string;
    url: string;
    typeName: string;
    bbox: Bbox;
    pageSize: number;
    timeoutMs: number;
    ratePerMinute: number;
    sortBy?: string;
  },
  ctx: CallContext,
): Promise<{ pages: string[]; features: Feature[] }> {
  const pages: string[] = [];
  const features: Feature[] = [];
  let matched: number | undefined;
  for (let page = 0; page < MAX_WFS_PAGES; page++) {
    const startIndex = page * input.pageSize;
    const res = await httpCall(
      transport,
      {
        service: input.service,
        operation: "GetFeature",
        url: wfsPageUrl({
          url: input.url,
          typeName: input.typeName,
          bbox: input.bbox,
          startIndex,
          count: input.pageSize,
          sortBy: input.sortBy,
        }),
        timeoutMs: input.timeoutMs,
        ratePerMinute: input.ratePerMinute,
      },
      ctx,
    );
    const text = res.text();
    const parsed = parsePage(text, `${input.service} GetFeature ${input.typeName} @${startIndex}`, res.status);
    if (page === 0) matched = parsed.numberMatched;
    pages.push(text);
    features.push(...parsed.features);
    if (parsed.features.length < input.pageSize) {
      if (matched !== undefined && matched !== features.length) {
        throw new RetryableHttpError(
          `${input.service} GetFeature ${input.typeName}: fetched ${features.length} features, the server matched ${matched}`,
          res.status,
        );
      }
      return { pages, features };
    }
  }
  throw new Error(
    `${input.service} GetFeature ${input.typeName}: more than ${MAX_WFS_PAGES} pages of ${input.pageSize} features in [${input.bbox.join(",")}]`,
  );
}
