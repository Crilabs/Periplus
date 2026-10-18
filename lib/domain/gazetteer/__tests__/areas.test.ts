import { and, eq, isNull, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import type { AreaConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { asGeoJson } from "@/lib/db/geometry";
import { geoNames, geoObjects } from "@/lib/db/schema";
import { syncAreas } from "@/lib/domain/gazetteer/areas";
import { isPublicId } from "@/lib/domain/ids";
import { withRollback } from "@/test/db";

// Outside the pilot box 23.0-23.75 E x 37.0-38.0 N; keys unlike any real area.
function testArea(east = 26.0): AreaConfig {
  return {
    key: "test-area",
    names: { de: "Testgolf", en: "Test Gulf", el: "Δοκιμαστικός Κόλπος" },
    polygon: {
      type: "Polygon",
      coordinates: [[[25.0, 35.0], [east, 35.0], [east, 36.0], [25.0, 36.0], [25.0, 35.0]]],
    },
    tileBbox: null,
    sourceLanguages: ["de", "en", "el"],
    season: { fromMonth: 4, toMonth: 10 },
    cycleDays: 30,
    coastSections: [
      {
        key: "north",
        names: { de: "Nordküste", en: "North Coast", el: "Βόρεια Ακτή" },
        polygon: {
          type: "Polygon",
          coordinates: [[[25.0, 35.8], [25.5, 35.8], [25.5, 36.0], [25.0, 36.0], [25.0, 35.8]]],
        },
      },
    ],
  };
}

async function validObject(tx: Db, configKey: string) {
  const rows = await tx
    .select({
      id: geoObjects.id,
      type: geoObjects.type,
      origin: geoObjects.origin,
      publicId: geoObjects.publicId,
      parentId: geoObjects.parentId,
      geom: asGeoJson(geoObjects.geom),
    })
    .from(geoObjects)
    .where(and(eq(geoObjects.configKey, configKey), isNull(geoObjects.validTo)));
  expect(rows).toHaveLength(1);
  return rows[0]!;
}

async function historyCount(tx: Db, id: string): Promise<number> {
  const { rows } = await tx.execute<{ n: number }>(
    sql`select count(*)::int as n from geo_objects_history where row_id = ${id}`,
  );
  return rows[0]!.n;
}

async function validNames(tx: Db, id: string) {
  return tx
    .select({ name: geoNames.name, language: geoNames.language, origin: geoNames.origin, isPreferred: geoNames.isPreferred })
    .from(geoNames)
    .where(and(eq(geoNames.geoObjectId, id), isNull(geoNames.validTo)));
}

describe("syncAreas", () => {
  it("creates area and coast sections once and updates the polygon on change", async () => {
    await withRollback(async (tx) => {
      const first = await syncAreas(tx, [testArea()]);
      const area = await validObject(tx, "test-area");
      const section = await validObject(tx, "test-area/north");
      expect(first).toEqual(new Map([["test-area", area.id], ["test-area/north", section.id]]));

      expect(area).toMatchObject({ type: "area", origin: "manual" });
      expect(isPublicId(area.publicId!, "ar")).toBe(true);
      expect(section).toMatchObject({ type: "coast_section", origin: "manual", parentId: area.id });
      expect(isPublicId(section.publicId!, "rg")).toBe(true);

      const names = await validNames(tx, area.id);
      expect(names).toEqual(
        expect.arrayContaining([
          { name: "Testgolf", language: "de", origin: "manual", isPreferred: true },
          { name: "Test Gulf", language: "en", origin: "manual", isPreferred: true },
          { name: "Δοκιμαστικός Κόλπος", language: "el", origin: "manual", isPreferred: true },
        ]),
      );

      // Unchanged rerun: same rows, no history, no duplicate names.
      const second = await syncAreas(tx, [testArea()]);
      expect(second).toEqual(first);
      expect(await historyCount(tx, area.id)).toBe(0);
      expect(await validNames(tx, area.id)).toHaveLength(names.length);

      // Changed polygon: same row, one history row.
      const third = await syncAreas(tx, [testArea(26.5)]);
      expect(third).toEqual(first);
      const updated = await validObject(tx, "test-area");
      expect(updated.id).toBe(area.id);
      expect(updated.publicId).toBe(area.publicId);
      expect(updated.geom).toMatchObject({ coordinates: [[[25, 35], [26.5, 35], [26.5, 36], [25, 36], [25, 35]]] });
      expect(await historyCount(tx, area.id)).toBe(1);
      expect(await historyCount(tx, section.id)).toBe(0);
    });
  });

  it("replaces a renamed manual name and keeps it preferred", async () => {
    await withRollback(async (tx) => {
      const ids = await syncAreas(tx, [testArea()]);
      const renamed = testArea();
      renamed.names.en = "Gulf of Testing";
      await syncAreas(tx, [renamed]);
      const en = (await validNames(tx, ids.get("test-area")!)).filter((n) => n.language === "en");
      expect(en).toEqual([{ name: "Gulf of Testing", language: "en", origin: "manual", isPreferred: true }]);
    });
  });
});
