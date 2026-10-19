import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { nonJsonValues, writeGoldenFile } from "../golden-file";

describe("writeGoldenFile", () => {
  const dirs: string[] = [];
  const file = () => {
    const dir = mkdtempSync(join(tmpdir(), "golden-"));
    dirs.push(dir);
    return join(dir, "golden.json");
  };
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("writes finite values outside CI", () => {
    const path = file();
    writeGoldenFile(path, { a: 1, b: [0.5, null], c: { d: "x" } }, {});
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ a: 1, b: [0.5, null], c: { d: "x" } });
  });

  it("is refused when CI is set", () => {
    const path = file();
    expect(() => writeGoldenFile(path, { a: 1 }, { CI: "true" })).toThrow(/refused under CI/);
    expect(existsSync(path)).toBe(false);
  });

  it("refuses NaN, Infinity and undefined and names their paths", () => {
    const path = file();
    const values = { places: { P: { swell: NaN, sectors: { N: 0.5, S: Infinity }, opening: undefined, list: [1, NaN] } } };
    expect(nonJsonValues(values)).toEqual(["$.places.P.swell", "$.places.P.sectors.S", "$.places.P.opening", "$.places.P.list[1]"]);
    expect(() => writeGoldenFile(path, values, {})).toThrow(/\$\.places\.P\.swell/);
    expect(existsSync(path)).toBe(false);
  });
});
