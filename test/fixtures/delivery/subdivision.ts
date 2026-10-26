import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import { geomFromGeoJson } from "@/lib/db/geometry";
import { berthStates, documents, geoNames, geoObjects, landPolygons, places, profileSummaries, restrictedAreas, subdivisions, tileGeoObjects, tiles } from "@/lib/db/schema";
import type { BerthStateFact, BerthStateLanding, BerthStateNearby, BerthStateValue } from "@/lib/db/schema/research-state";
import { factSchemaV4 } from "@/config/fact-schema/v4";
import type { PlaceKind, PlaceStatus } from "@/lib/db/schema/geo";
import type { AttributeProvenance } from "@/lib/domain/consolidation/types";
import { newId, newPublicId, type PublicIdPrefix } from "@/lib/domain/ids";
import { insertProfile, insertSource, insertTextFact, provenanceEntry } from "@/test/consolidation";
import { insertNamedObject, insertTestTile } from "@/test/text";

/*
 * A synthetic delivery subdivision around 21.0° E / 35.2° N (outside the pilot box), for `withRollback` only — never
 * commit these rows (M5 bundle F NOTE). Only test files in the vitest project `delivery-fixture` may seed it: they run
 * one after another, since two fixtures in parallel transactions wait on each other's unique keys (fixed tiles,
 * subdivision key, public ids). The subdivision's polygon is its two tiles (its run scope; the third tile east of them
 * only touches it): the west one holds an island (land polygon with a bay notch in its north coast), its archipelago
 * (child of the subdivision's admin region) and a cape; the east one a marina and an excluded place inside a military
 * area. Every delivered object carries the subdivision (`geo_objects.subdivision_id`). A sailing area (Revier, type
 * `area`, `ar_…`) is linked to both tiles (`tile_geo_objects`) and is listed in the manifest only.
 *
 *   A  anchorage in the bay: complete profile, one text source with document and an `ok` summary
 *   M  marina, shelter 0.9 in every sector
 *   B  anchorage without `shelter.W` (incomplete)
 *   C  `no_anchoring` inside the military area (`restricted:military:<id>`)
 *   K  candidate (not delivered); O a confirmed place of no subdivision in the third tile (not delivered)
 *   T  POI taverna (`derived.importance` 2) 1 nm south of A, on the island, selected by A and M (`highlight_selections`;
 *      M's profile also carries it as `derived.highlights`)
 *
 * Public ids are fixed (snapshot tests) unless `shift` is set; `shift` moves everything east (`lon`) and north (`lat`)
 * by that many degrees (multiples of 0.25 keep the two-tile layout) so a second subdivision (own `key`) fits into the same transaction.
 * `stable` also fixes what else reaches a package file (the build's snapshot test): the island's and the cape's geo
 * object ids (weather point ids), the land polygon's import date (`extractedAt`) and the URL of A's document.
 *
 * `committed` is for the one test that must commit the subdivision (the build's pool path, ruling M6-E-R2), shifted to
 * −150.1° / −50.1° (`COMMITTED_SHIFT`), never 21.0° / 35.2°: its tiles are taken over from an earlier run (tiles are
 * never deleted) and A's OSM id is unique; `endCommittedDeliverySubdivision` ends the rows afterwards.
 *
 * `seedE2eDeliverySubdivision` commits the same layout once for the e2e run (ruling M6-P29): key `XT-E2E-DELIVERY`,
 * shifted to −140.0…−139.5° E × −40.0…−39.75° N (`E2E_SHIFT`), away from every other test box; it stays between runs.
 */

const LAT_PER_NM = 1 / 60;

/** The shift of the committed fixture: the subdivision spans −150.25…−149.75° E × −50.25…−50.0° N around −150.1° / −50.1°. */
export const COMMITTED_SHIFT = { lon: -171.25, lat: -85.25 } as const;

/** The e2e subdivision (ruling M6-P29): its key and its shift, −140.0…−139.5° E × −40.0…−39.75° N. */
export const E2E_DELIVERY_KEY = "XT-E2E-DELIVERY";
export const E2E_SHIFT = { lon: -161, lat: -75 } as const;

/** A fixed public id: `<prefix>_01J9ZD` and 20 digits (valid Crockford base 32). */
const fixedId = (prefix: PublicIdPrefix, n: number) => `${prefix}_01J9ZD${String(n).padStart(20, "0")}`;

/** Fixed values of a `stable` fixture. */
export const STABLE = {
  islandId: "0199f0a0-0000-7000-8000-000000000001",
  capeId: "0199f0a0-0000-7000-8000-000000000002",
  landCreatedAt: new Date("2026-10-01T06:00:00Z"),
  documentUrl: "https://vathi.test.invalid/trip-report",
} as const;

export const SPOT_A_SHELTER = { N: 0.9, NE: 0.8, E: 0.4, SE: 0.1, S: 0.2, SW: 0.7, W: 0.9, NW: 0.95 };
export const SPOT_A_SUMMARY = "Tiefe Bucht mit gutem Schutz von West bis Nord, Sandgrund mit Seegras.";

/** The complete anchorage profile of A (fact schema v2 values, M5 identity and derived keys). */
export const SPOT_A_ATTRIBUTES: Record<string, unknown> = {
  "place.kind": "anchorage",
  "place.status": "confirmed",
  exclude: { excluded: false, reason: null, detail: null },
  ...Object.fromEntries(Object.entries(SPOT_A_SHELTER).map(([s, v]) => [`shelter.${s}`, v])),
  swell_protection: 0.5,
  "depth.min": 2,
  "depth.max": 14,
  "depth.anchoring_min": 4,
  "depth.anchoring_max": 8,
  seabed: [
    { type: "sand", share: 0.7 },
    { type: "weed", share: 0.3 },
  ],
  holding: "good",
  capacity: 8,
  "mooring.types": ["anchor", "lines_ashore"],
  "mooring.buoys": { present: false, count: null, paid: null },
  "mooring.line_ashore_required": false,
  "services.water": false,
  "services.dinghy_landing": true,
  "highlight.food": { present: true, names: ["Taverna Vathi"] },
  occupancy: { "7": "full", "8": "full", "9": "moderate" },
  hazards: [{ kind: "rock", name: "Petra" }],
  "derived.season": [{ kind: "open", months: [6, 7, 8, 9] }],
  "derived.quietness": 0.8,
};

/** Provenance of A: computed values, `shelter.N` text-corrected by `factId`, text values dated 2025-06-10. */
export function spotAProvenance(factId: string): Record<string, AttributeProvenance> {
  const text = (patch: Partial<AttributeProvenance> = {}) =>
    provenanceEntry("text", { confidence: 0.7, observedAt: "2025-06-10", factIds: [factId], sourceKeys: ["s1"], ...patch });
  const computed = (patch: Partial<AttributeProvenance> = {}) =>
    provenanceEntry("computed", { confidence: 0.8, observedAt: "2026-10-01", ...patch });
  const provenance: Record<string, AttributeProvenance> = {};
  for (const key of Object.keys(SPOT_A_ATTRIBUTES)) provenance[key] = computed();
  for (const key of ["place.kind", "place.status", "exclude"]) provenance[key] = provenanceEntry("gazetteer", { confidence: 1 });
  for (const key of ["derived.season", "derived.quietness"]) provenance[key] = provenanceEntry("derived", { confidence: 1 });
  for (const key of ["shelter.N", "holding", "mooring.types", "mooring.buoys", "services.water", "services.dinghy_landing", "highlight.food", "occupancy", "hazards"]) {
    provenance[key] = text();
  }
  provenance["anchor_position"] = computed({ confidence: 0.6 });
  return provenance;
}

/**
 * The core values of A's berth state (contract 4.0): A's profile attributes of fact schema v4 keys, each with the origin,
 * confidence and date of its provenance (`computed` or `text`), plus a season note and the derived `berthable`.
 */
export function spotACore(factId: string): Record<string, BerthStateValue> {
  const v4 = new Set(factSchemaV4.levels.place.map((d) => d.key));
  const provenance = spotAProvenance(factId);
  const values: Record<string, unknown> = { ...SPOT_A_ATTRIBUTES, season_notes: [{ kind: "open", months: [6, 7, 8, 9] }] };
  provenance["season_notes"] = provenanceEntry("computed", { confidence: 0.8, observedAt: "2026-10-01" });
  const core: Record<string, BerthStateValue> = {};
  for (const [key, value] of Object.entries(values)) {
    const p = provenance[key];
    if (!v4.has(key) || !p) continue;
    core[key] = { value, confidence: p.confidence, origin: p.origin === "text" ? "text" : "computed", observedAt: p.observedAt, factIds: p.origin === "text" ? [factId] : [] };
  }
  core["berthable"] = { value: true, confidence: 1, origin: "rule", observedAt: null, factIds: [] };
  return core;
}

/** A berth state row for the place (plan N4a); `updatedAt` defaults to now. */
export async function seedBerthState(
  tx: Db,
  placeId: string,
  o: { core: Record<string, BerthStateValue>; gaps?: string[]; facts?: BerthStateFact[]; landing?: BerthStateLanding[]; nearby?: BerthStateNearby[]; updatedAt?: Date },
): Promise<void> {
  await tx.insert(berthStates).values({
    placeId,
    core: o.core,
    gaps: o.gaps ?? [],
    facts: o.facts ?? [],
    landing: o.landing ?? [],
    nearby: o.nearby ?? [],
    ...(o.updatedAt ? { updatedAt: o.updatedAt } : {}),
  });
}

/** The core values of a place's berth state changed (as a research run rewriting it does): `patch` sets each key's value, `updatedAt` is the new state date. */
export async function changeBerthCore(tx: Db, placeId: string, patch: Record<string, unknown>, updatedAt: Date): Promise<void> {
  const [row] = await tx.select().from(berthStates).where(eq(berthStates.placeId, placeId));
  const core = { ...row!.core };
  for (const [key, value] of Object.entries(patch)) core[key] = { ...core[key]!, value };
  await tx.update(berthStates).set({ core, updatedAt }).where(eq(berthStates.placeId, placeId));
}

export type FixturePlace = { placeId: string; geoObjectId: string; publicId: string | null };

export type DeliveryFixture = {
  subdivisionId: string;
  subdivisionPublicId: string;
  subdivisionKey: string;
  /** The subdivision's admin region (`subdivisions.geo_object_id`), parent of the archipelago. */
  regionId: string;
  /** The sailing area linked to both tiles (manifest `areas`). */
  areaId: string;
  areaPublicId: string;
  tileIds: [string, string];
  outsideTileId: string;
  islandId: string;
  islandPublicId: string;
  archipelagoId: string;
  archipelagoPublicId: string;
  capeId: string;
  places: { A: FixturePlace; M: FixturePlace; B: FixturePlace; C: FixturePlace; K: FixturePlace; O: FixturePlace };
  poiId: string;
  poiPublicId: string;
  restrictedAreaId: string;
  sourceId: string;
  /** The text fact behind A's `shelter.N` and its document. */
  factId: string;
  documentId: string;
  documentUrl: string;
  /** Lon/lat of A, M and T (for distance checks). */
  positions: { A: [number, number]; M: [number, number]; T: [number, number] };
  /** `[west, south, east, north]` of the subdivision's tiles. */
  bbox: [number, number, number, number];
};

const square = (w: number, s: number, e: number, n: number): GeoJSON.Polygon => ({
  type: "Polygon",
  coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]],
});

type SeedOptions = { key?: string; shift?: { lon: number; lat: number }; stable?: boolean; committed?: boolean };

export async function seedDeliverySubdivision(tx: Db, opts: SeedOptions = {}): Promise<DeliveryFixture> {
  if (process.env.PERIPLUS_TEST_PROJECT !== "delivery-fixture") {
    throw new Error("seedDeliverySubdivision runs only in the vitest project delivery-fixture (add the file to DELIVERY_FIXTURE_TESTS)");
  }
  const shift = opts.shift ?? { lon: 0, lat: 0 };
  if (opts.committed && (shift.lon !== COMMITTED_SHIFT.lon || shift.lat !== COMMITTED_SHIFT.lat || !opts.key)) {
    throw new Error("a committed fixture lies at COMMITTED_SHIFT and has its own key");
  }
  return seedSubdivision(tx, opts);
}

/**
 * The e2e subdivision, committed by `e2e/global-setup.ts` once (it stays; the e2e run is a separate process, so the
 * vitest project guard of `seedDeliverySubdivision` does not apply). `tx` is the e2e setup's own transaction.
 */
export async function seedE2eDeliverySubdivision(tx: Db): Promise<DeliveryFixture> {
  return seedSubdivision(tx, { key: E2E_DELIVERY_KEY, shift: E2E_SHIFT, committed: true });
}

/**
 * Ends every valid row of the e2e subdivision's box (subdivision, geo objects, places, restricted areas, tile labels,
 * land polygons), for a test database whose package files were lost (e.g. a wiped S3 volume): the next setup seeds and
 * builds afresh.
 */
export async function endE2eDeliverySubdivision(db: Db): Promise<void> {
  // the three tiles of the layout, shrunk a little so the neighbouring tiles that only touch them stay untouched
  const inset = 0.001;
  const [w, s, e, n] = [21.0 + E2E_SHIFT.lon + inset, 35.0 + E2E_SHIFT.lat + inset, 21.75 + E2E_SHIFT.lon - inset, 35.25 + E2E_SHIFT.lat - inset];
  const box = sql`ST_MakeEnvelope(${w}, ${s}, ${e}, ${n}, 4326)`;
  const today = sql`current_date`;
  await db.execute(sql`
    update places set valid_to = ${today}
    where valid_to is null and geo_object_id in (select id from geo_objects where geom && ${box} and valid_to is null)`);
  await db.execute(sql`update subdivisions set valid_to = ${today} where valid_to is null and key = ${E2E_DELIVERY_KEY}`);
  await db.execute(sql`update geo_objects set valid_to = ${today} where valid_to is null and geom && ${box}`);
  await db.execute(sql`update restricted_areas set valid_to = ${today} where valid_to is null and geom && ${box}`);
  await db.execute(sql`update tiles set area_id = null, subdivision_id = null where bbox && ${box}`);
  await db.execute(sql`delete from land_polygons where geom && ${box}`);
}

async function seedSubdivision(tx: Db, opts: SeedOptions): Promise<DeliveryFixture> {
  const shift = opts.shift ?? { lon: 0, lat: 0 };
  const shifted = shift.lon !== 0 || shift.lat !== 0;
  if (opts.stable && shifted) throw new Error("a stable fixture has no shift");
  const stable = opts.stable === true;
  const x = (lon: number) => Number((lon + shift.lon).toFixed(6));
  const y = (lat: number) => Number((lat + shift.lat).toFixed(6));
  const id = (prefix: PublicIdPrefix, n: number) => (shifted ? newPublicId(prefix) : fixedId(prefix, n));
  const subdivisionKey = opts.key ?? "XT-DELIVERY";
  const col = (c: number) => c + shift.lon * 4;
  const row = 500 + shift.lat * 4;
  const tile = async (tileId: string, subdivisionId: string | null) => {
    // a committed fixture takes over the tiles of an earlier run (ended rows, tiles are never deleted)
    if (opts.committed) await tx.update(tiles).set({ areaId: null, subdivisionId }).where(eq(tiles.id, tileId));
    return insertTestTile(tx, tileId, null, subdivisionId);
  };

  // Subdivision polygon (and land) = the two tiles; its admin region carries the names.
  const polygon = geomFromGeoJson({ type: "MultiPolygon", coordinates: [square(x(21.0), y(35.0), x(21.5), y(35.25)).coordinates] });
  const [region] = await tx
    .insert(geoObjects)
    .values({ type: "admin_region", origin: "manual", adminLevel: 4, tags: { country: "GR" }, geom: polygon })
    .returning({ id: geoObjects.id });
  const regionId = region!.id;
  await tx.insert(geoNames).values([
    { geoObjectId: regionId, name: "Testlandesteil", nameNormalized: "testlandesteil", language: "de", script: "latin", origin: "manual" },
    { geoObjectId: regionId, name: "Test Subdivision", nameNormalized: "test subdivision", language: "en", script: "latin", origin: "manual" },
  ]);
  const subdivisionPublicId = id("sd", 1);
  const [subdivision] = await tx
    .insert(subdivisions)
    .values({ publicId: subdivisionPublicId, key: subdivisionKey, country: "GR", geoObjectId: regionId, geom: polygon, landGeom: polygon })
    .returning({ id: subdivisions.id });
  const subdivisionId = subdivision!.id;
  const west = await tile(`q025:${col(804)}:${row}`, subdivisionId);
  const east = await tile(`q025:${col(805)}:${row}`, subdivisionId);
  const outsideTileId = await tile(`q025:${col(806)}:${row}`, null);

  // The sailing area over both tiles: no parent, no subdivision, only linked to the tiles.
  const areaPublicId = id("ar", 1);
  const [area] = await tx
    .insert(geoObjects)
    .values({
      type: "area",
      origin: "manual",
      geom: geomFromGeoJson(square(x(21.0), y(35.0), x(21.5), y(35.25))),
      publicId: areaPublicId,
      configKey: `${subdivisionKey.toLowerCase()}-waters`,
    })
    .returning({ id: geoObjects.id });
  const areaId = area!.id;
  await tx.insert(geoNames).values([
    { geoObjectId: areaId, name: "Testrevier", nameNormalized: "testrevier", language: "de", script: "latin", origin: "manual" },
    { geoObjectId: areaId, name: "Test Waters", nameNormalized: "test waters", language: "en", script: "latin", origin: "manual" },
  ]);
  await tx.insert(tileGeoObjects).values([
    { tileId: west, geoObjectId: areaId },
    { tileId: east, geoObjectId: areaId },
  ]);

  // Island with a bay notch in its north coast (21.12–21.14, down to 35.13).
  const island: GeoJSON.Polygon = {
    type: "Polygon",
    coordinates: [
      [
        [x(21.05), y(35.05)],
        [x(21.2), y(35.05)],
        [x(21.2), y(35.15)],
        [x(21.14), y(35.15)],
        [x(21.13), y(35.13)],
        [x(21.12), y(35.15)],
        [x(21.05), y(35.15)],
        [x(21.05), y(35.05)],
      ],
    ],
  };
  await tx
    .insert(landPolygons)
    .values({ geom: geomFromGeoJson(island), datasetVersion: "test", ...(stable ? { createdAt: STABLE.landCreatedAt } : {}) });

  const archipelagoPublicId = id("rg", 2);
  const archipelagoId = await insertNamedObject(tx, { type: "archipelago", names: [{ name: "Test Islands" }], lon: x(21.15), lat: y(35.1), tiles: [west], parentId: regionId, subdivisionId });
  await tx.update(geoObjects).set({ publicId: archipelagoPublicId }).where(sql`${geoObjects.id} = ${archipelagoId}`);

  const islandPublicId = id("rg", 1);
  const [islandRow] = await tx
    .insert(geoObjects)
    .values({
      ...(stable ? { id: STABLE.islandId } : {}),
      type: "island",
      origin: "osm",
      geom: geomFromGeoJson(island),
      publicId: islandPublicId,
      parentId: archipelagoId,
      subdivisionId,
      osmId: null,
    })
    .returning({ id: geoObjects.id });
  const islandId = islandRow!.id;
  await tx.insert(geoNames).values({ geoObjectId: islandId, name: "Nisida", nameNormalized: "nisida", language: "en", script: "latin", origin: "osm" });
  await tx.insert(tileGeoObjects).values({ tileId: west, geoObjectId: islandId });
  await insertProfile(
    tx,
    islandId,
    { meltemi_exposure: 0.7, ferry_traffic: "high", charter_bases: ["X"] },
    {
      meltemi_exposure: provenanceEntry("text", { confidence: 0.6 }),
      ferry_traffic: provenanceEntry("text", { confidence: 0.6 }),
      charter_bases: provenanceEntry("text", { confidence: 0.6 }),
    },
    { confidence: null },
  );

  const capeId = await insertNamedObject(tx, {
    ...(stable ? { id: STABLE.capeId } : {}),
    type: "cape",
    names: [{ name: "Akra Test" }],
    lon: x(21.2),
    lat: y(35.15),
    tiles: [west],
    subdivisionId,
  });

  const [restricted] = await tx
    .insert(restrictedAreas)
    .values({ kind: "military", geom: geomFromGeoJson(square(x(21.38), y(35.18), x(21.42), y(35.22))), sourceRef: "test" })
    .returning({ id: restrictedAreas.id });
  const restrictedAreaId = restricted!.id;

  const place = async (o: {
    lon: number;
    lat: number;
    name: string;
    names?: Array<{ name: string; language: string }>;
    type?: "bay" | "harbour";
    kind?: PlaceKind;
    status?: PlaceStatus;
    statusReason?: string;
    publicId: string | null;
    tile: string;
    /** Default the fixture's subdivision. */
    subdivisionId?: string | null;
  }): Promise<FixturePlace> => {
    const geoObjectId = await insertNamedObject(tx, {
      type: o.type ?? "bay",
      names: o.names ?? [{ name: o.name }],
      lon: o.lon,
      lat: o.lat,
      tiles: [o.tile],
      subdivisionId: o.subdivisionId === undefined ? subdivisionId : o.subdivisionId,
    });
    const [p] = await tx
      .insert(places)
      .values({
        geoObjectId,
        kind: o.kind ?? "anchorage",
        status: o.status ?? "confirmed",
        statusReason: o.statusReason ?? null,
        publicId: o.publicId,
        position: geomFromGeoJson({ type: "Point", coordinates: [o.lon, o.lat] }),
      })
      .returning({ id: places.id });
    return { placeId: p!.id, geoObjectId, publicId: o.publicId };
  };

  const posA: [number, number] = [x(21.13), y(35.145)];
  const A = await place({
    lon: posA[0],
    lat: posA[1],
    name: "Vathi Bay",
    names: [
      { name: "Vathi Bay", language: "en" },
      { name: "Όρμος Βαθύ", language: "el" },
    ],
    publicId: id("sp", 1),
    tile: west,
  });
  // A German fallback name (never delivered); the Greek name above also wrote a transliteration.
  await tx.insert(geoNames).values({ geoObjectId: A.geoObjectId, name: "Vathi Bay", nameNormalized: "vathi bay", language: "de", script: "latin", origin: "fallback" });
  const osmId = opts.committed ? `way/${Number.parseInt(newId().replace(/-/g, "").slice(-12), 16)}` : `way/${123456789 + (shift.lon + shift.lat * 7) * 1000}`;
  await tx.update(geoObjects).set({ osmId }).where(sql`${geoObjects.id} = ${A.geoObjectId}`);

  const sourceId = await insertSource(tx, "trip_report", 0.6);
  const factId = await insertTextFact(tx, A.geoObjectId, sourceId, { attribute: "shelter.N", value: 0.9, observedAt: "2025-06-10" });
  const [doc] = (
    await tx.execute<{ document_id: string; url: string }>(sql`
      select d.id as document_id, d.url from facts f
      join mentions m on m.id = f.mention_id join document_versions v on v.id = m.document_version_id
      join documents d on d.id = v.document_id where f.id = ${factId}`)
  ).rows;
  if (stable) {
    await tx.update(documents).set({ url: STABLE.documentUrl, urlNormalized: STABLE.documentUrl }).where(eq(documents.id, doc!.document_id));
    doc!.url = STABLE.documentUrl;
  }
  const posAnchor = { lon: x(21.1301), lat: y(35.1445) };
  await insertProfile(
    tx,
    A.geoObjectId,
    { ...SPOT_A_ATTRIBUTES, anchor_position: posAnchor, "place.position": { lon: posA[0], lat: posA[1] } },
    { ...spotAProvenance(factId), "place.position": provenanceEntry("gazetteer", { confidence: 1 }) },
    { sourcesCount: 3, documentsCount: 1, confidence: 0.72 },
  );
  await tx.insert(profileSummaries).values({ geoObjectId: A.geoObjectId, profileVersion: 1, text: SPOT_A_SUMMARY, status: "ok", attempts: 1, model: "test", promptVersion: 1 });

  const posT: [number, number] = [posA[0], Number((posA[1] - LAT_PER_NM).toFixed(6))];
  const poiPublicId = id("hl", 1);
  const poiId = await insertNamedObject(tx, { type: "poi", names: [{ name: "Taverna Vathi" }], lon: posT[0], lat: posT[1], category: "food", tiles: [west], subdivisionId });
  await tx.update(geoObjects).set({ publicId: poiPublicId }).where(sql`${geoObjects.id} = ${poiId}`);
  await insertProfile(tx, poiId, { "derived.importance": 2 }, { "derived.importance": provenanceEntry("derived", { confidence: 1 }) }, { confidence: null });

  const posM: [number, number] = [x(21.3), y(35.1)];
  const M = await place({ lon: posM[0], lat: posM[1], name: "Marina Test", type: "harbour", kind: "marina", publicId: id("sp", 2), tile: east });
  const sectors = (value: number, omit: string[] = []) =>
    Object.fromEntries(Object.keys(SPOT_A_SHELTER).filter((s) => !omit.includes(s)).map((s) => [`shelter.${s}`, value]));
  const computedProvenance = (keys: string[]) => Object.fromEntries(keys.map((k) => [k, provenanceEntry("computed")]));
  const marina = {
    "place.kind": "marina",
    "place.status": "confirmed",
    exclude: { excluded: false, reason: null, detail: null },
    ...sectors(0.9),
    occupancy: { "7": "full", "8": "full" },
    "derived.highlights": { food: { ids: [poiId], level: "some" } },
  };
  await insertProfile(tx, M.geoObjectId, marina, computedProvenance(Object.keys(marina)), { sourcesCount: 1, confidence: 0.6 });

  const B = await place({ lon: x(21.08), lat: y(35.16), name: "Ormos B", publicId: id("sp", 3), tile: west });
  const anchorageB = { "place.kind": "anchorage", "place.status": "confirmed", exclude: { excluded: false, reason: null, detail: null }, ...sectors(0.6, ["W"]) };
  await insertProfile(tx, B.geoObjectId, anchorageB, computedProvenance(Object.keys(anchorageB)), { confidence: 0.5 });

  const C = await place({
    lon: x(21.4),
    lat: y(35.2),
    name: "Ormos C",
    status: "no_anchoring",
    statusReason: `restricted:military:${restrictedAreaId}`,
    publicId: id("sp", 4),
    tile: east,
  });
  const excludedC = { "place.kind": "anchorage", "place.status": "no_anchoring", exclude: { excluded: true, reason: "military", detail: null }, ...sectors(0.5) };
  await insertProfile(tx, C.geoObjectId, excludedC, computedProvenance(Object.keys(excludedC)), { confidence: 0.4 });

  // Berth states (contract 4.0): A complete with facts, a landing point and the taverna nearby; M with shelter only;
  // B without `shelter.W`; C (no_anchoring) and K have none.
  await tx.execute(sql`update places set anchor_position = ST_SetSRID(ST_MakePoint(${posAnchor.lon}, ${posAnchor.lat}), 4326) where id = ${A.placeId}`);
  // fixed fact ids: they reach the package files (`fc_…`), so a snapshot test needs them stable
  let factNo = 0;
  const stateFact = (patch: Partial<BerthStateFact>): BerthStateFact => ({
    factId: `0199f0a0-0000-7000-8000-00000000f${String(++factNo).padStart(3, "0")}`, subject: "berth", subjectName: null, subjectCategory: null, statement: "x", observedAt: "2025-06-10", tone: null, safety: false, mentions: 1, ...patch,
  });
  await seedBerthState(tx, A.placeId, {
    core: spotACore(factId),
    gaps: ["prices", "contact"],
    facts: [
      stateFact({ statement: "Strong gusts come down the valley in the afternoon.", tone: "negative", safety: true, mentions: 2 }),
      stateFact({ statement: "The taverna on the beach serves fresh fish.", subject: "landside", subjectName: "Taverna Vathi", subjectCategory: "food", tone: "positive" }),
    ],
    landing: [{ kind: "beach", lon: x(21.1305), lat: y(35.1452), geoObjectId: null, description: null }],
    nearby: [{ geoObjectId: poiId, category: "food", distanceM: 1852, access: "foot" }],
    updatedAt: new Date("2026-10-20T08:00:00Z"),
  });
  const coreOf = (values: Record<string, unknown>): Record<string, BerthStateValue> =>
    Object.fromEntries(Object.entries(values).map(([k, value]) => [k, { value, confidence: 0.8, origin: "computed" as const, observedAt: null, factIds: [] }]));
  await seedBerthState(tx, M.placeId, { core: coreOf({ ...sectors(0.9), occupancy: { "7": "full", "8": "full" } }), updatedAt: new Date("2026-10-19T08:00:00Z") });
  await seedBerthState(tx, B.placeId, { core: coreOf(sectors(0.6, ["W"])), gaps: ["shelter.W"], updatedAt: new Date("2026-10-18T08:00:00Z") });

  // A and M select the taverna (spec 16; M's profile carries the selection, A's fixed attributes do not)
  await tx.execute(sql`
    insert into highlight_selections (place_geo_object_id, poi_geo_object_id, category, rank, distance_km, profile_version)
    select p.id, t.id, 'food', 1, ST_Distance(p.centroid::geography, t.centroid::geography) / 1000, 1
    from geo_objects p, geo_objects t
    where p.id in (${A.geoObjectId}, ${M.geoObjectId}) and t.id = ${poiId}`);

  const K = await place({ lon: x(21.22), lat: y(35.2), name: "Kandidat", status: "candidate", publicId: null, tile: west });
  const O = await place({ lon: x(21.6), lat: y(35.1), name: "Elsewhere", publicId: id("sp", 5), tile: outsideTileId, subdivisionId: null });


  return {
    subdivisionId,
    subdivisionPublicId,
    subdivisionKey,
    regionId,
    areaId,
    areaPublicId,
    tileIds: [west, east],
    outsideTileId,
    islandId,
    islandPublicId,
    archipelagoId,
    archipelagoPublicId,
    capeId,
    places: { A, M, B, C, K, O },
    poiId,
    poiPublicId,
    restrictedAreaId,
    sourceId,
    factId,
    documentId: doc!.document_id,
    documentUrl: doc!.url,
    positions: { A: posA, M: posM, T: posT },
    bbox: [x(21.0), y(35.0), x(21.5), y(35.25)],
  };
}

/**
 * Ends what a committed fixture wrote that subdivision, tile, place and review queries could meet: the subdivision,
 * geo objects and places end today (never deleted), its tiles belong to no subdivision again, its restricted area
 * ends and the land polygons in its box are deleted. Append-only rows (profiles, deliveries) stay, attached to ended
 * objects.
 */
export async function endCommittedDeliverySubdivision(db: Db, f: DeliveryFixture): Promise<void> {
  const objectIds = [f.regionId, f.areaId, f.islandId, f.archipelagoId, f.capeId, f.poiId, ...Object.values(f.places).map((p) => p.geoObjectId)];
  const [w, s, e, n] = f.bbox;
  const today = sql`current_date`;
  await db.update(places).set({ validTo: today }).where(and(inArray(places.geoObjectId, objectIds), isNull(places.validTo)));
  await db.update(geoObjects).set({ validTo: today }).where(and(inArray(geoObjects.id, objectIds), isNull(geoObjects.validTo)));
  await db.update(restrictedAreas).set({ validTo: today }).where(and(eq(restrictedAreas.id, f.restrictedAreaId), isNull(restrictedAreas.validTo)));
  await db.update(subdivisions).set({ validTo: today }).where(and(eq(subdivisions.id, f.subdivisionId), isNull(subdivisions.validTo)));
  await db.update(tiles).set({ subdivisionId: null }).where(eq(tiles.subdivisionId, f.subdivisionId));
  await db.execute(sql`delete from land_polygons where geom && ST_MakeEnvelope(${w}, ${s}, ${e}, ${n}, 4326)`);
}
