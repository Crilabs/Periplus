import { and, asc, eq, isNull, sql } from "drizzle-orm";
import type { Transport } from "@/lib/adapters/http";
import { buildWikidataQuery, wikidataQuery, type WikidataItem } from "@/lib/adapters/wikidata";
import { getConfig, type AreaConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { geoObjects, type GeoObjectType, type PoiCategory } from "@/lib/db/schema";
import { areaBbox } from "@/lib/domain/gazetteer/areas";
import { bufferBbox } from "@/lib/domain/gazetteer/land";
import { findMatch, openPairTask } from "@/lib/domain/gazetteer/merge";
import { addNames, type NameDraft } from "@/lib/domain/gazetteer/names";
import { upsertGeoObject } from "@/lib/domain/gazetteer/store";
import { createLogger } from "@/lib/logger";

export const WIKIDATA_STAGE = "gazetteer.wikidata";

const log = createLogger("gazetteer.wikidata");

/** Types a Wikidata item may create without OSM counterpart; OSM is more complete for the others. */
const CREATE_WITHOUT_MATCH = new Set<GeoObjectType>(["poi", "island", "islet", "cape", "bay"]);

/** Type (and POI category) of the first class in config order that the item has. */
function classify(
  item: WikidataItem,
  classes: Record<string, GeoObjectType>,
  categories: Record<string, PoiCategory>,
): { type: GeoObjectType; category?: PoiCategory } | null {
  const cls = Object.keys(classes).find((c) => item.classes.includes(c));
  if (!cls) return null;
  const type = classes[cls]!;
  return type === "poi" && categories[cls] ? { type, category: categories[cls] } : { type };
}

/**
 * Labels and aliases as names with `origin wikidata`. Labels come first, so a language's label is the
 * one `addNames` prefers; an alias is preferred only for a language without label or earlier name.
 */
function itemNames(item: WikidataItem): NameDraft[] {
  return [...item.labels]
    .sort((a, b) => Number(a.alias) - Number(b.alias))
    .map((l) => ({ name: l.value, language: l.language, origin: "wikidata" }));
}

/** The valid object already carrying this Wikidata ID. */
async function byWikidataId(db: Db, qid: string): Promise<string | undefined> {
  const [row] = await db
    .select({ id: geoObjects.id })
    .from(geoObjects)
    .where(and(eq(geoObjects.wikidataId, qid), isNull(geoObjects.validTo)));
  return row?.id;
}

/** The valid, unlinked object whose OSM tag `wikidata` names this item (lowest id of several). */
async function byOsmTag(db: Db, qid: string): Promise<string | undefined> {
  const [row] = await db
    .select({ id: geoObjects.id })
    .from(geoObjects)
    .where(
      and(
        sql`${geoObjects.tags}->>'wikidata' = ${qid}`,
        isNull(geoObjects.wikidataId),
        isNull(geoObjects.validTo),
        isNull(geoObjects.mergedIntoId),
      ),
    )
    .orderBy(asc(geoObjects.id))
    .limit(1);
  return row?.id;
}

/** Sets `wikidata_id` on an object that has none; false when it already carries another one. */
async function link(db: Db, id: string, qid: string): Promise<boolean> {
  const updated = await db
    .update(geoObjects)
    .set({ wikidataId: qid, updatedAt: sql`now()` })
    .where(and(eq(geoObjects.id, id), isNull(geoObjects.wikidataId)))
    .returning({ id: geoObjects.id });
  return updated.length > 0;
}

/**
 * Stage `gazetteer.wikidata` (Spec 03, step 2): queries WDQS for items of the configured classes in the
 * area box plus `bboxBufferKm` and, in one transaction, per item: (1) an object with this `wikidata_id`
 * gets the names; (2) else an object whose OSM tag `wikidata` names the item is linked; (3) else
 * `findMatch` within `wikidataLinkDistanceM`: `same` links (unless that object carries another Wikidata
 * ID, then it counts as uncertain), `uncertain` creates a new object and opens a pair task, `none` creates
 * one only for poi, island, islet, cape and bay. Labels and aliases become names with `origin wikidata`.
 */
export async function importWikidata(
  db: Db,
  input: { area: AreaConfig; runId: string },
  deps: { transport: Transport },
): Promise<{ linked: number; created: number; uncertain: number; names: number }> {
  const { area, runId } = input;
  const { gazetteer, categories } = getConfig();
  const { classes, languages } = gazetteer.wikidata;
  const bbox = bufferBbox(areaBbox(area), gazetteer.bboxBufferKm);

  // Fetch outside the import transaction: a rollback must not drop the external_calls row.
  const sparql = buildWikidataQuery(bbox, Object.keys(classes), languages);
  const items = await wikidataQuery(deps.transport, sparql, { db, runId, stage: WIKIDATA_STAGE }, gazetteer.wikidata);

  return db.transaction(async (tx) => {
    const result = { linked: 0, created: 0, uncertain: 0, names: 0 };
    for (const item of items) {
      const cls = classify(item, classes, categories.wikidata);
      if (!cls) continue;
      const names = itemNames(item);

      const known = await byWikidataId(tx, item.id);
      if (known) {
        result.names += await addNames(tx, known, names);
        continue;
      }

      const tagged = await byOsmTag(tx, item.id);
      if (tagged) {
        await link(tx, tagged, item.id);
        result.linked++;
        result.names += await addNames(tx, tagged, names);
        continue;
      }

      const match = await findMatch(
        tx,
        { type: cls.type, point: { lon: item.lon, lat: item.lat }, names: names.map((n) => n.name) },
        gazetteer.merge,
        { distanceM: gazetteer.merge.wikidataLinkDistanceM },
      );
      if (match.kind === "same" && (await link(tx, match.id, item.id))) {
        result.linked++;
        result.names += await addNames(tx, match.id, names);
        continue;
      }
      if (match.kind === "none" && !CREATE_WITHOUT_MATCH.has(cls.type)) continue;

      const created = await upsertGeoObject(tx, {
        ...cls,
        origin: "wikidata",
        wikidataId: item.id,
        geometry: { type: "Point", coordinates: [item.lon, item.lat] },
        names,
      });
      if ("skipped" in created) {
        log.warn({ wikidataId: item.id, reason: created.skipped }, "skipped wikidata item with unusable geometry");
        continue;
      }
      result.created++;
      result.names += created.names;
      if (match.kind !== "none") {
        await openPairTask(tx, created.id, match.id, {
          similarity: match.similarity,
          distanceM: match.distanceM,
          source: "wikidata",
        });
        result.uncertain++;
      }
    }
    return result;
  });
}
