import { z } from "zod";
import type { ExtractionConfig } from "@/lib/config";
import { tileBbox } from "@/lib/domain/tiles";
import { httpCall, RetryableHttpError, type CallContext, type HttpCallDeps, type Transport } from "./http";
import { assertNotSimulated } from "./simulation";

/*
 * Nominatim (OSM geocoder), used only as a radius search around a tile (spec 06, new names). Usage policy: at most one
 * request per second (rate bucket `nominatim`, 60 per minute with a burst of 1), the contact User-Agent of `httpCall`,
 * no bulk geocoding: one request per name candidate.
 */

export type NominatimHit = {
  /** `node/…`, `way/…`, `relation/…` */
  osmId: string;
  name: string;
  lon: number;
  lat: number;
  category: string;
  type: string;
  /** Distance to the tile centre in metres. */
  distanceM: number;
};

export type NominatimQuery = { query: string; tileId: string; radiusKm: number; limit: number };

const TIMEOUT_MS = 30_000;
const KM_PER_DEGREE = 111.32;
const EARTH_RADIUS_M = 6_371_008.8;

const resultSchema = z.object({
  osm_type: z.enum(["node", "way", "relation"]),
  osm_id: z.union([z.number(), z.string()]),
  lat: z.coerce.number(),
  lon: z.coerce.number(),
  category: z.string().optional(),
  class: z.string().optional(),
  type: z.string(),
  name: z.string().optional(),
  display_name: z.string(),
});

/** The tile box widened by `radiusKm` on every side, as `[west, north, east, south]` (5 decimals). */
export function nominatimViewbox(tileId: string, radiusKm: number): [number, number, number, number] {
  const [west, south, east, north] = tileBbox(tileId);
  const lat = (south + north) / 2;
  const dLat = radiusKm / KM_PER_DEGREE;
  const dLon = radiusKm / (KM_PER_DEGREE * Math.cos((lat * Math.PI) / 180));
  const round = (v: number) => Math.round(v * 1e5) / 1e5;
  return [round(west - dLon), round(north + dLat), round(east + dLon), round(south - dLat)];
}

/** Great-circle distance in metres. */
export function haversineM(a: { lon: number; lat: number }, b: { lon: number; lat: number }): number {
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** The search URL: free-text query bounded to the widened tile box. */
export function nominatimUrl(q: NominatimQuery, endpoint: string): string {
  const params = new URLSearchParams({
    format: "jsonv2",
    q: q.query,
    viewbox: nominatimViewbox(q.tileId, q.radiusKm).join(","),
    bounded: "1",
    limit: String(q.limit),
    "accept-language": "de,en,el",
  });
  return `${endpoint}?${params.toString()}`;
}

/**
 * Searches Nominatim for `query` within `radiusKm` around the tile (bounded viewbox), one request booked under service
 * `nominatim`. Hits carry their distance to the tile centre and come nearest first. An answer that is no result list
 * is a `RetryableHttpError` (an overloaded server's error page).
 */
export async function searchNominatim(
  transport: Transport,
  q: NominatimQuery,
  ctx: CallContext,
  cfg: ExtractionConfig["geocode"],
  deps: HttpCallDeps = {},
): Promise<NominatimHit[]> {
  assertNotSimulated("nominatim", "search");
  const url = nominatimUrl(q, cfg.endpoint);
  const res = await httpCall(
    transport,
    {
      service: "nominatim",
      operation: "search",
      url,
      timeoutMs: TIMEOUT_MS,
      ratePerMinute: cfg.ratePerMinute,
      rateKey: "nominatim",
      // Usage policy: an absolute maximum of one request per second, never a burst.
      rateBurst: 1,
      headers: { Accept: "application/json" },
      meta: { query: q.query, tileId: q.tileId },
    },
    { ...ctx, tileId: ctx.tileId ?? q.tileId },
    deps,
  );
  let raw: unknown;
  try {
    raw = JSON.parse(res.text());
  } catch {
    throw new RetryableHttpError(`Nominatim answered no JSON for ${url}`, res.status);
  }
  const parsed = z.array(resultSchema).safeParse(raw);
  if (!parsed.success) throw new RetryableHttpError(`Nominatim answered no result list for ${url}`, res.status);
  const [west, south, east, north] = tileBbox(q.tileId);
  const centre = { lon: (west + east) / 2, lat: (south + north) / 2 };
  return parsed.data
    .map((r) => ({
      osmId: `${r.osm_type}/${r.osm_id}`,
      name: r.name || r.display_name.split(",")[0]!.trim(),
      lon: r.lon,
      lat: r.lat,
      category: r.category ?? r.class ?? "",
      type: r.type,
      distanceM: Math.round(haversineM(centre, r)),
    }))
    .sort((a, b) => a.distanceM - b.distanceM || a.osmId.localeCompare(b.osmId));
}
