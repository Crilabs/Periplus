import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import { geomFromGeoJson } from "@/lib/db/geometry";
import { documents, geoNames, geoObjects, landPolygons, places, profileSummaries, restrictedAreas, tileGeoObjects, tiles } from "@/lib/db/schema";
import type { PlaceKind, PlaceStatus } from "@/lib/db/schema/geo";
import type { AttributeProvenance } from "@/lib/domain/consolidation/types";
import { newId, newPublicId, type PublicIdPrefix } from "@/lib/domain/ids";
import { insertProfile, insertSource, insertTextFact, provenanceEntry } from "@/test/consolidation";
import { insertNamedObject, insertTestTile } from "@/test/text";

/*
 * A synthetic delivery area around 21.0° E / 35.2° N (outside the pilot box), for `withRollback` only — never commit
 * these rows (M5 bundle F NOTE). Two tiles: the west one holds an island (land polygon with a bay notch in its north
 * coast), its archipelago and a cape; the east one a marina and an excluded place inside a military area.
 *
 *   A  anchorage in the bay: complete profile, one text source with document and an `ok` summary
 *   M  marina, shelter 0.9 in every sector
 *   B  anchorage without `shelter.W` (incomplete)
 *   C  `no_anchoring` inside the military area (`restricted:military:<id>`)
 *   K  candidate (not delivered); O a confirmed place in a tile of no area (not delivered)
 *   T  POI taverna (`derived.importance` 2) 1 nm south of A, on the island
 *
 * Public ids are fixed (snapshot tests) unless `shift` is set; `shift` moves everything east (`lon`) and north (`lat`)
 * by that many degrees (multiples of 0.25 keep the two-tile layout) so a second area fits into the same transaction.
 * `stable` also fixes what else reaches a package file (the build's snapshot test): the island's and the cape's geo
 * object ids (weather point ids), the land polygon's import date (`extractedAt`) and the URL of A's document.
 *
 * `committed` is for the one test that must commit the area (the build's pool path, ruling M6-E-R2), shifted to
 * −150.1° / −50.1° (`COMMITTED_SHIFT`), never 21.0° / 35.2°: its tiles are taken over from an earlier run (tiles are
 * never deleted) and A's OSM id is unique; `endCommittedDeliveryArea` ends the rows afterwards.
 */

const LAT_PER_NM = 1 / 60;

/** The shift of the committed fixture: the area spans −150.25…−149.75° E × −50.25…−50.0° N around −150.1° / −50.1°. */
export const COMMITTED_SHIFT = { lon: -171.25, lat: -85.25 } as const;

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

export type FixturePlace = { placeId: string; geoObjectId: string; publicId: string | null };

export type DeliveryFixture = {
  areaId: string;
  areaPublicId: string;
  areaKey: string;
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
  /** `[west, south, east, north]` of the area's tiles. */
  bbox: [number, number, number, number];
};

const square = (w: number, s: number, e: number, n: number): GeoJSON.Polygon => ({
  type: "Polygon",
  coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]],
});

export async function seedDeliveryArea(
  tx: Db,
  opts: { key?: string; shift?: { lon: number; lat: number }; stable?: boolean; committed?: boolean } = {},
): Promise<DeliveryFixture> {
  const shift = opts.shift ?? { lon: 0, lat: 0 };
  const shifted = shift.lon !== 0 || shift.lat !== 0;
  if (opts.stable && shifted) throw new Error("a stable fixture has no shift");
  if (opts.committed && (shift.lon !== COMMITTED_SHIFT.lon || shift.lat !== COMMITTED_SHIFT.lat || !opts.key)) {
    throw new Error("a committed fixture lies at COMMITTED_SHIFT and has its own key");
  }
  const stable = opts.stable === true;
  const x = (lon: number) => Number((lon + shift.lon).toFixed(6));
  const y = (lat: number) => Number((lat + shift.lat).toFixed(6));
  const id = (prefix: PublicIdPrefix, n: number) => (shifted ? newPublicId(prefix) : fixedId(prefix, n));
  const areaKey = opts.key ?? "delivery-test";
  const col = (c: number) => c + shift.lon * 4;
  const row = 500 + shift.lat * 4;
  const tile = async (tileId: string, areaId: string | null) => {
    // a committed fixture takes over the tiles of an earlier run (ended rows, tiles are never deleted)
    if (opts.committed) await tx.update(tiles).set({ areaId }).where(eq(tiles.id, tileId));
    return insertTestTile(tx, tileId, areaId);
  };

  // Area polygon = the two tiles.
  const areaPublicId = id("ar", 1);
  const [area] = await tx
    .insert(geoObjects)
    .values({ type: "area", origin: "manual", geom: geomFromGeoJson(square(x(21.0), y(35.0), x(21.5), y(35.25))), publicId: areaPublicId, configKey: areaKey })
    .returning({ id: geoObjects.id });
  const areaId = area!.id;
  await tx.insert(geoNames).values([
    { geoObjectId: areaId, name: "Testrevier", nameNormalized: "testrevier", language: "de", script: "latin", origin: "manual" },
    { geoObjectId: areaId, name: "Test Waters", nameNormalized: "test waters", language: "en", script: "latin", origin: "manual" },
  ]);
  const west = await tile(`q025:${col(804)}:${row}`, areaId);
  const east = await tile(`q025:${col(805)}:${row}`, areaId);
  const outsideTileId = await tile(`q025:${col(806)}:${row}`, null);

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
  const archipelagoId = await insertNamedObject(tx, { type: "archipelago", names: [{ name: "Test Islands" }], lon: x(21.15), lat: y(35.1), tiles: [west], parentId: areaId });
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
  }): Promise<FixturePlace> => {
    const geoObjectId = await insertNamedObject(tx, {
      type: o.type ?? "bay",
      names: o.names ?? [{ name: o.name }],
      lon: o.lon,
      lat: o.lat,
      tiles: [o.tile],
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

  const posM: [number, number] = [x(21.3), y(35.1)];
  const M = await place({ lon: posM[0], lat: posM[1], name: "Marina Test", type: "harbour", kind: "marina", publicId: id("sp", 2), tile: east });
  const sectors = (value: number, omit: string[] = []) =>
    Object.fromEntries(Object.keys(SPOT_A_SHELTER).filter((s) => !omit.includes(s)).map((s) => [`shelter.${s}`, value]));
  const computedProvenance = (keys: string[]) => Object.fromEntries(keys.map((k) => [k, provenanceEntry("computed")]));
  const marina = { "place.kind": "marina", "place.status": "confirmed", exclude: { excluded: false, reason: null, detail: null }, ...sectors(0.9), occupancy: { "7": "full", "8": "full" } };
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

  const K = await place({ lon: x(21.22), lat: y(35.2), name: "Kandidat", status: "candidate", publicId: null, tile: west });
  const O = await place({ lon: x(21.6), lat: y(35.1), name: "Elsewhere", publicId: id("sp", 5), tile: outsideTileId });

  const posT: [number, number] = [posA[0], Number((posA[1] - LAT_PER_NM).toFixed(6))];
  const poiPublicId = id("hl", 1);
  const poiId = await insertNamedObject(tx, { type: "poi", names: [{ name: "Taverna Vathi" }], lon: posT[0], lat: posT[1], category: "food", tiles: [west] });
  await tx.update(geoObjects).set({ publicId: poiPublicId }).where(sql`${geoObjects.id} = ${poiId}`);
  await insertProfile(tx, poiId, { "derived.importance": 2 }, { "derived.importance": provenanceEntry("derived", { confidence: 1 }) }, { confidence: null });

  return {
    areaId,
    areaPublicId,
    areaKey,
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
 * Ends what a committed fixture wrote that area, tile, place and review queries could meet: geo objects and places
 * end today (never deleted), the area's tiles belong to no area again, its restricted area ends and the land polygons
 * in its box are deleted. Append-only rows (profiles, deliveries) stay, attached to ended objects.
 */
export async function endCommittedDeliveryArea(db: Db, f: DeliveryFixture): Promise<void> {
  const objectIds = [f.areaId, f.islandId, f.archipelagoId, f.capeId, f.poiId, ...Object.values(f.places).map((p) => p.geoObjectId)];
  const [w, s, e, n] = f.bbox;
  const today = sql`current_date`;
  await db.update(places).set({ validTo: today }).where(and(inArray(places.geoObjectId, objectIds), isNull(places.validTo)));
  await db.update(geoObjects).set({ validTo: today }).where(and(inArray(geoObjects.id, objectIds), isNull(geoObjects.validTo)));
  await db.update(restrictedAreas).set({ validTo: today }).where(and(eq(restrictedAreas.id, f.restrictedAreaId), isNull(restrictedAreas.validTo)));
  await db.update(tiles).set({ areaId: null }).where(eq(tiles.areaId, f.areaId));
  await db.execute(sql`delete from land_polygons where geom && ST_MakeEnvelope(${w}, ${s}, ${e}, ${n}, 4326)`);
}
