import { describe, expect, it } from "vitest";
import { getConfig, type AreaConfig } from "@/lib/config";
import { areaBbox } from "@/lib/domain/gazetteer/areas";
import { bufferBbox } from "@/lib/domain/gazetteer/land";
import { areaTileIds } from "@/lib/domain/gazetteer/tiles-ensure";
import { tileBbox, TILE_SIZE, type Bbox } from "@/lib/domain/tiles";
import { landImportBbox, parseArgs } from "../import-land-polygons";

describe("import-land-polygons CLI", () => {
  it("parses flags and defaults the version to today", () => {
    const a = parseArgs(["--shp", "x.shp", "--area", "saronic"]);
    expect(a).toMatchObject({ shp: "x.shp", area: "saronic" });
    expect(a.version).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(parseArgs(["--shp", "x", "--area", "a", "--version", "2026-01-02"]).version).toBe("2026-01-02");
  });

  it("rejects missing, unknown or malformed arguments", () => {
    expect(() => parseArgs(["--area", "a"])).toThrow(/usage/);
    expect(() => parseArgs(["--shp", "x", "--area", "a", "--foo", "1"])).toThrow(/usage/);
    expect(() => parseArgs(["--shp", "x", "--area", "a", "--version", "today"])).toThrow(/YYYY-MM-DD/);
  });
});

describe("landImportBbox", () => {
  const contains = ([w, s, e, n]: Bbox, [iw, is, ie, inn]: Bbox) => w <= iw && s <= is && e >= ie && n >= inn;
  const onGrid = (v: number) => Number.isInteger(v / TILE_SIZE);

  /** A polygon box ending exactly on a tile edge: tilesInBbox still includes the tile east / north of it. */
  const edgeArea: AreaConfig = {
    ...getConfig().areas[0]!,
    key: "edge-test",
    polygon: { type: "Polygon", coordinates: [[[23, 37], [23.5, 37], [23.5, 37], [23, 37], [23, 37]]] },
    tileBbox: null,
    coastSections: [],
  };

  it.each([...getConfig().areas, edgeArea].map((a) => [a.key, a] as const))(
    "%s: buffered area box snapped outward to the tile grid, covering every area tile",
    (_key, area) => {
      for (const km of [0, getConfig().gazetteer.landBufferKm]) {
        const box = landImportBbox(area, km);
        expect(box.every(onGrid)).toBe(true);
        expect(contains(box, bufferBbox(areaBbox(area), km))).toBe(true);
        for (const id of areaTileIds(area)) expect(contains(box, tileBbox(id)), id).toBe(true);
      }
    },
  );

  it("adds the buffer before snapping", () => {
    const area: AreaConfig = { ...edgeArea, polygon: { type: "Polygon", coordinates: [[[23.1, 37.1], [23.4, 37.1], [23.4, 37.2], [23.1, 37.1]]] } };
    expect(landImportBbox(area, 0)).toEqual([23, 37, 23.5, 37.25]);
    // 20 km reach past the neighbouring grid lines (about 0.18 deg latitude, 0.23 deg longitude here).
    expect(landImportBbox(area, 20)).toEqual([22.75, 36.75, 23.75, 37.5]);
  });
});
