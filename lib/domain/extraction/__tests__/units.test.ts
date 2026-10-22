import { describe, expect, it } from "vitest";
import { withRollback } from "@/test/db";
import { insertTestGeoObject, insertTestVersion } from "@/test/text";
import { loadConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { mentions, type GeoObjectType } from "@/lib/db/schema";
import { planUnits } from "@/lib/domain/extraction/units";

const config = loadConfig("config");
const UNIT = config.extraction.unit;

/** A version with `n` chunks ("Chunk 0." …) and a geo object of `type`. */
async function scene(tx: Db, n: number, type: GeoObjectType = "bay") {
  const v = await insertTestVersion(tx, Array.from({ length: n }, (_, i) => `Chunk ${i} mentions the place.`));
  const geoObjectId = await insertTestGeoObject(tx, { type });
  return { ...v, geoObjectId };
}

/** One mention of the object at the start of each given chunk ordinal; returns their ids in that order. */
async function mentionAt(tx: Db, s: Awaited<ReturnType<typeof scene>>, ordinals: number[]): Promise<string[]> {
  const ids: string[] = [];
  for (const o of ordinals) {
    const [row] = await tx
      .insert(mentions)
      .values({
        documentVersionId: s.versionId,
        chunkId: s.chunkIds[o]!,
        geoObjectId: s.geoObjectId,
        surface: "Chunk",
        charStart: 0,
        charEnd: 5,
        observedAt: "2026-10-19",
        confidence: 1,
        matchKind: "deterministic",
      })
      .returning({ id: mentions.id });
    ids.push(row!.id);
  }
  return ids;
}

describe("planUnits", () => {
  it("three mentions of one place in a version form one unit with neighbour chunks", () =>
    withRollback(async (tx) => {
      const s = await scene(tx, 10);
      const ids = await mentionAt(tx, s, [5, 4, 6]);
      const { units, skipped } = await planUnits(tx, ids, UNIT);
      expect(skipped).toEqual([]);
      expect(units).toEqual([
        {
          documentVersionId: s.versionId,
          geoObjectId: s.geoObjectId,
          part: 0,
          level: "place",
          mentionIds: [ids[1], ids[0], ids[2]],
          chunkIds: s.chunkIds.slice(3, 8),
        },
      ]);
    }));

  it("a unit with more than 6 chunks is split into parts", () =>
    withRollback(async (tx) => {
      const s = await scene(tx, 12);
      const ids = await mentionAt(tx, s, [1, 3, 5, 7, 9]);
      const { units } = await planUnits(tx, ids, UNIT);
      // chunks 0..10 (11 chunks) → parts of at most 6 that share two boundary chunks (ruling M4-G-R4)
      expect(units.map((u) => u.part)).toEqual([0, 1, 2]);
      expect(units[0]!.chunkIds).toEqual(s.chunkIds.slice(0, 6));
      expect(units[0]!.mentionIds).toEqual(ids.slice(0, 2));
      expect(units[1]!.chunkIds).toEqual(s.chunkIds.slice(4, 10));
      expect(units[1]!.mentionIds).toEqual(ids.slice(2, 4));
      expect(units[2]!.chunkIds).toEqual(s.chunkIds.slice(8, 11));
      expect(units[2]!.mentionIds).toEqual(ids.slice(4));
      for (const u of units) expect(u.chunkIds.length).toBeLessThanOrEqual(UNIT.maxChunksPerUnit);
    }));

  it("a mention at a part boundary keeps its neighbour chunks in its part", () =>
    withRollback(async (tx) => {
      // chunks 0..8: mentions at 1 and 7 span ordinals 0..8; a plain cut after 6 chunks would part 6 from 5 or 7
      const s = await scene(tx, 9);
      const ids = await mentionAt(tx, s, [1, 5, 7]);
      const { units } = await planUnits(tx, ids, UNIT);
      expect(units.flatMap((u) => u.mentionIds).sort()).toEqual([...ids].sort());
      for (const [i, o] of [1, 5, 7].entries()) {
        const unit = units.find((u) => u.mentionIds.includes(ids[i]!))!;
        for (const n of [o - 1, o, o + 1]) expect(unit.chunkIds, `mention at ${o}, chunk ${n}`).toContain(s.chunkIds[n]);
      }
    }));

  it("a mention of a settlement without place is skipped", () =>
    withRollback(async (tx) => {
      const town = await scene(tx, 3, "settlement");
      const townIds = await mentionAt(tx, town, [1]);
      const bay = await scene(tx, 3, "bay");
      const bayIds = await mentionAt(tx, bay, [0]);
      const { units, skipped } = await planUnits(tx, [...townIds, ...bayIds], UNIT);
      expect(skipped).toEqual(townIds);
      expect(units.map((u) => [u.geoObjectId, u.chunkIds])).toEqual([[bay.geoObjectId, bay.chunkIds.slice(0, 2)]]);
    }));

  it("mentions of two objects in one version form two units; one object in two versions too", () =>
    withRollback(async (tx) => {
      const s = await scene(tx, 4);
      const a = await mentionAt(tx, s, [0]);
      const other = await insertTestGeoObject(tx, { type: "island" });
      const b = await mentionAt(tx, { ...s, geoObjectId: other }, [3]);
      const { units } = await planUnits(tx, [...a, ...b], UNIT);
      expect(units.map((u) => [u.geoObjectId, u.level, u.chunkIds]).sort()).toEqual(
        [
          [s.geoObjectId, "place", s.chunkIds.slice(0, 2)],
          [other, "island", s.chunkIds.slice(2, 4)],
        ].sort(),
      );
    }));

  it("a group with a bound mention takes every chunk of the version, in parts of maxChunksPerUnit", () =>
    withRollback(async (tx) => {
      const s = await scene(tx, 8);
      const ids: string[] = [];
      for (const chunkId of s.chunkIds) {
        const [row] = await tx
          .insert(mentions)
          .values({
            documentVersionId: s.versionId,
            chunkId,
            geoObjectId: s.geoObjectId,
            surface: "",
            charStart: 0,
            charEnd: 0,
            observedAt: "2026-10-19",
            confidence: 1,
            matchKind: "bound",
          })
          .returning({ id: mentions.id });
        ids.push(row!.id);
      }
      const { units } = await planUnits(tx, ids, UNIT);
      expect(units).toHaveLength(2);
      expect(units[0]!.chunkIds).toEqual(s.chunkIds.slice(0, 6));
      expect(units[1]!.chunkIds).toEqual(s.chunkIds.slice(4, 8));
      expect(units.flatMap((u) => u.mentionIds).sort()).toEqual([...ids].sort());
    }));

  it("a bound and a name mention of one object share one unit group; a single bound mention covers the whole version", () =>
    withRollback(async (tx) => {
      const s = await scene(tx, 8);
      const [name] = await mentionAt(tx, s, [1]);
      const [bound] = await tx
        .insert(mentions)
        .values({
          documentVersionId: s.versionId,
          chunkId: s.chunkIds[6]!,
          geoObjectId: s.geoObjectId,
          surface: "",
          charStart: 0,
          charEnd: 0,
          observedAt: "2026-10-19",
          confidence: 1,
          matchKind: "bound",
        })
        .returning({ id: mentions.id });
      const { units } = await planUnits(tx, [name!, bound!.id], UNIT);
      expect(units.map((u) => u.chunkIds)).toEqual([s.chunkIds.slice(0, 6), s.chunkIds.slice(4, 8)]);
      expect(units.flatMap((u) => u.mentionIds).sort()).toEqual([name!, bound!.id].sort());
    }));
});
