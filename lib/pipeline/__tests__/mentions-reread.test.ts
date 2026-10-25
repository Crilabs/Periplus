import { describe, expect, it } from "vitest";
import { withRollback } from "@/test/db";
import { insertNamedObject, insertTestRun, insertTestSubdivision, insertTestTile, insertTestVersion } from "@/test/text";
import { loadConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { tileGeoObjects } from "@/lib/db/schema";
import { tileIdFor } from "@/lib/domain/tiles";
import { SUBDIVISION_BUILD_STAGES } from "@/lib/pipeline/subdivision-build";
import { matchVersions } from "@/lib/pipeline/text/mentions";
import { prefilteredVersions, prefilterNames, rereadVersions } from "@/lib/pipeline/text/reread";

/*
 * Spec 14 „Nachlesen beim Start eines Landesteils“, in withRollback with a recording job queue: a trip report found for
 * subdivision A names a gulf and a bay that only B's gazetteer knows; after B's gazetteer the re-read run matches it.
 */

const config = loadConfig("config");

const TILE_A = tileIdFor(52.1, 31.1);
const TILE_B = tileIdFor(53.1, 31.1);

/** Subdivision A with its tile, the gulf (in A) and a report naming gulf and bay; B exists but is not built. */
async function scene(tx: Db) {
  const a = await insertTestSubdivision(tx, "XT-RA", [52.0, 31.0, 52.25, 31.25]);
  const b = await insertTestSubdivision(tx, "XT-RB", [53.0, 31.0, 53.25, 31.25]);
  await insertTestTile(tx, TILE_A, null, a.id);
  const gulf = await insertNamedObject(tx, { type: "gulf", names: [{ name: "Zorbos Gulf" }], lon: 52.1, lat: 31.1, tiles: [TILE_A] });
  const report = await insertTestVersion(tx, ["We sailed across the Zorbos Gulf and anchored in Palmira Bay for the night."]);
  const unrelatedIsland = await insertNamedObject(tx, { type: "island", names: [{ name: "Wolkeninsel" }], lon: 52.15, lat: 31.15, tiles: [TILE_A] });
  const unrelated = await insertTestVersion(tx, ["Rund um Wolkeninsel ist es ruhig."]);
  const runId = await insertTestRun(tx);
  const match = (v: string) => matchVersions(tx, { runId, versionIds: [v] }, config);
  await match(report.versionId);
  await match(unrelated.versionId);
  return { a, b, gulf, unrelatedIsland, report, unrelated, match };
}

/** B's gazetteer: its tile, the bay in it, and the gulf reaching the tile. */
async function buildB(tx: Db, s: Awaited<ReturnType<typeof scene>>) {
  await insertTestTile(tx, TILE_B, null, s.b.id);
  const bay = await insertNamedObject(tx, { type: "bay", names: [{ name: "Palmira Bay" }], lon: 53.1, lat: 31.1, tiles: [TILE_B], subdivisionId: s.b.id });
  await tx.insert(tileGeoObjects).values({ tileId: TILE_B, geoObjectId: s.gulf }).onConflictDoNothing();
  return bay;
}

describe("mentions re-read", () => {
  it("is no stage of the subdivision build any more (N6)", () => {
    expect(([...SUBDIVISION_BUILD_STAGES] as string[]).includes("mentions.reread")).toBe(false);
  });

  it("selects only documents whose prepass touches a tile of the subdivision", () =>
    withRollback(async (tx) => {
      const s = await scene(tx);
      expect(await rereadVersions(tx, "XT-RB", config)).toEqual([]);
      await buildB(tx, s);
      expect(await rereadVersions(tx, "XT-RB", config)).toEqual([s.report.versionId]);
    }));

  it("leaves out pending (never matched) versions", () =>
    withRollback(async (tx) => {
      const s = await scene(tx);
      await buildB(tx, s);
      const pending = await insertTestVersion(tx, ["Noch nicht ausgewertet: Zorbos Gulf."]);
      expect(await rereadVersions(tx, "XT-RB", config)).toEqual([s.report.versionId]);
      await s.match(pending.versionId);
      expect(await rereadVersions(tx, "XT-RB", config)).toEqual([s.report.versionId, pending.versionId].sort());
    }));

  it("takes a document whose prepass tiles only neighbour the subdivision's tile (ring)", () =>
    withRollback(async (tx) => {
      const s = await scene(tx);
      await buildB(tx, s);
      const neighbour = tileIdFor(53.35, 31.1);
      await insertTestTile(tx, neighbour);
      await insertNamedObject(tx, { type: "gulf", names: [{ name: "Kerpa Gulf" }], lon: 53.35, lat: 31.1, tiles: [neighbour] });
      const near = await insertTestVersion(tx, ["Der Kerpa Gulf liegt gleich nebenan."]);
      await s.match(near.versionId);
      expect(await rereadVersions(tx, "XT-RB", config)).toContain(near.versionId);
    }));

  it("prefilters by the names around the subdivision before the prepass (accents, punctuation, greek script folded in)", () =>
    withRollback(async (tx) => {
      const s = await scene(tx);
      await buildB(tx, s);
      const names = await prefilterNames(tx, [TILE_B], config);
      expect(names).toEqual(expect.arrayContaining(["zorbos gulf"]));
      expect(names).not.toContain("palmira bay"); // a bay is no prepass type
      expect(names).not.toContain("wolkeninsel");
      const accent = await insertTestVersion(tx, ["Im Zórbos-Gulf, dann weiter."]);
      for (const [name, text] of [["Muğla", "Hafen von Muğla im Süden"], ["Ċirkewwa", "Die Fähre ab Ċirkewwa fährt oft"], ["Ġnejna", "Ankern in Ġnejna Bay"]] as const) {
        await insertNamedObject(tx, { type: "island", names: [{ name }], lon: 53.1, lat: 31.1, tiles: [TILE_B] });
        const v = await insertTestVersion(tx, [text]);
        await s.match(v.versionId);
        expect(await prefilteredVersions(tx, await prefilterNames(tx, [TILE_B], config))).toContain(v.versionId);
      }
      const greek = await insertTestVersion(tx, ["Ο κόλπος."]);
      const plainText = await insertTestVersion(tx, ["Nothing about any known place here."]);
      for (const v of [accent, greek, plainText]) await s.match(v.versionId);
      const kept = await prefilteredVersions(tx, names);
      expect(kept).toEqual(expect.arrayContaining([s.report.versionId, accent.versionId, greek.versionId]));
      expect(kept).not.toContain(s.unrelated.versionId);
      expect(kept).not.toContain(plainText.versionId);
    }));
});
