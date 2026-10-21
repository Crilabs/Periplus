import { writeArrayBuffer } from "geotiff";
import { describe, expect, it } from "vitest";
import { sampleDem } from "../terrain";

/** A `size` × `size` GeoTIFF of 0.01° pixels whose top-left corner is (`west`, `north`); `value(col, row)` per pixel. */
function tiff(west: number, north: number, size: number, value: (col: number, row: number) => number): Uint8Array {
  const values = new Float32Array(size * size);
  for (let row = 0; row < size; row++) for (let col = 0; col < size; col++) values[row * size + col] = value(col, row);
  return new Uint8Array(
    writeArrayBuffer(values, {
      width: size,
      height: size,
      ModelPixelScale: [0.01, 0.01, 0],
      ModelTiepoint: [0, 0, 0, west, north, 0],
      // Without GeographicTypeGeoKey the writer replaces the tie point with a whole-globe one.
      GeographicTypeGeoKey: 4326,
      GTModelTypeGeoKey: 2,
      GTRasterTypeGeoKey: 1,
    }),
  );
}

describe("sampleDem", () => {
  it("sampleDem merges two tiles without a zero seam", async () => {
    // Two tiles side by side at 22.0–22.1° and 22.1–22.2° E; the box crosses their common edge.
    const west = tiff(22.0, 38.0, 10, () => 100);
    const east = tiff(22.1, 38.0, 10, () => 100);
    const grid = await sampleDem([west, east], [22.05, 37.92, 22.15, 37.98], 100);
    expect(grid.cols).toBeGreaterThan(50);
    expect(grid.rows).toBeGreaterThan(40);
    expect(grid.heights).toHaveLength(grid.cols * grid.rows);
    expect(Math.min(...grid.heights)).toBeCloseTo(100, 3);
    expect(Math.max(...grid.heights)).toBeCloseTo(100, 3);
  });

  it("row 0 is the south edge and values are interpolated bilinearly", async () => {
    // Height rises 10 m per pixel row from north (row 0: 10 m) to south: the south edge is the high one.
    const t = tiff(22.0, 38.0, 10, (_, row) => 10 * (row + 1));
    const grid = await sampleDem([t], [22.02, 37.925, 22.08, 37.975], 50);
    const southRow = grid.heights.slice(0, grid.cols);
    const northRow = grid.heights.slice((grid.rows - 1) * grid.cols);
    // 37.925 lies on the centre of pixel row 7 (80 m), 37.975 on the centre of pixel row 2 (30 m).
    expect(southRow[0]).toBeCloseTo(80, 3);
    expect(northRow[0]).toBeCloseTo(30, 3);
    // Halfway in between, a linear ramp gives the mean.
    const mid = grid.heights[Math.floor(grid.rows / 2) * grid.cols]!;
    expect(mid).toBeGreaterThan(50);
    expect(mid).toBeLessThan(60);
  });

  it("negative heights clip to 0", async () => {
    // Columns 0–3 at −5 m, 4–5 at 0.3 m (below 0.5 m counts as sea), 6–9 at 12 m.
    const t = tiff(22.0, 38.0, 10, (col) => (col < 4 ? -5 : col < 6 ? 0.3 : 12));
    const grid = await sampleDem([t], [22.0, 37.9, 22.1, 38.0], 50);
    expect(Math.min(...grid.heights)).toBe(0);
    expect(grid.heights[0]).toBe(0);
    expect(grid.heights[grid.cols - 1]).toBeCloseTo(12, 3);
    // Nothing between 0 and 0.5 m survives.
    expect([...grid.heights].some((h) => h > 0 && h < 0.5)).toBe(false);
  });

  it("no tile under the box → all heights 0 (open sea)", async () => {
    const t = tiff(22.0, 38.0, 10, () => 100);
    const grid = await sampleDem([t], [24.0, 36.0, 24.02, 36.02], 100);
    expect(grid.heights.every((h) => h === 0)).toBe(true);
    const none = await sampleDem([], [24.0, 36.0, 24.02, 36.02], 100);
    expect(none.heights.every((h) => h === 0)).toBe(true);
  });
});
