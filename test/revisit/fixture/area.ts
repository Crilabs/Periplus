import { readFileSync } from "node:fs";
import { join } from "node:path";
import { eq, sql } from "drizzle-orm";
import type { Archive } from "@/lib/adapters/s3";
import type { Db } from "@/lib/db/client";
import { geomFromGeoJson } from "@/lib/db/geometry";
import { crawlFrontier, geoNames, geoObjects, landPolygons, places, sources, subdivisions, tileGeoObjects, tiles, type DocType, type GeoObjectType } from "@/lib/db/schema";
import type { PlaceKind } from "@/lib/db/schema/geo";
import { ensureDocument, storeFetched } from "@/lib/domain/documents/store";
import { chunkStoredVersion } from "@/lib/pipeline/fetch/legacy-chunks";
import { recordComputation } from "@/lib/domain/facts/computations";
import { addNames } from "@/lib/domain/gazetteer/names";
import { tileBbox } from "@/lib/domain/tiles";
import { insertTestSubdivision } from "@/test/text";

/*
 * The fixture area of the revisit integration test (plan Task 14, spec 10 „kleines Fixture-Revier (eine Kachel, 3 Orte,
 * 5 Dokumente)“), for `withRollback` only — never commit these rows. Synthetic, around 21.6° E / 35.85° N (outside the
 * pilot box; the tile north of 21.5/35.6, whose tile another test file uses): one subdivision (key
 * `REVISIT_SUBDIVISION_KEY`, the unit the revisit runs on; the geo objects below belong to it), one area (fixed `ar_`,
 * which the delivery still builds from until plan 14a task 10), one coast tile,
 * an island „Revisonisi“ (land polygon with a bay notch in its south coast, fixed `rg_`), three confirmed places with
 * fixed `sp_` ids, each with eight computed shelter facts and a computed depth:
 *
 *   A  „Alonaki“    anchorage in the bay notch, depth computed with confidence 0.8 (the raster holds)
 *   B  „Vromolimni“ anchorage, depth computed with confidence 0.3 (a weak raster: a text depth applies, rule bathymetry)
 *   M  „Limenaki“   marina (harbour)
 *
 * Four approved sources on their own `*.invalid` hosts (a host is its source's registrable domain, so the crawl rules
 * allow its pages): S1 `pilot_guide` 0.9, S2 `authority` 0.9, S3 `trip_report` 0.6, S4 `forum` 0.4; five documents,
 * their first versions stored with `storeFetched` from `documents/d1.md` … `d5.md`, fetched 2026-05-01, each a
 * frontier row `fetched`:
 *
 *   d1 S1 → A: taverna open        d2 S1 → B: anchoring depth 4 m      d3 S3 → A: trip report, depth 5 m
 *   d4 S2 → M: swimming prohibited  d5 S4 → B: buoys laid
 *
 * Every row is valid from 2000-01-01, so the runs can be dated 2026-05-01 … 2026-06-08 (the run date decides validity).
 */

const DIR = join(process.cwd(), "test/revisit/fixture/documents");

export const REVISIT_AREA_KEY = "revisit-test";
export const REVISIT_SUBDIVISION_KEY = "XT-revisit-test";
export const REVISIT_TILE = "q025:806:503";
const VALID_FROM = "2000-01-01";
export const FIRST_FETCH = new Date("2026-05-01T06:00:00Z");

/** A fixed public id: `<prefix>_01JREV` and 20 digits (valid Crockford base 32). */
const fixedId = (prefix: "sp" | "rg" | "ar", n: number) => `${prefix}_01JREV${String(n).padStart(20, "0")}`;

export const REVISIT_PUBLIC_IDS = { area: fixedId("ar", 1), island: fixedId("rg", 1), A: fixedId("sp", 1), B: fixedId("sp", 2), M: fixedId("sp", 3) } as const;

/** The sources of the fixture: host (= registrable domain), type and weight. */
export const REVISIT_SOURCES = {
  S1: { host: "revisit-guide.invalid", type: "pilot_guide", weight: 0.9 },
  S2: { host: "revisit-authority.invalid", type: "authority", weight: 0.9 },
  S3: { host: "revisit-trips.invalid", type: "trip_report", weight: 0.6 },
  S4: { host: "revisit-forum.invalid", type: "forum", weight: 0.4 },
} as const satisfies Record<string, { host: string; type: DocType; weight: number }>;

export type SourceKey = keyof typeof REVISIT_SOURCES;

/** The documents: source and path; the URL is `https://<host><path>`. */
export const REVISIT_DOCUMENTS = {
  d1: { source: "S1", path: "/alonaki" },
  d2: { source: "S1", path: "/vromolimni" },
  d3: { source: "S3", path: "/2026/revisonisi" },
  d4: { source: "S2", path: "/notices/limenaki" },
  d5: { source: "S4", path: "/t/vromolimni" },
} as const satisfies Record<string, { source: SourceKey; path: string }>;

export type DocumentKey = keyof typeof REVISIT_DOCUMENTS;

export const documentUrl = (d: DocumentKey) => `https://${REVISIT_SOURCES[REVISIT_DOCUMENTS[d].source].host}${REVISIT_DOCUMENTS[d].path}`;

export type RevisitFixture = {
  subdivisionKey: string;
  subdivisionId: string;
  areaKey: string;
  areaId: string;
  tileId: string;
  islandId: string;
  places: Record<"A" | "B" | "M", { placeId: string; geoObjectId: string; publicId: string }>;
  publicIds: typeof REVISIT_PUBLIC_IDS;
  sourceIds: Record<SourceKey, string>;
  documents: Record<DocumentKey, { id: string; url: string; versionId: string }>;
};

const square = (w: number, s: number, e: number, n: number): GeoJSON.Polygon => ({
  type: "Polygon",
  coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]],
});

/** The eight computed shelter values of a place. */
const SHELTER = { N: 0.9, NE: 0.9, E: 0.8, SE: 0.4, S: 0.2, SW: 0.3, W: 0.7, NW: 0.9 };

async function geoObject(
  tx: Db,
  o: { type: GeoObjectType; geom: GeoJSON.Geometry; names: string[]; publicId?: string; configKey?: string; parentId?: string; tiles?: string[]; subdivisionId?: string },
): Promise<string> {
  const [row] = await tx
    .insert(geoObjects)
    .values({
      type: o.type,
      origin: o.type === "area" ? "manual" : "osm",
      geom: geomFromGeoJson(o.geom),
      publicId: o.publicId ?? null,
      configKey: o.configKey ?? null,
      parentId: o.parentId ?? null,
      subdivisionId: o.subdivisionId ?? null,
      validFrom: VALID_FROM,
    })
    .returning({ id: geoObjects.id });
  await addNames(
    tx,
    row!.id,
    o.names.map((name) => ({ name, language: "en", origin: o.type === "area" ? ("manual" as const) : ("osm" as const) })),
  );
  // names valid as long as the object (the runs are dated 2026; a name valid only from today would be missing then)
  await tx.update(geoNames).set({ validFrom: VALID_FROM }).where(eq(geoNames.geoObjectId, row!.id));
  if (o.tiles?.length) await tx.insert(tileGeoObjects).values(o.tiles.map((tileId) => ({ tileId, geoObjectId: row!.id })));
  return row!.id;
}

/** Seeds the fixture area; the first versions' Markdown goes to `archive` (the test's memory archive). */
export async function seedRevisitArea(tx: Db, archive: Archive): Promise<RevisitFixture> {
  const [w, s, e, n] = tileBbox(REVISIT_TILE);
  const { id: subdivisionId, geoObjectId: regionId } = await insertTestSubdivision(tx, REVISIT_SUBDIVISION_KEY, [w - 0.05, s - 0.05, e + 0.05, n + 0.05]);
  // valid, with its name, as long as the other rows (the runs and builds are dated 2026)
  await tx.update(subdivisions).set({ validFrom: VALID_FROM }).where(eq(subdivisions.id, subdivisionId));
  await tx.update(geoObjects).set({ validFrom: VALID_FROM }).where(eq(geoObjects.id, regionId));
  await addNames(tx, regionId, [{ name: "Revisionsland", language: "de", origin: "manual" }]);
  await tx.update(geoNames).set({ validFrom: VALID_FROM }).where(eq(geoNames.geoObjectId, regionId));
  await tx.insert(tiles).values({ id: REVISIT_TILE, bbox: sql`ST_MakeEnvelope(${w}, ${s}, ${e}, ${n}, 4326)`, subdivisionId, hasCoast: true, validFrom: VALID_FROM });
  // the sailing area over the tile: linked to it, listed in the manifest, parent of nothing
  const areaId = await geoObject(tx, {
    type: "area",
    geom: square(w, s, e, n),
    names: ["Revisionsrevier"],
    publicId: REVISIT_PUBLIC_IDS.area,
    configKey: REVISIT_AREA_KEY,
    tiles: [REVISIT_TILE],
  });

  // The island fills the middle of the tile; the bay of A cuts into its south coast.
  const island: GeoJSON.Polygon = {
    type: "Polygon",
    coordinates: [
      [
        [21.55, 35.8],
        [21.6, 35.8],
        [21.61, 35.82],
        [21.62, 35.8],
        [21.7, 35.8],
        [21.7, 35.95],
        [21.55, 35.95],
        [21.55, 35.8],
      ],
    ],
  };
  await tx.insert(landPolygons).values({ geom: geomFromGeoJson(island), datasetVersion: "test" });
  const islandId = await geoObject(tx, { type: "island", geom: island, names: ["Revisonisi"], publicId: REVISIT_PUBLIC_IDS.island, parentId: regionId, tiles: [REVISIT_TILE], subdivisionId });

  const place = async (key: "A" | "B" | "M", o: { name: string; type: GeoObjectType; kind: PlaceKind; lon: number; lat: number; depthConfidence: number; depth: number }) => {
    const point: GeoJSON.Point = { type: "Point", coordinates: [o.lon, o.lat] };
    const geoObjectId = await geoObject(tx, { type: o.type, geom: point, names: [o.name], parentId: islandId, tiles: [REVISIT_TILE], subdivisionId });
    const publicId = REVISIT_PUBLIC_IDS[key];
    const [p] = await tx
      .insert(places)
      .values({ geoObjectId, kind: o.kind, status: "confirmed", publicId, position: geomFromGeoJson(point), validFrom: VALID_FROM })
      .returning({ id: places.id });
    const observedAt = "2026-04-01";
    await recordComputation(tx, {
      geoObjectId,
      kind: "shelter",
      inputs: { fixture: "revisit", place: key },
      rulesVersion: "test",
      observedAt,
      facts: Object.entries(SHELTER).map(([sector, value]) => ({ attribute: `shelter.${sector}`, value, confidence: 0.8 })),
    });
    await recordComputation(tx, {
      geoObjectId,
      kind: "depth",
      inputs: { fixture: "revisit", place: key },
      rulesVersion: "test",
      observedAt,
      facts: [{ attribute: "depth.min", value: o.depth, confidence: o.depthConfidence }],
    });
    return { placeId: p!.id, geoObjectId, publicId };
  };
  const A = await place("A", { name: "Alonaki", type: "bay", kind: "anchorage", lon: 21.61, lat: 35.805, depthConfidence: 0.8, depth: 5 });
  const B = await place("B", { name: "Vromolimni", type: "bay", kind: "anchorage", lon: 21.545, lat: 35.88, depthConfidence: 0.3, depth: 6 });
  const M = await place("M", { name: "Limenaki", type: "harbour", kind: "marina", lon: 21.705, lat: 35.9, depthConfidence: 0.8, depth: 3 });

  const sourceIds = {} as Record<SourceKey, string>;
  for (const [key, src] of Object.entries(REVISIT_SOURCES) as Array<[SourceKey, (typeof REVISIT_SOURCES)[SourceKey]]>) {
    const startUrls = Object.keys(REVISIT_DOCUMENTS)
      .filter((d) => REVISIT_DOCUMENTS[d as DocumentKey].source === key)
      .map((d) => documentUrl(d as DocumentKey));
    const [row] = await tx
      .insert(sources)
      .values({ domain: src.host, name: `Revisit ${key}`, type: src.type, weight: src.weight, status: "approved", crawlRules: { render: "never", startUrls }, origin: "manual" })
      .returning({ id: sources.id });
    sourceIds[key] = row!.id;
  }

  const docs = {} as RevisitFixture["documents"];
  for (const d of Object.keys(REVISIT_DOCUMENTS) as DocumentKey[]) {
    const { source, path } = REVISIT_DOCUMENTS[d];
    const markdown = readFileSync(join(DIR, `${d}.md`), "utf8");
    docs[d] = await addRevisitDocument(tx, archive, sourceIds, { source, path, markdown, language: d === "d4" ? "en" : "de" });
  }

  return {
    subdivisionKey: REVISIT_SUBDIVISION_KEY,
    subdivisionId,
    areaKey: REVISIT_AREA_KEY,
    areaId,
    tileId: REVISIT_TILE,
    islandId,
    places: { A, B, M },
    publicIds: REVISIT_PUBLIC_IDS,
    sourceIds,
    documents: docs,
  };
}

/**
 * Stores one recorded page of the fixture: document, frontier row `fetched` and its first version (fetched
 * `FIRST_FETCH`) from `markdown`. Also for a test that needs a page beyond d1 … d5 (before „Lauf 1“).
 */
export async function addRevisitDocument(
  tx: Db,
  archive: Archive,
  sourceIds: Record<SourceKey, string>,
  page: { source: SourceKey; path: string; markdown: string; language: string },
): Promise<{ id: string; url: string; versionId: string }> {
  const url = `https://${REVISIT_SOURCES[page.source].host}${page.path}`;
  const docType = REVISIT_SOURCES[page.source].type;
  const doc = await ensureDocument(tx, { sourceId: sourceIds[page.source], url, urlNormalized: url, docType });
  await tx.insert(crawlFrontier).values({ sourceId: sourceIds[page.source], url, urlNormalized: url, status: "fetched" });
  const stored = await storeFetched(
    tx,
    archive,
    doc.id,
    {
      fetchedAt: FIRST_FETCH,
      raw: new TextEncoder().encode(page.markdown),
      rawExt: "md",
      contentType: "text/markdown",
      finalUrl: null,
      markdown: page.markdown,
      converter: "local",
      language: page.language,
      publishedAt: null,
      docType,
      etag: null,
      lastModified: null,
    },
  );
  // the old text stages read chunks; `storeFetched` writes none (N6)
  await chunkStoredVersion(tx, archive, stored.versionId);
  return { id: doc.id, url, versionId: stored.versionId };
}
