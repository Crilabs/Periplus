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
import { upsertGeoObject } from "@/lib/domain/gazetteer/store";
import { createLogger } from "@/lib/logger";

export const WIKIDATA_STAGE = "gazetteer.wikidata";

let logger: ReturnType<typeof createLogger> | undefined;
const getLog = () => (logger ??= createLogger("gazetteer.wikidata"));

/**
 * Types a Wikidata item of the skeleton may create without OSM counterpart; OSM is more complete for the others. No
 * `poi`: the skeleton has no POI classes (N7 4.4, B8); the stage around the candidates passes its own set.
 */
const CREATE_WITHOUT_MATCH = new Set<GeoObjectType>(["island", "islet", "cape", "bay"]);

export type WikidataImportResult = { linked: number; created: number; uncertain: number; names: number; skipped: number };

type Classified = { type: GeoObjectType; category?: PoiCategory; wikidataClass?: string };

/**
 * Types that win when an item has classes of several types, in this order; every other type after them (B9: a
 * Wikidata port is often also a bay and would otherwise become one more anchorage candidate). Type logic, not a
 * threshold: it stays in code.
 */
const TYPE_PRECEDENCE: GeoObjectType[] = ["harbour", "bay"];

function precedence(type: GeoObjectType): number {
  const i = TYPE_PRECEDENCE.indexOf(type);
  return i === -1 ? TYPE_PRECEDENCE.length : i;
}

/**
 * Type (and POI category) of the item's class whose type comes first in `TYPE_PRECEDENCE` (`harbour` before `bay`
 * before all others); among equals the first in config order.
 */
function classify(
  item: WikidataItem,
  classes: Record<string, GeoObjectType>,
  categories: Record<string, PoiCategory>,
): Classified | null {
  let cls: string | undefined;
  for (const c of Object.keys(classes)) {
    if (!item.classes.includes(c)) continue;
    if (cls === undefined || precedence(classes[c]!) < precedence(classes[cls]!)) cls = c;
  }
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

/** Stores the item's `P856` on the object (`website_wikidata`); a rerun overwrites it, no history (not a core column). */
async function setWebsite(db: Db, id: string, website: string | undefined): Promise<void> {
  if (website === undefined) return;
  await db.update(geoObjects).set({ websiteWikidata: website }).where(eq(geoObjects.id, id));
}

/**
 * The per-item import of `gazetteer.wikidata` (Spec 03, step 2), for the caller's transaction `tx`. Per item of a class
 * in `opts.classes` (`harbour` before `bay` before other types, else first class in config order: `classify`; a POI
 * class gets its category from `opts.categories`):
 * (1) an object with this `wikidata_id` gets the names (for an object merged away with it, its survivor gets them and
 * counts as linked); (2) else an object of a compatible type whose OSM tag `wikidata` names the item is linked;
 * (3) else `findMatch` within `wikidataLinkDistanceM`, ignoring objects known only from GeoNames: `same` links (unless
 * that object carries another Wikidata ID, then it counts as uncertain), `uncertain` creates a new object and opens a
 * pair task (none between two POIs), `none` creates one only for a type in `opts.allowCreate`. Steps 1 and 2 run for
 * all items before step 3. Labels and aliases become names with `origin wikidata`, `P856` the object's
 * `website_wikidata`. An item whose point the store cannot use is logged and counted in `skipped`.
 */
export async function importWikidataItems(
  tx: Db,
  items: WikidataItem[],
  opts: { classes: Record<string, GeoObjectType>; categories: Record<string, PoiCategory>; allowCreate: Set<GeoObjectType> },
): Promise<WikidataImportResult> {
  const { gazetteer } = getConfig();
  const result = { linked: 0, created: 0, uncertain: 0, names: 0, skipped: 0 };
  // ID and tag links first, matching by name second: a name match then sees the names of every item
  // linked by ID, as a rerun would, so it does not depend on the order of the items.
  const unlinked: Array<{ item: WikidataItem; cls: Classified; names: NameDraft[] }> = [];
  for (const item of items) {
    const cls = classify(item, opts.classes, opts.categories);
    if (!cls) continue;
    const names = itemNames(item);

    const known = await byWikidataId(tx, item.id);
    if (known) {
      if (known.merged) result.linked++;
      result.names += await addNames(tx, known.id, names);
      await setWebsite(tx, known.id, item.website);
      continue;
    }

    const tagged = await byOsmTag(tx, item.id, cls.type);
    if (tagged) {
      await link(tx, tagged, item.id);
      result.linked++;
      result.names += await addNames(tx, tagged, names);
      await setWebsite(tx, tagged, item.website);
      continue;
    }
    unlinked.push({ item, cls, names });
  }

  for (const { item, cls, names } of unlinked) {
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
      await setWebsite(tx, match.id, item.website);
      continue;
    }
    if (match.kind === "none" && !opts.allowCreate.has(cls.type)) continue;

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
      result.skipped++;
      continue;
    }
    result.created++;
    result.names += created.names;
    await setWebsite(tx, created.id, item.website);
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
}

/**
 * Stage `gazetteer.wikidata` (Spec 03, step 2): queries WDQS for items of the configured skeleton classes
 * (`gazetteer.wikidata.classes`, no POI classes: N7 4.4, B8) in the subdivision box plus `bboxBufferKm` and imports
 * them with `importWikidataItems` in one transaction (all or nothing).
 */
export async function importWikidata(
  db: Db,
  input: { scope: GazetteerScope; runId: string },
  deps: { transport: Transport },
): Promise<WikidataImportResult> {
  const { scope, runId } = input;
  const { gazetteer, categories } = getConfig();
  const { classes, languages } = gazetteer.wikidata;
  const bbox = bufferBbox(scope.bbox, gazetteer.bboxBufferKm);

  // Fetch outside the import transaction: a rollback must not drop the external_calls row.
  const sparql = buildWikidataQuery(bbox, Object.keys(classes), languages);
  const items = await wikidataQuery(deps.transport, sparql, { db, runId, stage: WIKIDATA_STAGE }, gazetteer.wikidata);

  return db.transaction((tx) =>
    importWikidataItems(tx, items, { classes, categories: categories.wikidata, allowCreate: CREATE_WITHOUT_MATCH }),
  );
}
