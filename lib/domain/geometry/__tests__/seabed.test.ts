import type { Polygon } from "geojson";
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import type { DatasetsConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import type { Bbox } from "@/lib/domain/tiles";
import { withRollback } from "@/test/db";
import { rect, SYNTHETIC_SRID } from "@/test/geometry/synthetic";
import { classifySeabed, replaceSeabed, seabedShares, type SeabedFeature } from "../seabed";

const cfg: DatasetsConfig["seabed"] = {
  wfsUrl: "https://example.test/wfs",
  typeName: "test:substrate",
  substrateField: "substrate",
  habitatFields: ["habitat", "eunis2019d"],
  substrateMap: {
    Mud: "mud",
    "Muddy sand": "sand",
    Sand: "sand",
    "Coarse substrate": "gravel",
    "Mixed sediment": "mixed",
    "Rock or other hard substrata": "rock",
  },
  weedPatterns: ["posidonia", "seagrass", "cymodocea", "zostera"],
  sortBy: "objectid",
  pageSize: 500,
  timeoutSeconds: 180,
  ratePerMinute: 20,
};

/** Box around the synthetic reference point (≈ 21.0 E / 35.23 N), outside the pilot box. */
const BOX: Bbox = [20.9, 35.1, 21.1, 35.3];

/** WGS84 GeoJSON polygon of the EPSG:32634 rectangle x0…x1 × y0…y1 metres from the reference point. */
async function utmRect(tx: Db, x0: number, y0: number, x1: number, y1: number): Promise<Polygon> {
  const { rows } = await tx.execute<{ g: Polygon }>(
    sql`select ST_AsGeoJSON(ST_Transform(ST_GeomFromText(${rect(x0, y0, x1, y1)}, ${SYNTHETIC_SRID}::int), 4326), 15)::json as g`,
  );
  return rows[0]!.g;
}

const feature = (substrate: SeabedFeature["substrate"], geometry: SeabedFeature["geometry"], ref = "f"): SeabedFeature => ({
  substrate,
  habitat: null,
  sourceRef: ref,
  geometry,
});

async function rowsOf(tx: Db, subdivisionKey: string): Promise<Array<{ substrate: string; valid: boolean; type: string; inBox: boolean }>> {
  const { rows } = await tx.execute<{ substrate: string; valid: boolean; type: string; in_box: boolean }>(sql`
    select substrate, ST_IsValid(geom) as valid, GeometryType(geom) as type,
           ST_CoveredBy(geom, ST_MakeEnvelope(${BOX[0]}::float8, ${BOX[1]}::float8, ${BOX[2]}::float8, ${BOX[3]}::float8, 4326)) as in_box
    from seabed_polygons where subdivision_key = ${subdivisionKey} order by substrate`);
  return rows.map((r) => ({ substrate: r.substrate, valid: r.valid, type: r.type, inBox: r.in_box }));
}

describe("classifySeabed", () => {
  it.each([
    [{ substrate: "Sand" }, "sand"],
    [{ substrate: "Rock or other hard substrata" }, "rock"],
    [{ substrate: "Sand", habitat: "Posidonia oceanica meadows" }, "weed"],
    [{ substrate: "Mud", eunis2019d: "MB5521: SEAGRASS beds" }, "weed"],
    [{ substrate: "Unknown" }, null],
    [{ substrate: "constructor" }, null],
    [{ substrate: 7 }, null],
    [{}, null],
  ])("classifySeabed %o → %s", (props, expected) => {
    expect(classifySeabed(props, cfg)).toBe(expected);
  });
});

describe("replaceSeabed", () => {
  it("replaces the rows of the subdivision key only, clipped to the box, made valid and split into polygons", () =>
    withRollback(async (tx) => {
      await replaceSeabed(tx, {
        subdivisionKey: "test-other",
        datasetVersion: "v1",
        box: BOX,
        features: [feature("mud", await utmRect(tx, 0, 0, 100, 100))],
      });
      await replaceSeabed(tx, {
        subdivisionKey: "test-a",
        datasetVersion: "v1",
        box: BOX,
        features: [feature("sand", await utmRect(tx, 0, 0, 100, 100))],
      });

      const bowtie: Polygon = { type: "Polygon", coordinates: [[[21.0, 35.2], [21.01, 35.21], [21.01, 35.2], [21.0, 35.21], [21.0, 35.2]]] };
      const crossesBox: Polygon = { type: "Polygon", coordinates: [[[21.05, 35.25], [21.2, 35.25], [21.2, 35.28], [21.05, 35.28], [21.05, 35.25]]] };
      const outside: Polygon = { type: "Polygon", coordinates: [[[22.0, 36.0], [22.1, 36.0], [22.1, 36.1], [22.0, 36.0]]] };
      const result = await replaceSeabed(tx, {
        subdivisionKey: "test-a",
        datasetVersion: "v2",
        box: BOX,
        features: [feature("rock", bowtie), feature("gravel", crossesBox), feature("weed", outside)],
      });

      // The bow-tie becomes two triangles, the crossing polygon is cut, the outside one is dropped.
      expect(result).toEqual({ inserted: 3 });
      const rows = await rowsOf(tx, "test-a");
      expect(rows.map((r) => r.substrate)).toEqual(["gravel", "rock", "rock"]);
      expect(rows.every((r) => r.valid && r.type === "POLYGON" && r.inBox)).toBe(true);
      expect((await rowsOf(tx, "test-other")).map((r) => r.substrate)).toEqual(["mud"]);
    }));

  it("keeps habitat and source reference", () =>
    withRollback(async (tx) => {
      await replaceSeabed(tx, {
        subdivisionKey: "test-a",
        datasetVersion: "v1",
        box: BOX,
        features: [{ substrate: "weed", habitat: "Posidonia oceanica meadows", sourceRef: "eusm.42", geometry: await utmRect(tx, 0, 0, 100, 100) }],
      });
      const { rows } = await tx.execute<{ habitat: string; source_ref: string; dataset_version: string }>(
        sql`select habitat, source_ref, dataset_version from seabed_polygons where subdivision_key = 'test-a'`,
      );
      expect(rows).toEqual([{ habitat: "Posidonia oceanica meadows", source_ref: "eusm.42", dataset_version: "v1" }]);
    }));
});

describe("seabedShares", () => {
  it("1 km² split 70/30 sand/rock → [{sand,0.7},{rock,0.3}], coverage 1", () =>
    withRollback(async (tx) => {
      await replaceSeabed(tx, {
        subdivisionKey: "test-a",
        datasetVersion: "v1",
        box: BOX,
        features: [feature("sand", await utmRect(tx, 0, 0, 700, 1000)), feature("rock", await utmRect(tx, 700, 0, 1000, 1000))],
      });
      const result = await seabedShares(tx, await utmRect(tx, 0, 0, 1000, 1000));
      expect(result.shares).toEqual([
        { type: "sand", share: 0.7 },
        { type: "rock", share: 0.3 },
      ]);
      expect(result.coverage).toBeCloseTo(1, 3);
      expect(result.versions).toEqual(["v1"]);
    }));

  it("the same polygon imported for two subdivisions is not counted twice", () =>
    withRollback(async (tx) => {
      const sand = await utmRect(tx, 0, 0, 500, 1000);
      const rock = await utmRect(tx, 500, 0, 1000, 1000);
      await replaceSeabed(tx, { subdivisionKey: "test-a", datasetVersion: "v1", box: BOX, features: [feature("sand", sand), feature("rock", rock)] });
      await replaceSeabed(tx, { subdivisionKey: "test-b", datasetVersion: "v2", box: BOX, features: [feature("sand", sand)] });
      const result = await seabedShares(tx, await utmRect(tx, 0, 0, 1000, 1000));
      expect(result.shares).toEqual([
        { type: "rock", share: 0.5 },
        { type: "sand", share: 0.5 },
      ]);
      expect(result.coverage).toBeCloseTo(1, 3);
      expect(result.versions).toEqual(["v1", "v2"]);
    }));

  it("only 40 % covered → coverage 0.4", () =>
    withRollback(async (tx) => {
      await replaceSeabed(tx, { subdivisionKey: "test-a", datasetVersion: "v1", box: BOX, features: [feature("mud", await utmRect(tx, 0, 0, 400, 1000))] });
      const result = await seabedShares(tx, await utmRect(tx, 0, 0, 1000, 1000));
      expect(result.shares).toEqual([{ type: "mud", share: 1 }]);
      expect(result.coverage).toBeCloseTo(0.4, 3);
    }));

  it("rounds to 0.01, drops zeros and lets the largest share absorb the rest", () =>
    withRollback(async (tx) => {
      // 1/3 + 1/3 + 0.329 + 0.004 of 1 km²: rounding gives 0.33 + 0.33 + 0.33 + 0 = 0.99.
      await replaceSeabed(tx, {
        subdivisionKey: "test-a",
        datasetVersion: "v1",
        box: BOX,
        features: [
          feature("sand", await utmRect(tx, 0, 0, 1000 / 3 + 1, 1000)),
          feature("mud", await utmRect(tx, 1000 / 3 + 1, 0, 2000 / 3, 1000)),
          feature("rock", await utmRect(tx, 2000 / 3, 0, 996, 1000)),
          feature("gravel", await utmRect(tx, 996, 0, 1000, 1000)),
        ],
      });
      const result = await seabedShares(tx, await utmRect(tx, 0, 0, 1000, 1000));
      expect(result.shares).toEqual([
        { type: "sand", share: 0.34 },
        { type: "mud", share: 0.33 },
        { type: "rock", share: 0.33 },
      ]);
    }));

  it("no seabed polygons → no shares, coverage 0", () =>
    withRollback(async (tx) => {
      expect(await seabedShares(tx, await utmRect(tx, 0, 0, 1000, 1000))).toEqual({ shares: [], coverage: 0, versions: [] });
    }));
});
