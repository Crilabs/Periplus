import { and, inArray, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { geomFromGeoJson } from "@/lib/db/geometry";
import { geoObjects } from "@/lib/db/schema";
import { validAt, validAtAlias } from "@/lib/db/valid-at";
import { testDb, withRollback } from "@/test/db";

describe("validAt", () => {
  it("excludes rows that ended on the date and includes rows starting on it", async () => {
    const db = testDb();
    const geom = geomFromGeoJson({ type: "Point", coordinates: [23.4, 37.4] });
    const rows = await db
      .insert(geoObjects)
      .values([
        { type: "cape", origin: "manual", geom, validFrom: "2026-01-01", validTo: "2026-06-01" }, // ended on the date
        { type: "cape", origin: "manual", geom, validFrom: "2026-06-01" }, // starts on the date
        { type: "cape", origin: "manual", geom, validFrom: "2026-01-01", validTo: "2026-06-02" }, // ends after it
        { type: "cape", origin: "manual", geom, validFrom: "2026-06-02" }, // starts after it
      ])
      .returning({ id: geoObjects.id });
    const ids = rows.map((r) => r.id);

    const valid = await db
      .select({ id: geoObjects.id })
      .from(geoObjects)
      .where(and(inArray(geoObjects.id, ids), validAt(geoObjects, "2026-06-01")));

    expect(valid.map((r) => r.id).sort()).toEqual([ids[1], ids[2]].sort());
  });

  it("validAtAlias is the same rule for a raw-SQL alias and refuses anything but an alias (DAT-5)", async () => {
    await withRollback(async (tx) => {
      const geom = geomFromGeoJson({ type: "Point", coordinates: [-160.4, -60.4] });
      const rows = await tx
        .insert(geoObjects)
        .values([
          { type: "cape", origin: "manual", geom, validFrom: "2026-01-01", validTo: "2026-06-01" },
          { type: "cape", origin: "manual", geom, validFrom: "2026-06-01" },
          { type: "cape", origin: "manual", geom, validFrom: "2026-06-02" },
        ])
        .returning({ id: geoObjects.id });
      const ids = rows.map((r) => r.id);
      const { rows: valid } = await tx.execute<{ id: string }>(
        sql`select o.id from geo_objects o where o.id = any(${sql.param(ids)}::uuid[]) and ${validAtAlias("o", "2026-06-01")}`,
      );
      expect(valid.map((r) => r.id)).toEqual([ids[1]]);
      const { rows: viaSql } = await tx.execute<{ id: string }>(
        sql`select o.id from geo_objects o where o.id = any(${sql.param(ids)}::uuid[]) and ${validAtAlias("o", sql`'2026-06-02'::date`)}`,
      );
      expect(viaSql.map((r) => r.id).sort()).toEqual([ids[1], ids[2]].sort());
      expect(() => validAtAlias("o; drop table x")).toThrow(/alias/);
    });
  });

  it("defaults to the current date", async () => {
    const db = testDb();
    const geom = geomFromGeoJson({ type: "Point", coordinates: [23.4, 37.4] });
    const rows = await db
      .insert(geoObjects)
      .values([
        { type: "cape", origin: "manual", geom }, // valid from today
        { type: "cape", origin: "manual", geom, validFrom: "2000-01-01", validTo: "2000-01-02" },
      ])
      .returning({ id: geoObjects.id });

    const valid = await db
      .select({ id: geoObjects.id })
      .from(geoObjects)
      .where(and(inArray(geoObjects.id, rows.map((r) => r.id)), validAt(geoObjects)));

    expect(valid.map((r) => r.id)).toEqual([rows[0]!.id]);
  });
});
