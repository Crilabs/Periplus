import { eq, inArray } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { withRollback } from "@/test/db";
import { insertNamedObject, insertTestExtractionRun, insertTestRun, insertTestTile, insertTestVersion } from "@/test/text";
import type { RouteStop } from "@/lib/ai/tasks/extract-route";
import { loadConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { geomFromGeoJson } from "@/lib/db/geometry";
import { mentions, places, routes, routeStops } from "@/lib/db/schema";
import { assignStop, routeOpenStops, routeSections, storeRoute } from "@/lib/domain/extraction/routes";
import { tileIdFor } from "@/lib/domain/tiles";

const config = loadConfig("config");

const words = (n: number, word = "sea") => Array.from({ length: n }, () => word).join(" ");
const countWords = (s: string) => s.match(/\S+/g)?.length ?? 0;

const CHUNKS = [
  "We left Ermioni early and anchored in Kolona Bay for the night.",
  "Next morning we sailed 12 nm to Vathy with a NE 4 and moored at the quay.",
  "From Vathy it was a short hop to Poros, where we found a berth in the town.",
];

/** A version with three chunks; Kolona and Vathy (bays) and Ermioni (a town) mentioned where the text names them. */
async function scene(tx: Db) {
  const tile = await insertTestTile(tx, tileIdFor(21.0, 35.2));
  const named = (name: string, type: "bay" | "settlement", lon: number) => insertNamedObject(tx, { type, names: [{ name }], lon, lat: 35.2, tiles: [tile] });
  const kolona = await named("Kolona", "bay", 21.0);
  const vathy = await named("Vathy", "bay", 21.02);
  const ermioni = await named("Ermioni", "settlement", 21.04);
  const v = await insertTestVersion(tx, CHUNKS);
  const mention = async (chunk: number, surface: string, geoObjectId: string, versionId = v.versionId, chunkIds = v.chunkIds) => {
    const at = CHUNKS[chunk]!.indexOf(surface);
    const [m] = await tx
      .insert(mentions)
      .values({
        documentVersionId: versionId,
        chunkId: chunkIds[chunk]!,
        geoObjectId,
        surface,
        charStart: at,
        charEnd: at + surface.length,
        observedAt: "2026-10-19",
        confidence: 1,
        matchKind: "deterministic",
      })
      .returning({ id: mentions.id });
    return m!.id;
  };
  const kolonaMention = await mention(0, "Kolona Bay", kolona);
  const vathyMention = await mention(1, "Vathy", vathy);
  await mention(0, "Ermioni", ermioni);
  const runId = await insertTestRun(tx);
  const extractionRunId = await insertTestExtractionRun(tx, { runId, task: "extract-route" });
  return { ...v, tile, kolona, vathy, ermioni, kolonaMention, vathyMention, runId, extractionRunId, mention };
}

const stop = (s: Partial<RouteStop>): RouteStop => ({ name: "Kolona Bay", date: null, mooring: "anchor", quote: "anchored in Kolona Bay for the night", leg: null, ...s });

const KOLONA = stop({});
const VATHY = stop({
  name: "Vathy",
  mooring: "quay",
  quote: "Next morning we sailed 12 nm to Vathy",
  leg: { distance_nm: 12, duration_h: null, wind_direction: "NE", wind_beaufort: 4, quote: "we sailed 12 nm to Vathy with a NE 4" },
});

const stopsOf = async (tx: Db, versionId: string) =>
  tx
    .select({ ordinal: routeStops.ordinal, name: routeStops.name, geoObjectId: routeStops.geoObjectId, mentionId: routeStops.mentionId, leg: routeStops.leg, mooring: routeStops.mooring, chunk: routeStops.quoteChunkId })
    .from(routeStops)
    .innerJoin(routes, eq(routes.id, routeStops.routeId))
    .where(eq(routes.documentVersionId, versionId))
    .orderBy(routeStops.ordinal);

describe("route sections", () => {
  it("a 45,000-word report is split at headings into sections of at most 20,000 words", () => {
    const md = ["# Day 1", words(15000), "## Day 2", words(15000), "## Day 3", words(14991)].join("\n\n");
    expect(countWords(md)).toBe(45000);
    const sections = routeSections(md, 20000);
    expect(sections).toHaveLength(3);
    expect(sections.map((s) => s.split("\n")[0])).toEqual(["# Day 1", "## Day 2", "## Day 3"]);
    for (const s of sections) expect(countWords(s)).toBeLessThanOrEqual(20000);
    expect(sections.map(countWords).reduce((a, b) => a + b)).toBe(45000);

    // up to the limit the whole text is one section; a part without a heading is cut hard by words
    expect(routeSections(md, 45000)).toEqual([md]);
    const plain = routeSections(words(45000), 20000);
    expect(plain.map(countWords)).toEqual([20000, 20000, 5000]);
    // short sections between headings are joined up to the limit
    expect(routeSections(["# A", words(100), "# B", words(100), "#### not a split", words(100), "# C", words(30000)].join("\n\n"), 20000).map(countWords)).toEqual([
      308, 20000, 10002,
    ]);
  });
});

describe("storeRoute", () => {
  it("stops keep their order across sections and get their mentioned place", () =>
    withRollback(async (tx) => {
      const s = await scene(tx);
      const result = await storeRoute(tx, { versionId: s.versionId, extractionRunId: s.extractionRunId, sections: [{ stops: [KOLONA] }, { stops: [VATHY] }] }, config);
      expect(result).toEqual({ stops: 2, dropped: 0, assigned: 2 });
      const stored = await stopsOf(tx, s.versionId);
      expect(stored.map((r) => [r.ordinal, r.name, r.geoObjectId, r.mentionId, r.mooring, r.chunk])).toEqual([
        [0, "Kolona Bay", s.kolona, s.kolonaMention, "anchor", s.chunkIds[0]],
        [1, "Vathy", s.vathy, s.vathyMention, "quay", s.chunkIds[1]],
      ]);
      expect(stored[1]!.leg).toEqual({
        distance_nm: 12,
        duration_h: null,
        wind_direction: "NE",
        wind_beaufort: 4,
        quote: "we sailed 12 nm to Vathy with a NE 4",
        quote_chunk_id: s.chunkIds[1],
      });
      const [route] = await tx.select().from(routes).where(eq(routes.documentVersionId, s.versionId));
      expect(route).toMatchObject({ extractionRunId: s.extractionRunId, stopsCount: 2 });

      // a later version that carries the chunk over: Vathy's mention sits on the origin chunk only
      const later = await insertTestVersion(tx, CHUNKS, { documentId: s.documentId, carried: { 1: s.chunkIds[1]! } });
      expect(await assignStop(tx, later.versionId, "Vathy", config)).toEqual({ geoObjectId: s.vathy, mentionId: s.vathyMention });
      // a name of an object the version does not mention is not assigned
      expect(await assignStop(tx, later.versionId, "Kolona", config)).toBeNull();
    }));

  it("a stop without a verifiable quote is dropped, an unknown name stays unassigned", () =>
    withRollback(async (tx) => {
      const s = await scene(tx);
      const fabricated = stop({ name: "Kolona", quote: "we anchored in lovely Kolona" });
      const poros = stop({ name: "Poros", mooring: "quay", quote: "a short hop to Poros, where we found a berth" });
      const longName = stop({ name: "x".repeat(81), quote: "anchored in Kolona Bay for the night" });
      const result = await storeRoute(tx, { versionId: s.versionId, extractionRunId: s.extractionRunId, sections: [{ stops: [fabricated, KOLONA, longName, poros] }] }, config);
      expect(result).toEqual({ stops: 2, dropped: 2, assigned: 1 });
      expect((await stopsOf(tx, s.versionId)).map((r) => [r.ordinal, r.name, r.geoObjectId])).toEqual([
        [0, "Kolona Bay", s.kolona],
        [1, "Poros", null],
      ]);
      // a route without any verifiable stop is not stored
      const other = await insertTestVersion(tx, CHUNKS);
      expect(await storeRoute(tx, { versionId: other.versionId, extractionRunId: s.extractionRunId, sections: [{ stops: [fabricated] }, { stops: [] }] }, config)).toEqual({
        stops: 0,
        dropped: 1,
        assigned: 0,
      });
      expect(await tx.select().from(routes).where(eq(routes.documentVersionId, other.versionId))).toHaveLength(0);
    }));

  it("a leg without verifiable quote is removed, the stop stays", () =>
    withRollback(async (tx) => {
      const s = await scene(tx);
      const noLegQuote = { ...VATHY, leg: { ...VATHY.leg!, quote: "we had a splendid sail of 12 nm" } };
      const nullLegQuote = stop({ name: "Poros", quote: "a short hop to Poros, where we found a berth", leg: { distance_nm: 3, duration_h: 1, wind_direction: null, wind_beaufort: 13, quote: null } });
      const kolona = stop({ date: "2026-07-02", leg: { distance_nm: -1, duration_h: 2, wind_direction: null, wind_beaufort: 15, quote: "We left Ermioni early" } });
      const result = await storeRoute(tx, { versionId: s.versionId, extractionRunId: s.extractionRunId, sections: [{ stops: [kolona, noLegQuote, nullLegQuote] }] }, config);
      expect(result).toEqual({ stops: 3, dropped: 0, assigned: 2 });
      const stored = await stopsOf(tx, s.versionId);
      expect(stored.map((r) => [r.name, r.leg])).toEqual([
        // implausible numbers become null, the leg with its quote stays
        ["Kolona Bay", { distance_nm: null, duration_h: 2, wind_direction: null, wind_beaufort: null, quote: "We left Ermioni early", quote_chunk_id: s.chunkIds[0] }],
        ["Vathy", null],
        ["Poros", null],
      ]);
      const [first] = await tx.select({ date: routeStops.date }).from(routeStops).innerJoin(routes, eq(routes.id, routeStops.routeId)).where(eq(routes.documentVersionId, s.versionId)).orderBy(routeStops.ordinal);
      expect(first!.date).toBe("2026-07-02");
    }));

  it("storing twice keeps one route", () =>
    withRollback(async (tx) => {
      const s = await scene(tx);
      const input = { versionId: s.versionId, extractionRunId: s.extractionRunId, sections: [{ stops: [KOLONA, VATHY] }] };
      expect(await storeRoute(tx, input, config)).toEqual({ stops: 2, dropped: 0, assigned: 2 });
      expect(await storeRoute(tx, input, config)).toEqual({ stops: 2, dropped: 0, assigned: 2 });
      expect(await tx.select().from(routes).where(eq(routes.documentVersionId, s.versionId))).toHaveLength(1);
      expect(await stopsOf(tx, s.versionId)).toHaveLength(2);
    }));

  it("route completeness counts only stops at confirmed places", () =>
    withRollback(async (tx) => {
      const s = await scene(tx);
      const place = (geoObjectId: string, status: "confirmed" | "candidate") =>
        tx.insert(places).values({ geoObjectId, kind: "anchorage", status, position: geomFromGeoJson({ type: "Point", coordinates: [21.0, 35.2] }) });
      await place(s.kolona, "confirmed");
      await place(s.vathy, "confirmed");
      await storeRoute(tx, { versionId: s.versionId, extractionRunId: s.extractionRunId, sections: [{ stops: [KOLONA, VATHY] }] }, config);
      // a second report of the same run: one stop at a candidate place, one unassigned
      const other = await insertTestVersion(tx, CHUNKS);
      const ermioni = await insertNamedObject(tx, { type: "bay", names: [{ name: "Ermioni Bay" }], lon: 21.05, lat: 35.2, tiles: [s.tile] });
      await place(ermioni, "candidate");
      await s.mention(0, "Ermioni", ermioni, other.versionId, other.chunkIds);
      const poros = stop({ name: "Poros", quote: "a short hop to Poros, where we found a berth" });
      await storeRoute(tx, { versionId: other.versionId, extractionRunId: s.extractionRunId, sections: [{ stops: [stop({ name: "Ermioni", quote: "We left Ermioni early and anchored" }), KOLONA, poros] }] }, config);
      const otherStops = await stopsOf(tx, other.versionId);
      expect(otherStops.map((r) => r.geoObjectId)).toEqual([ermioni, null, null]);
      expect(await routeOpenStops(tx, { runId: s.runId })).toEqual({ routes: 2, complete: 1, openStops: 3 });
      // other runs do not count
      expect(await routeOpenStops(tx, { runId: await insertTestRun(tx) })).toEqual({ routes: 0, complete: 0, openStops: 0 });
      expect(await tx.select().from(routeStops).where(inArray(routeStops.geoObjectId, [s.kolona]))).toHaveLength(1);
    }));
});
