import { and, eq, isNull, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import type { AreaConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { asGeoJson } from "@/lib/db/geometry";
import { geoNames, geoObjects } from "@/lib/db/schema";
import { areaBbox, endUnconfiguredAreas, syncAreas } from "@/lib/domain/gazetteer/areas";
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

  it("a corrected Greek name ends the old name's transliteration, one another Greek name still produces stays (W3-M-2)", async () => {
    await withRollback(async (tx) => {
      const ids = await syncAreas(tx, [testArea()]);
      const sectionId = ids.get("test-area/north")!;
      // another source's identical Greek name on the area: its transliteration must survive the correction
      const areaId = ids.get("test-area")!;
      await tx.insert(geoNames).values({
        geoObjectId: areaId, name: "Δοκιμαστικός Κόλπος", nameNormalized: "δοκιμαστικος κολπος", language: "el", script: "greek", origin: "osm",
      });
      const renamed = testArea();
      renamed.names.el = "Δοκιμαστικός Όρμος";
      renamed.coastSections[0]!.names.el = "Βόρειες Ακτές";
      await syncAreas(tx, [renamed]);
      const latin = async (id: string) =>
        (await validNames(tx, id)).filter((n) => n.origin === "transliteration").map((n) => n.name).sort();
      expect(await latin(sectionId)).toEqual(["Voreies Aktes"]);
      expect(await latin(areaId)).toEqual(["Dokimastikos Kolpos", "Dokimastikos Ormos"]);
    });
  });

  it("keeps an area's parent set by the hierarchy stage", async () => {
    await withRollback(async (tx) => {
      const [sea] = await tx
        .insert(geoObjects)
        .values({ type: "sea", origin: "osm", geom: sql`ST_MakeEnvelope(24.0, 34.0, 27.0, 37.0, 4326)` })
        .returning({ id: geoObjects.id });
      const ids = await syncAreas(tx, [testArea()]);
      const areaId = ids.get("test-area")!;
      await tx.update(geoObjects).set({ parentId: sea!.id }).where(eq(geoObjects.id, areaId));
      await syncAreas(tx, [testArea()]);
      expect((await validObject(tx, "test-area")).parentId).toBe(sea!.id);
      expect(await historyCount(tx, areaId)).toBe(1);
    });
  });
});

describe("areaBbox", () => {
  it("ends an area or coast section no longer configured, and a key configured again revives the same object (DAT-4)", async () => {
    await withRollback(async (tx) => {
      const key = `test-area-${Math.random().toString(36).slice(2, 10)}`;
      const base = { ...testArea(), key };
      const sections = [
        { ...base.coastSections[0]!, key: "east" },
        { ...base.coastSections[0]!, key: "west" },
      ];
      const area = { ...base, coastSections: sections };
      const other = { ...testArea(), key: `${key}-other`, coastSections: [] };
      const ids = await syncAreas(tx, [area, other]);
      const among = [key, `${key}/east`, `${key}/west`, `${key}/aegina-east`, `${key}-other`];

      // `east` renamed to `aegina-east`, the other area's file deleted
      const renamed = { ...area, coastSections: [{ ...sections[0]!, key: "aegina-east" }, sections[1]!] };
      const after = await syncAreas(tx, [renamed]);
      expect(await endUnconfiguredAreas(tx, [renamed], { among })).toEqual([`${key}-other`, `${key}/east`]);
      const validTo = async (id: string) =>
        (await tx.select({ validTo: geoObjects.validTo }).from(geoObjects).where(eq(geoObjects.id, id)))[0]!.validTo;
      expect(await validTo(ids.get(`${key}/east`)!)).not.toBeNull();
      expect(await validTo(ids.get(`${key}-other`)!)).not.toBeNull();
      expect(await validTo(ids.get(`${key}/west`)!)).toBeNull();
      expect(await validTo(after.get(`${key}/aegina-east`)!)).toBeNull();
      expect(after.get(`${key}/aegina-east`)).not.toBe(ids.get(`${key}/east`));
      // nothing left to end
      expect(await endUnconfiguredAreas(tx, [renamed], { among })).toEqual([]);

      // the other area's file comes back: same object, same public id
      const otherBefore = (await tx.select({ publicId: geoObjects.publicId }).from(geoObjects).where(eq(geoObjects.id, ids.get(`${key}-other`)!)))[0]!;
      const again = await syncAreas(tx, [renamed, other]);
      expect(again.get(`${key}-other`)).toBe(ids.get(`${key}-other`));
      expect(await validObject(tx, `${key}-other`)).toMatchObject({ id: ids.get(`${key}-other`), publicId: otherBefore.publicId });
    });
  });

  it("unions the polygon box with the tile box", () => {
    const area = testArea();
    expect(areaBbox(area)).toEqual([25.0, 35.0, 26.0, 36.0]);
    expect(areaBbox({ ...area, tileBbox: [24.5, 35.5, 25.5, 36.5] })).toEqual([24.5, 35.0, 26.0, 36.5]);
  });
});
