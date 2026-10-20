import { describe, expect, it } from "vitest";
import { activeSubdivisionKeys, requireSubdivision } from "@/lib/domain/subdivisions/store";
import { tileIdFor } from "@/lib/domain/tiles";
import { withRollback } from "@/test/db";
import { insertTestSubdivision, insertTestTile } from "@/test/text";

const BOX: [number, number, number, number] = [30.0, 36.0, 30.5, 36.25];

describe("requireSubdivision", () => {
  it("refuses an excluded subdivision unless the caller reads it on purpose", () =>
    withRollback(async (db) => {
      await insertTestSubdivision(db, "XT-R1", BOX, { status: "excluded" });
      await expect(requireSubdivision(db, "XT-R1")).rejects.toThrow("Landesteil XT-R1 ist ausgeschlossen");
      expect(await requireSubdivision(db, "XT-R1", { allowExcluded: true })).toMatchObject({ key: "XT-R1", status: "excluded" });
    }));

  it("names the replacement for an area key and refuses an unknown key", () =>
    withRollback(async (db) => {
      await expect(requireSubdivision(db, "saronic")).rejects.toThrow("Revier-Schlüssel saronic ist kein Laufumfang mehr");
      await expect(requireSubdivision(db, "XT-NOPE")).rejects.toThrow("Unbekannter Landesteil XT-NOPE");
    }));
});

describe("activeSubdivisionKeys", () => {
  it("lists active subdivisions that have a labelled tile", () =>
    withRollback(async (db) => {
      const withTile = await insertTestSubdivision(db, "XT-R2", BOX);
      await insertTestSubdivision(db, "XT-R3", [31.0, 36.0, 31.5, 36.25]);
      const excluded = await insertTestSubdivision(db, "XT-R4", [32.0, 36.0, 32.5, 36.25], { status: "excluded" });
      await insertTestTile(db, tileIdFor(30.1, 36.1), null, withTile.id);
      await insertTestTile(db, tileIdFor(32.1, 36.1), null, excluded.id);
      const keys = await activeSubdivisionKeys(db);
      expect(keys).toContain("XT-R2");
      expect(keys).not.toContain("XT-R3");
      expect(keys).not.toContain("XT-R4");
    }));
});
