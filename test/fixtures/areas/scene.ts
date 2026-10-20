import { sql } from "drizzle-orm";
import { getConfig, type AppConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { geoObjects, landPolygons, subdivisions, tiles, type GeoObjectType } from "@/lib/db/schema";
import type { AreaFile } from "@/lib/domain/areas/file";
import { assignTiles } from "@/lib/domain/gazetteer/hierarchy";
import { addNames } from "@/lib/domain/gazetteer/names";
import { newPublicId } from "@/lib/domain/ids";
import { tileBbox, tilesInBbox, type Bbox } from "@/lib/domain/tiles";

/*
 * Area import scene (plan 14b, task 3) in the Tyrrhenian Sea, outside the pilot box 23.0–23.75 E × 37.0–38.0 N:
 *
 * - subdivisions `ZT-A` (10.0–10.5 E) and `ZT-B` (10.5–11.0 E), both 40.0–40.5 N; `ZT-L` is split into both
 *   (`sceneConfig`), so it stands for a retired parent key like `GR-L`;
 * - a land polygon: mainland strip south of 40.0 N with a peninsula 10.2–10.3 E reaching north to 40.3 N;
 * - harbours Velani and Dorkasi on both sides of the peninsula, Myrtidi (Greek name only), the cape Sarandi at the
 *   peninsula's tip, the island Vrachonisi, the settlement Kastelani, the Teranos Gulf (polygon over most of ZT-B)
 *   with the harbours Lefkori and Petrili inside;
 * - two harbours „Agios Stefanos“, one in ZT-A, one in ZT-B (inside the gulf); the harbour and the settlement
 *   Kalidona at the same place; the harbour Skala (a configured common word);
 * - Plakari without subdivision one tile ring east of ZT-A's tiles, Xerolimni without subdivision two rings east.
 *
 * Every tile of `SCENE_BOX` is a coast tile, linked through `assignTiles`. Run inside `withRollback`.
 */

export const SCENE_BOX: Bbox = [9.5, 39.5, 11.5, 41.0];
export const SPLIT_PARENT = "ZT-L";
export const SCENE_COUNTRY = "ZT";

/** The peninsula's land polygon (WKT, SRID 4326). */
export const LAND_WKT =
  "POLYGON((10.0 39.9, 10.5 39.9, 10.5 40.0, 10.3 40.0, 10.3 40.3, 10.2 40.3, 10.2 40.0, 10.0 40.0, 10.0 39.9))";

export type Scene = {
  subdivisions: { a: string; b: string };
  objects: Record<string, string>;
};

/** The app config with `ZT-L` split into `ZT-A` and `ZT-B`. */
export function sceneConfig(base: AppConfig = getConfig()): AppConfig {
  const names = { de: "x", en: "x" };
  return {
    ...base,
    subdivisions: {
      ...base.subdivisions,
      split: [
        ...base.subdivisions.split,
        {
          parentKey: SPLIT_PARENT,
          groups: [
            { key: "ZT-A", names, memberWikidataIds: ["Q1"] },
            { key: "ZT-B", names, memberWikidataIds: ["Q2"] },
          ],
        },
      ],
    },
  } as AppConfig;
}

const box = ([w, s, e, n]: Bbox) => sql`ST_MakeEnvelope(${w}, ${s}, ${e}, ${n}, 4326)`;

async function insertSubdivision(db: Db, key: string, bbox: Bbox): Promise<string> {
  const [region] = await db
    .insert(geoObjects)
    .values({ type: "admin_region", origin: "manual", adminLevel: 5, tags: { country: SCENE_COUNTRY }, geom: sql`ST_Multi(${box(bbox)})` })
    .returning({ id: geoObjects.id });
  const [sub] = await db
    .insert(subdivisions)
    .values({ publicId: newPublicId("sd"), key, country: SCENE_COUNTRY, geoObjectId: region!.id, geom: sql`ST_Multi(${box(bbox)})` })
    .returning({ id: subdivisions.id });
  return sub!.id;
}

type ObjectSpec = {
  key: string;
  type: GeoObjectType;
  /** WKT */
  geom: string;
  names: Array<{ name: string; language: string }>;
  subdivision: "a" | "b" | null;
};

const point = (lon: number, lat: number) => `POINT(${lon} ${lat})`;
const rect = ([w, s, e, n]: Bbox) => `POLYGON((${w} ${s}, ${e} ${s}, ${e} ${n}, ${w} ${n}, ${w} ${s}))`;

const OBJECTS: ObjectSpec[] = [
  { key: "velani", type: "harbour", geom: point(10.17, 40.15), names: [{ name: "Velani", language: "und" }], subdivision: "a" },
  { key: "dorkasi", type: "harbour", geom: point(10.33, 40.15), names: [{ name: "Dorkasi", language: "und" }], subdivision: "a" },
  { key: "myrtidi", type: "harbour", geom: point(10.4, 40.35), names: [{ name: "Μυρτίδι", language: "el" }], subdivision: "a" },
  { key: "sarandi", type: "cape", geom: point(10.25, 40.3), names: [{ name: "Sarandi", language: "und" }], subdivision: "a" },
  {
    key: "vrachonisi",
    type: "island",
    geom: rect([10.05, 40.25, 10.1, 40.3]),
    names: [{ name: "Vrachonisi", language: "und" }],
    subdivision: "a",
  },
  { key: "kastelani", type: "settlement", geom: point(10.45, 40.1), names: [{ name: "Kastelani", language: "und" }], subdivision: "a" },
  {
    key: "stefanosA",
    type: "harbour",
    geom: point(10.1, 40.4),
    names: [{ name: "Agios Stefanos", language: "und" }],
    subdivision: "a",
  },
  {
    key: "teranos",
    type: "gulf",
    geom: rect([10.55, 40.05, 10.95, 40.45]),
    names: [{ name: "Teranos Gulf", language: "en" }],
    subdivision: "b",
  },
  { key: "lefkori", type: "harbour", geom: point(10.65, 40.3), names: [{ name: "Lefkori", language: "und" }], subdivision: "b" },
  { key: "petrili", type: "harbour", geom: point(10.8, 40.15), names: [{ name: "Petrili", language: "und" }], subdivision: "b" },
  {
    key: "stefanosB",
    type: "harbour",
    geom: point(10.7, 40.2),
    names: [{ name: "Agios Stefanos", language: "und" }],
    subdivision: "b",
  },
  { key: "kalidonaHarbour", type: "harbour", geom: point(10.42, 40.22), names: [{ name: "Kalidona", language: "und" }], subdivision: "a" },
  {
    key: "kalidonaTown",
    type: "settlement",
    geom: point(10.421, 40.221),
    names: [{ name: "Kalidona", language: "und" }],
    subdivision: "a",
  },
  { key: "skala", type: "harbour", geom: point(10.12, 40.05), names: [{ name: "Skala", language: "und" }], subdivision: "a" },
  { key: "plakari", type: "harbour", geom: point(10.6, 40.6), names: [{ name: "Plakari", language: "und" }], subdivision: null },
  { key: "xerolimni", type: "harbour", geom: point(10.85, 40.6), names: [{ name: "Xerolimni", language: "und" }], subdivision: null },
];

/** Inserts the scene (subdivisions, land, tiles, objects with names, tile links). */
export async function insertScene(db: Db): Promise<Scene> {
  const a = await insertSubdivision(db, "ZT-A", [10.0, 40.0, 10.5, 40.5]);
  const b = await insertSubdivision(db, "ZT-B", [10.5, 40.0, 11.0, 40.5]);
  await db.insert(landPolygons).values({ geom: sql`ST_GeomFromText(${LAND_WKT}, 4326)`, datasetVersion: "test" });
  const tileIds = tilesInBbox(SCENE_BOX);
  await db
    .insert(tiles)
    .values(tileIds.map((id) => ({ id, bbox: box(tileBbox(id)), hasCoast: true })))
    .onConflictDoNothing();
  const objects: Record<string, string> = {};
  for (const spec of OBJECTS) {
    const subdivisionId = spec.subdivision === "a" ? a : spec.subdivision === "b" ? b : null;
    const [row] = await db
      .insert(geoObjects)
      .values({ type: spec.type, origin: "osm", subdivisionId, geom: sql`ST_GeomFromText(${spec.geom}, 4326)` })
      .returning({ id: geoObjects.id });
    await addNames(db, row!.id, spec.names.map((n) => ({ ...n, origin: "osm" as const })));
    objects[spec.key] = row!.id;
  }
  await assignTiles(db, tileIds);
  return { subdivisions: { a, b }, objects };
}

type SceneArea = AreaFile["areas"][number];

const evidence = (key: string, n = 1) =>
  Array.from({ length: n }, (_, i) => ({
    url: `https://example.invalid/${key}/${i}`,
    publisher: "Example Pilot",
    lang: "en",
    quote: `${key} is a fine sailing area (${i}).`,
  }));

/** A file area with defaults; `members` and `boundaryPoints` as `[name, type]`. */
export function sceneArea(
  key: string,
  opts: {
    names?: SceneArea["names"];
    subdivisions?: string[];
    members?: Array<[string, SceneArea["members"][number]["type"]]>;
    boundaryPoints?: Array<[string, SceneArea["members"][number]["type"]]>;
    evidence?: number;
  },
): SceneArea {
  return {
    key,
    names: opts.names ?? [{ lang: "en", name: `${key} area`, preferred: true }],
    subdivisions: opts.subdivisions ?? ["ZT-A"],
    members: (opts.members ?? []).map(([name, type]) => ({ name, type })),
    boundaryPoints: (opts.boundaryPoints ?? []).map(([name, type]) => ({ name, type })),
    boundary: `Boundary of ${key}`,
    related: [],
    evidence: evidence(key, opts.evidence ?? 1),
    notes: `Notes on ${key}`,
  };
}

/** The scene's delivery: three areas (computed polygon, gulf polygon, computed with an unknown subdivision key). */
export function sceneFile(): AreaFile {
  return {
    country: SCENE_COUNTRY,
    generatedAt: "2026-10-20",
    areas: [
      sceneArea("velani-coast", {
        names: [
          { lang: "en", name: "Velani Coast", preferred: true },
          { lang: "el", name: "Ακτή Βελάνης", preferred: true },
        ],
        members: [
          ["Velani", "harbour"],
          ["Dorkasi", "harbour"],
          ["Myrtidi", "harbour"],
        ],
        boundaryPoints: [["Sarandi", "cape"]],
      }),
      sceneArea("teranos-gulf", {
        subdivisions: [SPLIT_PARENT],
        members: [
          ["Teranos Gulf", "gulf"],
          ["Lefkori", "harbour"],
          ["Petrili", "harbour"],
          ["Agios Stefanos", "harbour"],
        ],
      }),
      sceneArea("vrachos", {
        subdivisions: ["ZT-A", "ZT-UNKNOWN"],
        members: [
          ["Vrachonisi", "island"],
          ["Kastelani", "settlement"],
          ["Plakari", "harbour"],
        ],
      }),
    ],
  };
}
