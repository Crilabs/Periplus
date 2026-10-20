import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { loadConfig, type AppConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { serpQueries, serpResults, sources } from "@/lib/db/schema";
import { addNames } from "@/lib/domain/gazetteer/names";
import { tileIdFor } from "@/lib/domain/tiles";
import { withRollback } from "@/test/db";
import { insertNamedObject, insertTestSubdivision, insertTestTile, insertTestVersion, type TestNamedObject } from "@/test/text";
import { candidateTiles, withNeighbours } from "../scope";

/*
 * Candidate tiles of a document (spec 06 over spec 14): areas reach tiles via `tile_geo_objects`, the admin region of a
 * subdivision stands for its scope tiles, countries and seas for none, and the fallback is the scope of the active
 * subdivisions. Synthetic objects around 21.0-21.5° E / 35.0-35.25° N (outside the pilot box), always in withRollback.
 */

const config: AppConfig = loadConfig("config");
const A = tileIdFor(21.1, 35.1);
const B = tileIdFor(21.3, 35.1);
const C = tileIdFor(21.6, 35.1);
const BOX: [number, number, number, number] = [21.0, 35.0, 21.5, 35.25]; // tiles A and B, not C

const at = (tile: string): Pick<TestNamedObject, "lon" | "lat" | "tiles"> => {
  const col = Number(tile.split(":")[1]);
  return { lon: col * 0.25 - 180 + 0.1, lat: 35.1, tiles: [tile] };
};

/** A subdivision over tiles A and B whose admin region is named `regionName`; tiles A, B (labelled) and C (not). */
async function scene(tx: Db, key: string, regionName: string): Promise<{ subdivisionId: string; regionId: string }> {
  const sub = await insertTestSubdivision(tx, key, BOX);
  await addNames(tx, sub.geoObjectId, [{ name: regionName, language: "en", origin: "manual", isPreferred: true }]);
  for (const t of [A, B]) await insertTestTile(tx, t, null, sub.id);
  await insertTestTile(tx, C);
  return { subdivisionId: sub.id, regionId: sub.geoObjectId };
}

const ctxOf = (subdivisionKeys: string[] = []) => ({ nameAffixes: config.nameAffixes, subdivisionKeys });

describe("candidateTiles", () => {
  it("prepass hit on an area yields its tile_geo_objects tiles", () =>
    withRollback(async (tx) => {
      // the area touches tile A only (tile_geo_objects); tile C is just another tile
      await insertTestTile(tx, A);
      await insertTestTile(tx, C);
      await insertNamedObject(tx, { type: "area", names: [{ name: "Zorbarevier" }], lon: 21.1, lat: 35.1, configKey: "xt-zorba", tiles: [A] });
      const v = await insertTestVersion(tx, ["Wir segelten durch das Zorbarevier."]);
      expect(await candidateTiles(tx, v.versionId, config.mentions, ctxOf())).toEqual({ tiles: withNeighbours([A], 1), basis: "prepass" });
    }));

  it("prepass hit on the admin region of a subdivision expands to the subdivision's scope tiles", () =>
    withRollback(async (tx) => {
      await scene(tx, "XT-S1", "Zorbaprovinz");
      const v = await insertTestVersion(tx, ["Die Zorbaprovinz ist ein Törnziel."]);
      expect(await candidateTiles(tx, v.versionId, config.mentions, ctxOf())).toEqual({ tiles: withNeighbours([A, B], 1), basis: "prepass" });
    }));

  it("hits on a country, a sea and an admin region that is no subdivision expand to no tiles", () =>
    withRollback(async (tx) => {
      await scene(tx, "XT-S2", "Zorbaprovinz");
      // all three are linked to tile C in tile_geo_objects (legacy data): the prepass must not follow them
      for (const [type, name] of [["country", "Zorbaland"], ["sea", "Zorbameer"], ["admin_region", "Zorbakreis"]] as const) {
        await insertNamedObject(tx, { type, names: [{ name }], ...at(C) });
        const v = await insertTestVersion(tx, [`Das ${name} ist weit.`]);
        expect(await candidateTiles(tx, v.versionId, config.mentions, ctxOf())).toEqual({ tiles: [], basis: "fallback" });
      }
    }));

  it("the prepass types include country, admin_region and sea", () => {
    expect(config.mentions.prepassTypes).toEqual(expect.arrayContaining(["country", "admin_region", "sea"]));
  });

  it("fallback uses the scope tiles of the given subdivisions and ignores unknown keys", () =>
    withRollback(async (tx) => {
      await scene(tx, "XT-S3", "Zorbaprovinz");
      const v = await insertTestVersion(tx, ["Nichts Bekanntes hier."]);
      expect(await candidateTiles(tx, v.versionId, config.mentions, ctxOf(["XT-S3", "XT-GONE"]))).toEqual({ tiles: [A, B].sort(), basis: "fallback" });
      expect(await candidateTiles(tx, v.versionId, config.mentions, ctxOf())).toEqual({ tiles: [], basis: "fallback" });
    }));

  it("a source found by an area search gets the tiles the area touches", () =>
    withRollback(async (tx) => {
      await insertTestTile(tx, A);
      await insertTestTile(tx, B);
      await insertNamedObject(tx, { type: "area", names: [{ name: "Anderesrevier" }], lon: 21.2, lat: 35.1, configKey: "xt-source-area", tiles: [A, B] });
      const { sourceId } = await insertTestVersion(tx, ["Nichts."]);
      const [src] = await tx.select({ domain: sources.domain }).from(sources).where(eq(sources.id, sourceId));
      const [q] = await tx
        .insert(serpQueries)
        .values({ keyword: "anderesrevier", languageCode: "de", locationCode: 1, depth: 20, level: "area", scopeId: "xt-source-area", rawKey: "serp/x.json", fetchedAt: new Date() })
        .returning({ id: serpQueries.id });
      await tx.insert(serpResults).values({ serpQueryId: q!.id, rank: 1, url: `https://${src!.domain}/a`, urlNormalized: `https://${src!.domain}/a`, domain: src!.domain, title: "t", snippet: "s" });
      const v = await insertTestVersion(tx, ["Nichts Bekanntes hier."], { sourceId });
      expect(await candidateTiles(tx, v.versionId, config.mentions, ctxOf())).toEqual({ tiles: withNeighbours([A, B], 1), basis: "source" });
    }));
});
