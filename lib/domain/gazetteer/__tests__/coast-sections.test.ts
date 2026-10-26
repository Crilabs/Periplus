import { and, eq, isNull, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { getConfig, type SubdivisionsConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { asGeoJson } from "@/lib/db/geometry";
import { geoNames, geoObjects, subdivisions } from "@/lib/db/schema";
import { syncCoastSections } from "@/lib/domain/gazetteer/coast-sections";
import { isPublicId, newPublicId } from "@/lib/domain/ids";
import { withRollback } from "@/test/db";

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

async function validNames(tx: Db, id: string) {
  return tx
    .select({ name: geoNames.name, language: geoNames.language, origin: geoNames.origin, isPreferred: geoNames.isPreferred })
    .from(geoNames)
    .where(and(eq(geoNames.geoObjectId, id), isNull(geoNames.validTo)));
}

/** A subdivision `key` over a box outside the pilot box, with its admin region; returns the region's id. */
async function insertSubdivision(tx: Db, key: string, box: [number, number, number, number]): Promise<string> {
  const polygon = sql`ST_Multi(ST_MakeEnvelope(${box[0]}, ${box[1]}, ${box[2]}, ${box[3]}, 4326))`;
  const [region] = await tx.insert(geoObjects).values({ type: "admin_region", origin: "manual", adminLevel: 4, geom: polygon }).returning({ id: geoObjects.id });
  await tx.insert(subdivisions).values({ publicId: newPublicId("sd"), key, country: "GR", geoObjectId: region!.id, geom: polygon });
  return region!.id;
}

/** The repository's subdivisions configuration with one coast section `north` for `XT-COAST` (outside the pilot box). */
type Section = { key: string; names: Record<string, string>; polygon: { type: "Polygon"; coordinates: [number, number][][] } };

function withSection(patch: (s: Section) => void = () => {}): SubdivisionsConfig {
  const cfg = structuredClone(getConfig().subdivisions);
  const section: Section = {
    key: "north",
    names: { de: "Nordküste", en: "North Coast", el: "Βόρεια Ακτή" },
    polygon: { type: "Polygon", coordinates: [[[25.0, 35.8], [25.5, 35.8], [25.5, 36.0], [25.0, 36.0], [25.0, 35.8]]] },
  };
  patch(section);
  cfg.overrides["XT-COAST"] = { coastSections: [section] };
  return cfg;
}

describe("syncCoastSections", () => {
  it("creates the configured sections under the subdivision's geo object, once", async () => {
    await withRollback(async (tx) => {
      // GR-I has the coast section "methana" in config/subdivisions.json (inside the pilot box: rolled back).
      const region = await insertSubdivision(tx, "GR-I", [22.5, 37.0, 23.9, 38.0]);
      const first = await syncCoastSections(tx, "GR-I");
      expect([...first.keys()]).toEqual(["GR-I/methana"]);
      const section = await validObject(tx, "GR-I/methana");
      expect(section).toMatchObject({ type: "coast_section", origin: "manual", parentId: region });
      expect(isPublicId(section.publicId!, "rg")).toBe(true);
      expect((await validNames(tx, section.id)).filter((n) => n.origin === "manual").map((n) => n.language).sort()).toEqual(["de", "el", "en"]);

      expect(await syncCoastSections(tx, "GR-I")).toEqual(first);
    });
  });

  it("updates the polygon on change and keeps id and public id", async () => {
    await withRollback(async (tx) => {
      await insertSubdivision(tx, "XT-COAST", [25.0, 35.0, 26.0, 36.0]);
      const ids = await syncCoastSections(tx, "XT-COAST", withSection());
      const before = await validObject(tx, "XT-COAST/north");
      await syncCoastSections(tx, "XT-COAST", withSection((s) => (s.polygon.coordinates[0]![1]![0] = 25.6)));
      const after = await validObject(tx, "XT-COAST/north");
      expect(after).toMatchObject({ id: ids.get("XT-COAST/north"), publicId: before.publicId });
      expect(after.geom).not.toEqual(before.geom);
    });
  });

  it("replaces a renamed manual name and keeps it preferred", async () => {
    await withRollback(async (tx) => {
      await insertSubdivision(tx, "XT-COAST", [25.0, 35.0, 26.0, 36.0]);
      const ids = await syncCoastSections(tx, "XT-COAST", withSection());
      await syncCoastSections(tx, "XT-COAST", withSection((s) => (s.names.en = "Northern Shore")));
      const en = (await validNames(tx, ids.get("XT-COAST/north")!)).filter((n) => n.language === "en");
      expect(en).toEqual([{ name: "Northern Shore", language: "en", origin: "manual", isPreferred: true }]);
    });
  });

  it("a corrected Greek name ends the old name's transliteration, one another Greek name still produces stays (W3-M-2)", async () => {
    await withRollback(async (tx) => {
      await insertSubdivision(tx, "XT-COAST", [25.0, 35.0, 26.0, 36.0]);
      const id = (await syncCoastSections(tx, "XT-COAST", withSection())).get("XT-COAST/north")!;
      // another source's identical Greek name: its transliteration must survive the correction
      await tx.insert(geoNames).values({ geoObjectId: id, name: "Βόρεια Ακτή", nameNormalized: "βορεια ακτη", language: "el", script: "greek", origin: "osm" });
      await syncCoastSections(tx, "XT-COAST", withSection((s) => (s.names.el = "Βόρειες Ακτές")));
      const latin = (await validNames(tx, id)).filter((n) => n.origin === "transliteration").map((n) => n.name).sort();
      expect(latin).toEqual(["Voreia Akti", "Voreies Aktes"]);
    });
  });

  it("ends a section no longer configured, and a key configured again revives the same object (DAT-4)", async () => {
    await withRollback(async (tx) => {
      await insertSubdivision(tx, "XT-COAST", [25.0, 35.0, 26.0, 36.0]);
      const id = (await syncCoastSections(tx, "XT-COAST", withSection())).get("XT-COAST/north")!;
      const none = structuredClone(getConfig().subdivisions);
      expect(await syncCoastSections(tx, "XT-COAST", none)).toEqual(new Map());
      const [ended] = await tx.select({ validTo: geoObjects.validTo }).from(geoObjects).where(eq(geoObjects.id, id));
      expect(ended!.validTo).not.toBeNull();
      expect((await syncCoastSections(tx, "XT-COAST", withSection())).get("XT-COAST/north")).toBe(id);
    });
  });

  it("an unknown subdivision throws", async () => {
    await withRollback(async (tx) => {
      await expect(syncCoastSections(tx, "XX-NOWHERE")).rejects.toThrow("Unknown subdivision XX-NOWHERE");
    });
  });
});
