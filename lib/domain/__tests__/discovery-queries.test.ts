import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { getConfig, type DiscoveryConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { geomFromGeoJson } from "@/lib/db/geometry";
import {
  computations,
  facts,
  geoNames,
  geoObjects,
  tileGeoObjects,
  tiles,
  type GeoObjectType,
  type NameOrigin,
} from "@/lib/db/schema";
import { areaQueries, capQueries, sourceLanguagesOfTile, tileQueries, type DiscoveryQuery } from "@/lib/domain/discovery/queries";
import { tileBbox, tileIdFor } from "@/lib/domain/tiles";
import { withRollback } from "@/test/db";
import { insertTestSubdivision } from "@/test/text";

// Synthetic data in open sea outside the pilot box 23.0-23.75 E x 37.0-38.0 N, at a spot no other test uses.
const LON = 29.83;
const LAT = 33.17;
const TILE = tileIdFor(LON, LAT);

const cfg = (): DiscoveryConfig => getConfig().discovery;

type Name = { name: string; language: string; origin?: NameOrigin; isPreferred?: boolean };

const SUB_BOX: [number, number, number, number] = [29.5, 33.0, 30.5, 33.5];

/** A Greek subdivision (languages el, de, en) around the test tile, its tile labelled with it. */
async function subdivisionTile(tx: Db, key = "XT-Q1", country = "GR"): Promise<string> {
  const sub = await insertTestSubdivision(tx, key, SUB_BOX, { country });
  await insertTile(tx, sub.id);
  return sub.id;
}

async function insertTile(tx: Db, subdivisionId: string | null): Promise<void> {
  const [w, s, e, n] = tileBbox(TILE);
  await tx.insert(tiles).values({ id: TILE, bbox: sql`ST_MakeEnvelope(${w}, ${s}, ${e}, ${n}, 4326)`, subdivisionId, hasCoast: true });
}

async function insertObject(tx: Db, type: GeoObjectType, names: Name[], opts: { validTo?: string } = {}): Promise<string> {
  const [o] = await tx
    .insert(geoObjects)
    .values({
      type,
      origin: "osm",
      geom: geomFromGeoJson({ type: "Point", coordinates: [LON, LAT] }),
      ...(opts.validTo ? { validFrom: "2020-01-01", validTo: opts.validTo } : {}),
    })
    .returning({ id: geoObjects.id });
  for (const n of names) {
    await tx.insert(geoNames).values({
      geoObjectId: o!.id,
      name: n.name,
      nameNormalized: n.name.toLowerCase(),
      language: n.language,
      script: /[Ͱ-Ͽ]/.test(n.name) ? "greek" : "latin",
      origin: n.origin ?? "osm",
      isPreferred: n.isPreferred ?? false,
    });
  }
  await tx.insert(tileGeoObjects).values({ tileId: TILE, geoObjectId: o!.id });
  return o!.id;
}

async function insertAnchorArea(tx: Db, geoObjectId: string, areaM2: number): Promise<void> {
  const [c] = await tx
    .insert(computations)
    .values({ geoObjectId, kind: "anchor_area", inputs: {}, inputsHash: "h", rulesVersion: "1" })
    .returning({ id: computations.id });
  await tx.insert(facts).values({
    geoObjectId,
    attribute: "anchor_area",
    value: { areaM2 },
    computationId: c!.id,
    observedAt: "2026-10-19",
    confidence: 0.5,
    factSchemaVersion: "1",
  });
}

const keywords = (qs: DiscoveryQuery[]) => qs.map((q) => `${q.keyword}|${q.languageCode}|${q.locationCode}|${q.priority}`).sort();

describe("tileQueries", () => {
  it("a bay qualifies by anchor area or two wikidata names", async () => {
    await withRollback(async (tx) => {
      await subdivisionTile(tx);
      await insertObject(tx, "island", [
        { name: "Nisos", language: "en" },
        { name: "Nisos-de", language: "de" },
        { name: "Νήσος", language: "el" },
      ]);
      const bayA = await insertObject(tx, "bay", [{ name: "Bay A", language: "en" }]);
      await insertAnchorArea(tx, bayA, 25_000);
      const bayB = await insertObject(tx, "bay", [{ name: "Bay B", language: "en", origin: "wikidata" }]);
      await insertAnchorArea(tx, bayB, 15_000);
      await insertObject(tx, "bay", [
        { name: "Bay C", language: "en", origin: "wikidata" },
        { name: "Bucht C", language: "de", origin: "wikidata" },
      ]);
      await insertObject(tx, "settlement", [{ name: "Chora", language: "en" }]);

      const qs = await tileQueries(tx, TILE, cfg());
      expect(keywords(qs)).toEqual(
        [
          "Ankerplatz Nisos-de|de|2276|1",
          "anchorage Nisos|en|2826|1",
          "αγκυροβόλιο Νήσος|el|2300|1",
          "anchorage Bay A|en|2826|3",
          "Ankerplatz Bucht C|de|2276|3",
          "anchorage Bay C|en|2826|3",
          "anchorage Chora|en|2826|2",
        ].sort(),
      );
      expect(qs.every((q) => q.level === "tile" && q.scopeId === TILE)).toBe(true);
    });
  });

  it("the newest anchor_area fact decides", async () => {
    await withRollback(async (tx) => {
      await subdivisionTile(tx);
      const bay = await insertObject(tx, "bay", [{ name: "Bay D", language: "en" }]);
      await insertAnchorArea(tx, bay, 25_000);
      // Same transaction, same created_at: a later fact must still win by insertion order.
      await insertAnchorArea(tx, bay, 10_000);
      expect(await tileQueries(tx, TILE, cfg())).toEqual([]);
    });
  });

  it("a language without a name yields no query", async () => {
    await withRollback(async (tx) => {
      await subdivisionTile(tx);
      await insertObject(tx, "island", [{ name: "Only English", language: "en" }]);
      const qs = await tileQueries(tx, TILE, cfg());
      expect(keywords(qs)).toEqual(["anchorage Only English|en|2826|1"]);
    });
  });

  it("uses the preferred valid name, skips ended objects, dedupes and keeps only the subdivision's languages", async () => {
    await withRollback(async (tx) => {
      await subdivisionTile(tx);
      await insertObject(tx, "island", [
        { name: "Zeta", language: "en" },
        { name: "Alpha", language: "en", isPreferred: true },
        { name: "Île", language: "fr" },
      ]);
      // A settlement with the same English name as the island: one query, with the island's priority.
      await insertObject(tx, "settlement", [{ name: "Alpha", language: "en" }]);
      await insertObject(tx, "islet", [{ name: "Gone", language: "en" }], { validTo: "2021-01-01" });
      const withFrench: DiscoveryConfig = {
        ...cfg(),
        templates: { ...cfg().templates, tile: [...cfg().templates.tile, { template: "mouillage {name}", lang: "fr", locationCode: 2250 }] },
      };
      const qs = await tileQueries(tx, TILE, withFrench);
      expect(keywords(qs)).toEqual(["anchorage Alpha|en|2826|1"]);
    });
  });
});

describe("tileQueries scope", () => {
  it("throws when the tile has no subdivision", async () => {
    await withRollback(async (tx) => {
      await insertTile(tx, null);
      await insertObject(tx, "island", [{ name: "Nowhere", language: "en" }]);
      await expect(tileQueries(tx, TILE, cfg())).rejects.toThrow(`Kachel ${TILE} hat keinen Landesteil`);
      await expect(sourceLanguagesOfTile(tx, TILE)).rejects.toThrow(`Kachel ${TILE} hat keinen Landesteil`);
    });
  });

  it("tile query languages come from the subdivision override, else from its country", async () => {
    await withRollback(async (tx) => {
      const withCatalan: DiscoveryConfig = {
        ...cfg(),
        templates: { ...cfg().templates, tile: [...cfg().templates.tile, { template: "fondejador {name}", lang: "ca", locationCode: 2724 }] },
      };
      await subdivisionTile(tx, "ES-CT", "ES");
      await insertObject(tx, "island", [
        { name: "Illa", language: "ca" },
        { name: "Isla", language: "es" },
      ]);
      // ES-CT overrides the Spanish default (es, de, en) with Catalan added
      expect(await sourceLanguagesOfTile(tx, TILE)).toEqual(["es", "ca", "de", "en"]);
      expect(keywords(await tileQueries(tx, TILE, withCatalan))).toContain("fondejador Illa|ca|2724|1");
    });
    await withRollback(async (tx) => {
      const withCatalan: DiscoveryConfig = {
        ...cfg(),
        templates: { ...cfg().templates, tile: [...cfg().templates.tile, { template: "fondejador {name}", lang: "ca", locationCode: 2724 }] },
      };
      await subdivisionTile(tx, "ES-VC", "ES");
      await insertObject(tx, "island", [{ name: "Illa", language: "ca" }]);
      expect(await sourceLanguagesOfTile(tx, TILE)).toEqual(["es", "de", "en"]);
      expect(await tileQueries(tx, TILE, withCatalan)).toEqual([]);
    });
  });
});

describe("areaQueries", () => {
  /** An `area` object (with `config_key`) named in de, en linked to the test tile and a Greek subdivision there. */
  async function areaObject(tx: Db, configKey: string, names: Name[]): Promise<string> {
    const [o] = await tx
      .insert(geoObjects)
      .values({
        type: "area",
        origin: "manual",
        configKey,
        geom: geomFromGeoJson({ type: "Point", coordinates: [LON, LAT] }),
      })
      .returning({ id: geoObjects.id });
    for (const n of names) {
      await tx.insert(geoNames).values({
        geoObjectId: o!.id,
        name: n.name,
        nameNormalized: n.name.toLowerCase(),
        language: n.language,
        script: "latin",
        origin: "manual",
        isPreferred: true,
      });
    }
    await tx.insert(tileGeoObjects).values({ tileId: TILE, geoObjectId: o!.id });
    return o!.id;
  }

  it("builds the area templates from the names of the areas touching the subdivision's tiles", async () => {
    await withRollback(async (tx) => {
      const subId = await subdivisionTile(tx, "XT-Q2");
      await areaObject(tx, "xt-gulf", [
        { name: "Testgolf", language: "de" },
        { name: "Test Gulf", language: "en" },
        { name: "Francais", language: "fr" },
      ]);
      expect(subId).toBeTruthy();
      const qs = await areaQueries(tx, "XT-Q2", cfg());
      expect(keywords(qs)).toEqual(
        ["Törnbericht Testgolf|de|2276|0", "Revierführer Testgolf|de|2276|0", "Test Gulf anchorages|en|2826|0"].sort(),
      );
      expect(qs.every((q) => q.level === "area" && q.scopeId === "xt-gulf")).toBe(true);
    });
  });

  it("an area outside the subdivision's tiles yields nothing; an unknown subdivision throws", async () => {
    await withRollback(async (tx) => {
      await subdivisionTile(tx, "XT-Q3");
      const far = await areaObject(tx, "xt-far", [{ name: "Fernegolf", language: "de" }]);
      await tx.delete(tileGeoObjects).where(eq(tileGeoObjects.geoObjectId, far));
      expect(await areaQueries(tx, "XT-Q3", cfg())).toEqual([]);
      await expect(areaQueries(tx, "XT-NOPE", cfg())).rejects.toThrow("Unbekannter Landesteil XT-NOPE");
    });
  });
});

describe("capQueries", () => {
  it("orders equal keywords by language and location, whatever the input order", () => {
    const q = (languageCode: string, locationCode: number): DiscoveryQuery => ({
      keyword: "x", languageCode, locationCode, level: "tile", scopeId: "t", priority: 1,
    });
    const want = [q("de", 2276), q("en", 2250), q("en", 2826)];
    expect(capQueries([q("en", 2826), q("de", 2276), q("en", 2250)], 10).kept).toEqual(want);
    expect(capQueries([q("en", 2250), q("en", 2826), q("de", 2276)], 10).kept).toEqual(want);
  });

  it("capQueries keeps area queries first and reports the rest", () => {
    const q = (level: "area" | "tile", priority: number, keyword: string): DiscoveryQuery => ({
      keyword,
      languageCode: "en",
      locationCode: 2826,
      level,
      scopeId: level === "area" ? "saronic" : TILE,
      priority,
    });
    const tile = Array.from({ length: 240 }, (_, i) => q("tile", (i % 3) + 1, `t${String(i).padStart(3, "0")}`));
    const area = Array.from({ length: 10 }, (_, i) => q("area", 0, `a${i}`));
    const { kept, dropped } = capQueries([...tile, ...area], 240);

    expect(dropped).toBe(10);
    expect(kept).toHaveLength(240);
    expect(kept.filter((k) => k.level === "area")).toHaveLength(10);
    expect(kept.slice(0, 10).every((k) => k.level === "area")).toBe(true);
    // Tile queries by priority, then keyword: the dropped ten are priority 3 with the highest keywords.
    const keptTiles = kept.filter((k) => k.level === "tile");
    expect(keptTiles.filter((k) => k.priority === 3)).toHaveLength(70);
    expect(keptTiles.at(-1)!.keyword).toBe("t209");
    expect(capQueries(area, 240)).toEqual({ kept: area, dropped: 0 });
  });
});
