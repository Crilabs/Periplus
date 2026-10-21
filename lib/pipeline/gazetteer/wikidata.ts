import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Transport } from "@/lib/adapters/http";
import { buildWikidataQuery, wikidataQuery, type WikidataItem } from "@/lib/adapters/wikidata";
import { getConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { geoObjects, type GeoObjectType, type PoiCategory } from "@/lib/db/schema";
import type { GazetteerScope } from "@/lib/domain/gazetteer/scope";
import { bufferBbox } from "@/lib/domain/gazetteer/land";
import { findMatch, openPairTask, resolveMergedByExternalId, typeGroup } from "@/lib/domain/gazetteer/merge";
import { addNames, type NameDraft } from "@/lib/domain/gazetteer/names";
import { nearSea } from "@/lib/domain/gazetteer/sea-distance";
import { upsertGeoObject } from "@/lib/domain/gazetteer/store";
import { createLogger } from "@/lib/logger";

export const WIKIDATA_STAGE = "gazetteer.wikidata";

let logger: ReturnType<typeof createLogger> | undefined;
const getLog = () => (logger ??= createLogger("gazetteer.wikidata"));

/** Types a Wikidata item may create without OSM counterpart; OSM is more complete for the others. */
const CREATE_WITHOUT_MATCH = new Set<GeoObjectType>(["poi", "island", "islet", "cape", "bay"]);

type Classified = { type: GeoObjectType; category?: PoiCategory; wikidataClass?: string };

/** Type (and POI category) of the first class in config order that the item has. */
function classify(
  item: WikidataItem,
  classes: Record<string, GeoObjectType>,
  categories: Record<string, PoiCategory>,
): Classified | null {
  const cls = Object.keys(classes).find((c) => item.classes.includes(c));
  if (!cls) return null;
  const type = classes[cls]!;
  if (type !== "poi") return { type };
  return categories[cls] ? { type, category: categories[cls], wikidataClass: cls } : { type, wikidataClass: cls };
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

/**
 * The valid object already carrying this Wikidata ID (lowest id), else the survivor of an object with this
 * ID that was merged away (e.g. into an object keeping its own QID after a "same" review decision).
 */
async function byWikidataId(db: Db, qid: string): Promise<{ id: string; merged: boolean } | undefined> {
  const [row] = await db
    .select({ id: geoObjects.id })
    .from(geoObjects)
    .where(and(eq(geoObjects.wikidataId, qid), isNull(geoObjects.validTo)))
    .orderBy(asc(geoObjects.id))
    .limit(1);
  if (row) return { id: row.id, merged: false };
  const survivor = await resolveMergedByExternalId(db, "wikidata_id", qid);
  return survivor ? { id: survivor, merged: true } : undefined;
}

/**
 * The valid, unlinked object of a type compatible with the item's (same type group as in `findMatch`) whose
 * OSM tag `wikidata` names this item (lowest id of several). A tag naming an item of another type (e.g. a
 * village node tagged with a museum in it) does not link.
 */
async function byOsmTag(db: Db, qid: string, type: GeoObjectType): Promise<string | undefined> {
  const [row] = await db
    .select({ id: geoObjects.id })
    .from(geoObjects)
    .where(
      and(
        sql`${geoObjects.tags}->>'wikidata' = ${qid}`,
        inArray(geoObjects.type, typeGroup(type)),
        isNull(geoObjects.wikidataId),
        isNull(geoObjects.validTo),
        isNull(geoObjects.mergedIntoId),
      ),
    )
    .orderBy(asc(geoObjects.id))
    .limit(1);
  return row?.id;
}

async function isPoi(db: Db, id: string): Promise<boolean> {
  const [row] = await db.select({ type: geoObjects.type }).from(geoObjects).where(eq(geoObjects.id, id));
  return row?.type === "poi";
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
 * subdivision box plus `bboxBufferKm` and, in one transaction, per item: (1) an object with this `wikidata_id`
 * gets the names (for an object merged away with it, its survivor gets them and counts as linked); (2) else
 * an object of a compatible type whose OSM tag `wikidata` names the item is linked; (3) else `findMatch`
 * within `wikidataLinkDistanceM`, ignoring objects known only from GeoNames: `same` links (unless that
 * object carries another Wikidata ID, then it counts as uncertain), `uncertain` creates a new object and
 * opens a pair task, `none` creates one only for poi, island, islet, cape and bay. Steps 1 and 2 run for all
 * items before step 3. A POI farther than `poiCoastDistanceKm` from an IHO sea is skipped and counted in `skipped`. Labels and aliases become names with `origin wikidata`.
 */
export async function importWikidata(
  db: Db,
  input: { scope: GazetteerScope; runId: string },
  deps: { transport: Transport },
): Promise<{ linked: number; created: number; uncertain: number; names: number; skipped: number }> {
  const { scope, runId } = input;
  const { gazetteer, categories } = getConfig();
  const { classes, languages } = gazetteer.wikidata;
  const bbox = bufferBbox(scope.bbox, gazetteer.bboxBufferKm);

  // Fetch outside the import transaction: a rollback must not drop the external_calls row.
  const sparql = buildWikidataQuery(bbox, Object.keys(classes), languages);
  const items = await wikidataQuery(deps.transport, sparql, { db, runId, stage: WIKIDATA_STAGE }, gazetteer.wikidata);

  return db.transaction(async (tx) => {
    const result = { linked: 0, created: 0, uncertain: 0, names: 0, skipped: 0 };
    // ID and tag links first, matching by name second: a name match then sees the names of every item
    // linked by ID, as a rerun would, so it does not depend on the order of the items.
    const unlinked: Array<{ item: WikidataItem; cls: Classified; names: NameDraft[] }> = [];
    for (const item of items) {
      const cls = classify(item, classes, categories.wikidata);
      if (!cls) continue;
      const names = itemNames(item);

      const known = await byWikidataId(tx, item.id);
      if (known) {
        if (known.merged) result.linked++;
        result.names += await addNames(tx, known.id, names);
        continue;
      }

      const tagged = await byOsmTag(tx, item.id, cls.type);
      if (tagged) {
        await link(tx, tagged, item.id);
        result.linked++;
        result.names += await addNames(tx, tagged, names);
        continue;
      }
      unlinked.push({ item, cls, names });
    }

    const poiNearSea = await nearSea(
      tx,
      unlinked.filter((u) => u.cls.type === "poi").map((u) => ({ key: u.item.id, lon: u.item.lon, lat: u.item.lat })),
      gazetteer.poiCoastDistanceKm,
    );

    for (const { item, cls, names } of unlinked) {
      if (cls.type === "poi" && !poiNearSea.has(item.id)) {
        result.skipped++;
        continue;
      }
      const match = await findMatch(
        tx,
        { type: cls.type, point: { lon: item.lon, lat: item.lat }, names: names.map((n) => n.name) },
        gazetteer.merge,
        // GeoNames runs after this stage: matching its objects would link differently on every rerun.
        { distanceM: gazetteer.merge.wikidataLinkDistanceM, excludeGeonamesOnly: true },
      );
      if (match.kind === "same" && (await link(tx, match.id, item.id))) {
        result.linked++;
        result.names += await addNames(tx, match.id, names);
        continue;
      }
      if (match.kind === "none" && !CREATE_WITHOUT_MATCH.has(cls.type)) continue;

      const { wikidataClass, ...classified } = cls;
      const created = await upsertGeoObject(tx, {
        ...classified,
        ...(wikidataClass ? { tags: { wikidata_class: wikidataClass } } : {}),
        origin: "wikidata",
        wikidataId: item.id,
        geometry: { type: "Point", coordinates: [item.lon, item.lat] },
        names,
      });
      if ("skipped" in created) {
        getLog().warn({ wikidataId: item.id, reason: created.skipped }, "skipped wikidata item with unusable geometry");
        continue;
      }
      result.created++;
      result.names += created.names;
      if (match.kind !== "none") {
        // Two POIs near each other are two places: no review between them (spec 16).
        if (cls.type === "poi" && (await isPoi(tx, match.id))) {
          result.uncertain++;
          continue;
        }
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
