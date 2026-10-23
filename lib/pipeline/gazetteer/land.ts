import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { RetryableHttpError, type CallContext, type Transport } from "@/lib/adapters/http";
import { buildLandQuery, overpassQueryRetrying, type OverpassElement } from "@/lib/adapters/overpass";
import type { Archive } from "@/lib/adapters/s3";
import { buildWikidataQuery, wikidataQuery, type WikidataItem } from "@/lib/adapters/wikidata";
import { getConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { geoObjects, type GeoObjectType } from "@/lib/db/schema";
import { classifyOsm, osmNames } from "@/lib/domain/gazetteer/osm-classify";
import { assignObjects } from "@/lib/domain/gazetteer/hierarchy";
import { quadrants } from "@/lib/domain/gazetteer/land";
import { ensureFallbackNames } from "@/lib/domain/gazetteer/names";
import { landRings, ringBoxes, withinRing, type RingCenter } from "@/lib/domain/gazetteer/rings";
import type { GazetteerScope } from "@/lib/domain/gazetteer/scope";
import { upsertGeoObject, type GeoObjectDraft } from "@/lib/domain/gazetteer/store";
import { researchCandidates } from "@/lib/domain/research/candidates";
import type { Bbox } from "@/lib/domain/tiles";
import { createLogger } from "@/lib/logger";
import { elementGeometry, keptTags, relationPoints } from "@/lib/pipeline/gazetteer/osm";
import { importWikidataItems } from "@/lib/pipeline/gazetteer/wikidata";
import { ensureSitelinkCounts } from "@/lib/pipeline/sitelinks";

// No import of ../runs here: the job handler imports this module (import cycle with the stage registry).

export const LAND_STAGE = "gazetteer.land";

let logger: ReturnType<typeof createLogger> | undefined;
const getLog = () => (logger ??= createLogger("gazetteer.land"));

const QID = /^Q\d+$/;

/**
 * The ring centers of `scope`: the research candidates (`researchCandidates`, the same definition as the research)
 * at their anchor position, else their place position; ordered by place id.
 */
export async function ringCenters(db: Db, scope: { subdivisionKey: string } | { placeIds: string[] }): Promise<RingCenter[]> {
  const ids = await researchCandidates(db, scope);
  if (ids.length === 0) return [];
  const { rows } = await db.execute<{ id: string; lon: number; lat: number }>(sql`
    select id, ST_X(coalesce(anchor_position, position)) as lon, ST_Y(coalesce(anchor_position, position)) as lat
    from places
    where id in (select value::uuid from jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb))
      and coalesce(anchor_position, position) is not null
    order by id`);
  return rows.map((r) => ({ placeId: r.id, lon: Number(r.lon), lat: Number(r.lat) }));
}

/** A representative point of an element: the node, else the middle of its bounds, else the mean of its coordinates. */
function elementPoint(el: OverpassElement): { lon: number; lat: number } | null {
  if (el.lat !== undefined && el.lon !== undefined) return { lon: el.lon, lat: el.lat };
  if (el.bounds) return { lon: (el.bounds.minlon + el.bounds.maxlon) / 2, lat: (el.bounds.minlat + el.bounds.maxlat) / 2 };
  const coords = [...(el.geometry ?? []), ...(el.members ?? []).flatMap((m) => m.geometry ?? [])];
  if (coords.length === 0) return null;
  return {
    lon: coords.reduce((s, c) => s + c.lon, 0) / coords.length,
    lat: coords.reduce((s, c) => s + c.lat, 0) / coords.length,
  };
}

/**
 * Sets `wikidata_id` from the OSM tag `wikidata` on an object that has none, unless another valid object already
 * carries that id (one valid object per Wikidata id). N4a reads the sitelinks through `wikidata_id`.
 */
async function linkByTag(db: Db, id: string, qid: string): Promise<void> {
  await db
    .update(geoObjects)
    .set({ wikidataId: qid, updatedAt: sql`now()` })
    .where(
      and(
        eq(geoObjects.id, id),
        isNull(geoObjects.wikidataId),
        sql`not exists (select 1 from geo_objects o where o.wikidata_id = ${qid} and o.valid_to is null)`,
      ),
    );
}

export type LandThingsResult = {
  boxes: number;
  near: number;
  far: number;
  created: number;
  outsideRing: number;
  belowSitelinks: number;
  wrongType: number;
  /** Relations above `overpass.maxRelationPoints`, not stored. */
  skippedLarge: number;
  /** Elements without usable geometry or point, not stored. */
  skippedGeometry: number;
  /** Ring boxes split into quadrants after their query kept failing. */
  splits: number;
};

type Accepted = { ring: "near" | "far"; draft: GeoObjectDraft; qid?: string };

/**
 * Stage `gazetteer.land` (N7 4.4, 4.6): the things on land in two rings around the research candidates of the
 * subdivision (or of `input.placeIds`), radii from `research.state` (`landRings`), candidates grouped into boxes of at
 * most `gazetteer.land.maxBoxKm` (`ringBoxes`).
 *
 * - Near ring: Overpass per box with the rules of every category; an element counts within `nearM` of a center.
 * - Far ring: Overpass per box with the rules of the `transportCategories`, only elements with a `wikidata` tag, plus
 *   WDQS per box for `gazetteer.land.wikidataClasses` with at least `transportMinSitelinks` sitelinks. An OSM element
 *   counts within `farM` when its tag names an item with at least `transportMinSitelinks` sitelinks (else
 *   `belowSitelinks`).
 *
 * Only POIs are stored: an element the classifier takes for another type (a pier with `harbour=yes`) counts as
 * `wrongType`, a POI no ring accepts as `outsideRing`. The sitelink counts of every accepted Wikidata id (both rings)
 * go to `wikidata_sitelinks` (`ensureSitelinkCounts`, reused within `datasets.sitelinks.reuseDays`), and an OSM object
 * gets its tag as `wikidata_id` unless another object carries it. Wikidata items go through `importWikidataItems`
 * (creating only POIs). Raw Overpass answers are archived under
 * `datasets/overpass/land/<key>/<date>-<ring>-<i>.json` (a quadrant adds `.q<j>`). The stored objects are upserted in one transaction (upsert by
 * `osm_id` / `wikidata_id`, so a rerun or a neighbour subdivision creates no duplicates), then `assignObjects` sets
 * subdivision, sea, parents and tile links (every valid tile they meet, also a neighbour's) of exactly the stored
 * objects, plus their fallback names; no other object is touched. A ring box whose query keeps failing is split into
 * quadrants (`splits`); relations above `maxRelationPoints` (`skippedLarge`) and elements without usable geometry
 * (`skippedGeometry`) are logged and counted. Without centers nothing is fetched.
 */
export async function importLandThings(
  db: Db,
  input: { scope: GazetteerScope; runId: string; placeIds?: string[]; now?: Date },
  deps: { transport: Transport; archive: Archive; sleep?: (ms: number) => Promise<void> },
): Promise<LandThingsResult> {
  const { scope, runId } = input;
  const { gazetteer, categories, research } = getConfig();
  const { land, overpass } = gazetteer;
  const state = research.state;
  const result: LandThingsResult = {
    boxes: 0,
    near: 0,
    far: 0,
    created: 0,
    outsideRing: 0,
    belowSitelinks: 0,
    wrongType: 0,
    skippedLarge: 0,
    skippedGeometry: 0,
    splits: 0,
  };

  const centers = await ringCenters(db, input.placeIds ? { placeIds: input.placeIds } : { subdivisionKey: scope.key });
  if (centers.length === 0) return result;
  const { nearM, farM } = landRings(state, land.marginM);
  // the same grouping for both rings; only the widening differs
  const nearBoxes = ringBoxes(centers, nearM, land.maxBoxKm);
  const farBoxes = ringBoxes(centers, farM, land.maxBoxKm);
  result.boxes = nearBoxes.length;

  // Fetch outside the import transaction: a rollback must not drop the external_calls rows.
  const ctx: CallContext = { db, runId, stage: LAND_STAGE };
  const date = (input.now ?? new Date()).toISOString().slice(0, 10);
  const farRules = categories.osm.filter((r) => state.transportCategories.includes(r.category));
  const elements = new Map<string, OverpassElement>();
  /**
   * Asks the ring query for `box`. A box that still fails retryably after its retries is asked again per quadrant
   * (`<part>.q<i>`), recursively while its larger edge is at least `overpass.minBlockDeg` (as the coarse import, B15).
   */
  const ask = async (ring: "near" | "far", part: string, box: Bbox): Promise<void> => {
    const ql = buildLandQuery(box, ring === "near" ? categories.osm : farRules, overpass.timeoutSeconds, ring === "far");
    let answer: Awaited<ReturnType<typeof overpassQueryRetrying>>;
    try {
      answer = await overpassQueryRetrying(deps.transport, ql, ctx, overpass, { part: `${scope.key} ${part}`, sleep: deps.sleep });
    } catch (error) {
      if (!(error instanceof RetryableHttpError)) throw error;
      if (Math.max(box[2] - box[0], box[3] - box[1]) < overpass.minBlockDeg) {
        throw new RetryableHttpError(
          `gazetteer.land ${scope.key}: overpass part ${part} failed and is not split below overpass.minBlockDeg (${overpass.minBlockDeg}°): ${error.message}`,
          error.status,
          { cause: error },
        );
      }
      result.splits++;
      getLog().warn({ subdivisionKey: scope.key, part }, "split failed land Overpass box into quadrants");
      for (const [q, child] of quadrants(box).entries()) await ask(ring, `${part}.q${q}`, child);
      return;
    }
    await deps.archive.put(`datasets/overpass/land/${scope.key}/${date}-${part}.json`, answer.raw, "application/json");
    for (const el of answer.elements) if (!elements.has(`${el.type}/${el.id}`)) elements.set(`${el.type}/${el.id}`, el);
  };
  const fetchRing = async (ring: "near" | "far", boxes: Bbox[]) => {
    for (const [i, box] of boxes.entries()) await ask(ring, `${ring}-${i}`, box);
  };
  await fetchRing("near", nearBoxes);
  await fetchRing("far", farBoxes);
  const items = new Map<string, WikidataItem>();
  for (const box of farBoxes) {
    const sparql = buildWikidataQuery(box, land.wikidataClasses, gazetteer.wikidata.languages, state.transportMinSitelinks);
    for (const item of await wikidataQuery(deps.transport, sparql, ctx, gazetteer.wikidata)) {
      if (!items.has(item.id)) items.set(item.id, item);
    }
  }

  const accepted: Accepted[] = [];
  const farCandidates: Array<{ draft: GeoObjectDraft; qid: string }> = [];
  for (const [osmId, el] of elements) {
    const tags = el.tags ?? {};
    const cls = classifyOsm(tags, categories, el.type);
    if (!cls) continue;
    // harbours come from the skeleton only: the next seed would turn one created here into a candidate
    if (cls.type !== "poi") {
      result.wrongType++;
      continue;
    }
    const geometry = elementGeometry(el);
    const point = elementPoint(el);
    if (!geometry || !point) {
      getLog().warn({ osmId }, "skipped land element without geometry");
      result.skippedGeometry++;
      continue;
    }
    const points = relationPoints(el);
    if (points > overpass.maxRelationPoints) {
      getLog().warn({ osmId, points }, "skipped osm relation above overpass.maxRelationPoints");
      result.skippedLarge++;
      continue;
    }
    const qid = tags.wikidata !== undefined && QID.test(tags.wikidata) ? tags.wikidata : undefined;
    const draft: GeoObjectDraft = { ...cls, origin: "osm", osmId, tags: keptTags(tags), geometry, names: osmNames(tags) };
    if (withinRing(point, centers, nearM)) {
      accepted.push({ ring: "near", draft, ...(qid ? { qid } : {}) });
    } else if (qid && cls.category && state.transportCategories.includes(cls.category) && withinRing(point, centers, farM)) {
      farCandidates.push({ draft, qid });
    } else {
      result.outsideRing++;
    }
  }
  const farItems: WikidataItem[] = [];
  for (const item of items.values()) {
    if (withinRing(item, centers, farM)) farItems.push(item);
    else result.outsideRing++;
  }

  // the sitelinks before the far filter, for every Wikidata id that may be stored
  const qids = [...accepted.flatMap((a) => (a.qid ? [a.qid] : [])), ...farCandidates.map((c) => c.qid), ...farItems.map((i) => i.id)];
  const { counts } = await ensureSitelinkCounts(db, qids, deps, ctx, input.now ?? new Date());
  const wellKnown = (qid: string) => (counts.get(qid) ?? 0) >= state.transportMinSitelinks;
  for (const c of farCandidates) {
    if (wellKnown(c.qid)) accepted.push({ ring: "far", ...c });
    else result.belowSitelinks++;
  }
  const wikidataItems: WikidataItem[] = [];
  for (const item of farItems) {
    if (wellKnown(item.id)) wikidataItems.push(item);
    else result.belowSitelinks++;
  }

  // the objects this call stored or linked; only they are assigned afterwards
  const ids = new Set<string>();
  await db.transaction(async (tx) => {
    for (const a of accepted) {
      const r = await upsertGeoObject(tx, a.draft);
      if ("skipped" in r) {
        getLog().warn({ osmId: a.draft.osmId, reason: r.skipped }, "skipped osm element with unusable geometry");
        result.skippedGeometry++;
        continue;
      }
      ids.add(r.id);
      result[a.ring]++;
      if (r.created) result.created++;
      if (a.qid) await linkByTag(tx, r.id, a.qid);
    }
    const classes = Object.fromEntries(land.wikidataClasses.map((c): [string, GeoObjectType] => [c, "poi"]));
    const wd = await importWikidataItems(tx, wikidataItems, { classes, categories: categories.wikidata, allowCreate: new Set<GeoObjectType>(["poi"]) });
    result.far += wikidataItems.length - wd.skipped;
    result.created += wd.created;
    result.skippedGeometry += wd.skipped;
    if (wikidataItems.length > 0) {
      const rows = await tx
        .select({ id: geoObjects.id })
        .from(geoObjects)
        .where(and(inArray(geoObjects.wikidataId, wikidataItems.map((i) => i.id)), isNull(geoObjects.validTo), isNull(geoObjects.mergedIntoId)));
      for (const row of rows) ids.add(row.id);
    }
  });

  // Subdivision, sea, parents, tile links (also in a neighbour's tiles) and fallback names of these objects only (N7 4.4).
  await db.transaction(async (tx) => {
    const stored = [...ids].sort();
    await assignObjects(tx, stored);
    await ensureFallbackNames(tx, stored);
  });
  return result;
}
