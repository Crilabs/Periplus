import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { unzipSync } from "fflate";
import { httpCall, getTransport, RetryableHttpError, type CallContext, type Transport } from "@/lib/adapters/http";
import { getArchive, type Archive } from "@/lib/adapters/s3";
import { getConfig, type GazetteerConfig } from "@/lib/config";
import { getEnv } from "@/lib/env";
import type { Bbox } from "@/lib/domain/tiles";

export type GeonamesRow = {
  id: string;
  name: string;
  asciiName: string;
  lat: number;
  lon: number;
  featureClass: string;
  featureCode: string;
  country: string;
};

export type GeonamesAltName = {
  geonameId: string;
  language: string;
  name: string;
  isPreferred: boolean;
  isHistoric: boolean;
};

export type GeonamesSource = {
  rows(country: string, bbox: Bbox): Promise<GeonamesRow[]>;
  alternateNames(country: string, ids: Set<string>): Promise<GeonamesAltName[]>;
};

type GeonamesConfig = GazetteerConfig["geonames"];

const DOWNLOAD_TIMEOUT_MS = 120_000;

/** ISO 639 codes (optionally with a variant suffix); `link`, `post`, `iata`, `abbr`, … are not languages. */
const LANGUAGE_CODE = /^[a-z]{2,3}(-[A-Za-z0-9]+)?$/;

export function parseGeonamesRows(text: string, bbox: Bbox, featureCodes: ReadonlySet<string>): GeonamesRow[] {
  const [west, south, east, north] = bbox;
  const out: GeonamesRow[] = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    const c = line.split("\t");
    const lat = Number(c[4]);
    const lon = Number(c[5]);
    const featureCode = c[7] ?? "";
    if (!c[0] || !Number.isFinite(lat) || !Number.isFinite(lon) || !featureCodes.has(featureCode)) continue;
    if (lon < west || lon >= east || lat < south || lat >= north) continue;
    out.push({
      id: c[0],
      name: c[1] ?? "",
      asciiName: c[2] ?? "",
      lat,
      lon,
      featureClass: c[6] ?? "",
      featureCode,
      country: c[8] ?? "",
    });
  }
  return out;
}

/** Keeps real-language names of the given objects; drops pseudo languages (`link`, `post`, `iata`, …) and historic names. */
export function parseGeonamesAltNames(text: string, ids: ReadonlySet<string>): GeonamesAltName[] {
  const out: GeonamesAltName[] = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    const c = line.split("\t");
    const geonameId = c[1] ?? "";
    const language = c[2] ?? "";
    const name = c[3] ?? "";
    if (!ids.has(geonameId) || !name) continue;
    if (language !== "" && !LANGUAGE_CODE.test(language)) continue;
    if (c[7] === "1") continue;
    out.push({ geonameId, language, name, isPreferred: c[4] === "1", isHistoric: false });
  }
  return out;
}

/** The named entry of a zip, or null when the bytes are no readable zip or lack the entry. */
function zipEntry(zip: Uint8Array, entryName: string): Uint8Array | null {
  try {
    return unzipSync(zip, { filter: (f) => f.name === entryName })[entryName] ?? null;
  } catch {
    return null;
  }
}

function monthKey(now: Date): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

/**
 * GeoNames country dumps, refreshed once per calendar month: the zip is archived under
 * `datasets/geonames/<C>[-alternate]/<YYYY-MM>.zip` and reused for the rest of that month. A download
 * is archived only once its `<C>.txt` entry was read; one that is no such zip is a `RetryableHttpError`.
 */
export function createGeonamesSource(deps: {
  transport: Transport;
  archive: Archive;
  ctx: CallContext;
  cfg: GeonamesConfig;
  now?: Date;
}): GeonamesSource {
  const { transport, archive, ctx, cfg } = deps;
  const featureCodes = new Set(Object.keys(cfg.featureCodes));

  async function dumpText(country: string, alternate: boolean): Promise<string> {
    const key = `datasets/geonames/${country}${alternate ? "-alternate" : ""}/${monthKey(deps.now ?? new Date())}.zip`;
    const entryName = `${country}.txt`;
    // A broken archived zip (from before downloads were checked) counts as a cache miss and is replaced.
    const cached = await archive.get(key);
    const cachedEntry = cached && zipEntry(cached, entryName);
    if (cachedEntry) return new TextDecoder().decode(cachedEntry);

    const url = `${cfg.baseUrl}/${alternate ? "alternatenames/" : ""}${country}.zip`;
    const res = await httpCall(
      transport,
      { service: "geonames", operation: alternate ? "alternate-names" : "dump", url, timeoutMs: DOWNLOAD_TIMEOUT_MS },
      ctx,
    );
    // Check before archiving: an HTML error page or a cut-off zip answered with 200 must not become the month's dump.
    const entry = zipEntry(res.body, entryName);
    if (!entry) throw new RetryableHttpError(`GeoNames download ${url} is no zip with ${entryName}`, res.status);
    await archive.put(key, res.body, "application/zip");
    return new TextDecoder().decode(entry);
  }

  return {
    async rows(country, bbox) {
      return parseGeonamesRows(await dumpText(country, false), bbox, featureCodes);
    },
    async alternateNames(country, ids) {
      return parseGeonamesAltNames(await dumpText(country, true), ids);
    },
  };
}

/** Reads `<dir>/<C>.txt` and `<dir>/<C>-alternate.txt`; no network, no archive. */
export function fixtureGeonamesSource(dir = "test/fixtures/geonames"): GeonamesSource {
  return {
    async rows(country, bbox) {
      const featureCodes = new Set(Object.keys(getConfig().gazetteer.geonames.featureCodes));
      return parseGeonamesRows(await readFile(join(dir, `${country}.txt`), "utf8"), bbox, featureCodes);
    },
    async alternateNames(country, ids) {
      return parseGeonamesAltNames(await readFile(join(dir, `${country}-alternate.txt`), "utf8"), ids);
    },
  };
}

export function getGeonamesSource(ctx: CallContext): GeonamesSource {
  if (getEnv().NODE_ENV === "test") return fixtureGeonamesSource();
  return createGeonamesSource({
    transport: getTransport(),
    archive: getArchive(),
    ctx,
    cfg: getConfig().gazetteer.geonames,
  });
}
