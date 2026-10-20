import { countryConfig, getConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { subdivisionByKey } from "@/lib/domain/subdivisions/store";
import type { Bbox } from "@/lib/domain/tiles";

/** What a fine gazetteer stage works on: one subdivision (spec 14). */
export type GazetteerScope = {
  subdivisionId: string;
  key: string;
  /** ISO 3166-1 alpha-2; the country whose GeoNames rows are read. */
  country: string;
  /** Bounding box of the subdivision polygon (land plus 12 nm of water). */
  bbox: Bbox;
  sourceLanguages: string[];
};

/** The scope of the valid subdivision `key`: its override's `sourceLanguages`, else its country's. Throws for an unknown key. */
export async function gazetteerScope(db: Db, key: string): Promise<GazetteerScope> {
  const sub = await subdivisionByKey(db, key);
  if (!sub) throw new Error(`Unknown subdivision ${key}`);
  const sourceLanguages = getConfig().subdivisions.overrides[key]?.sourceLanguages ?? countryConfig(sub.country).sourceLanguages;
  return { subdivisionId: sub.id, key: sub.key, country: sub.country, bbox: sub.bbox, sourceLanguages };
}
