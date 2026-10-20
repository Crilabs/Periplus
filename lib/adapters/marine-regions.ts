import type { MultiPolygon } from "geojson";
import type { GazetteerConfig } from "@/lib/config";
import { RetryableHttpError, httpCall, type CallContext, type Transport } from "./http";

export type Sea = { mrgid: number; name: string; geometry: MultiPolygon };

/** WFS layer of the IHO sea areas (Marine Regions); its `mrgid` attribute is the Marine Regions Gazetteer id. */
const IHO_LAYER = "MarineRegions:iho";

/** Upper bound of one answer: the unthinned IHO polygons of all configured seas are ~14 MB. */
const MAX_BODY_BYTES = 64 * 1024 * 1024;

/** The WFS GetFeature URL for the IHO areas of `mrgids` (GeoJSON, one request for all ids). */
export function seasUrl(endpoint: string, mrgids: number[]): string {
  const params = new URLSearchParams({
    service: "WFS",
    version: "2.0.0",
    request: "GetFeature",
    typeNames: IHO_LAYER,
    outputFormat: "application/json",
    CQL_FILTER: `mrgid IN (${mrgids.join(",")})`,
  });
  return `${endpoint}?${params.toString()}`;
}

/**
 * Fetches the IHO sea polygons with the given MRGIDs from the Marine Regions WFS. An answer that is not a GeoJSON
 * feature collection (GeoServer reports overload and errors as HTML or XML) is a `RetryableHttpError`; an id the
 * layer does not know is simply missing from the result, the caller checks completeness.
 */
export async function fetchSeas(
  transport: Transport,
  mrgids: number[],
  ctx: CallContext,
  cfg: GazetteerConfig["marineRegions"],
): Promise<Sea[]> {
  if (mrgids.length === 0) return [];
  const res = await httpCall(
    transport,
    {
      service: "marine-regions",
      operation: "wfs-getfeature",
      url: seasUrl(cfg.endpoint, mrgids),
      method: "GET",
      timeoutMs: cfg.timeoutMs,
      maxBodyBytes: MAX_BODY_BYTES,
    },
    ctx,
  );
  const raw = res.text();
  let parsed: { type?: unknown; features?: unknown };
  try {
    parsed = JSON.parse(raw) as typeof parsed;
  } catch (error) {
    throw new RetryableHttpError(`marine regions returned invalid JSON (${raw.length} chars)`, res.status, { cause: error });
  }
  if (parsed.type !== "FeatureCollection" || !Array.isArray(parsed.features)) {
    throw new RetryableHttpError("marine regions answer is no feature collection", res.status);
  }
  const seas: Sea[] = [];
  for (const feature of parsed.features as Array<{
    properties?: { mrgid?: unknown; name?: unknown };
    geometry?: { type?: string } | null;
  }>) {
    const mrgid = feature.properties?.mrgid;
    const name = feature.properties?.name;
    const geometry = feature.geometry;
    if (typeof mrgid !== "number" || typeof name !== "string" || !geometry) continue;
    if (geometry.type !== "MultiPolygon") throw new Error(`marine regions ${mrgid}: expected MultiPolygon, got ${geometry.type}`);
    seas.push({ mrgid, name, geometry: geometry as unknown as MultiPolygon });
  }
  return seas;
}
