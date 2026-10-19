import { and, eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { makeResponse, RetryableHttpError, type HttpRequest, type Transport } from "@/lib/adapters/http";
import { fixtureTransport } from "@/lib/adapters/http-fixtures";
import { haversineM, nominatimViewbox, searchNominatim } from "@/lib/adapters/nominatim";
import { getConfig } from "@/lib/config";
import { externalCalls } from "@/lib/db/schema";
import { newId } from "@/lib/domain/ids";
import { withRollback } from "@/test/db";

const cfg = () => getConfig().extraction.geocode;
// The recorded search (`fixtures:record -- --nominatim "Kolona" q025:813:510`): the tile 23.25–23.5 E × 37.5–37.75 N.
const TILE = "q025:813:510";
const query = { query: "Kolona", tileId: TILE, radiusKm: 20, limit: 5 };

/** Replays the fixtures and remembers every request it was given. */
function spyingFixtures(): { transport: Transport; seen: HttpRequest[] } {
  const replay = fixtureTransport();
  const seen: HttpRequest[] = [];
  return { seen, transport: async (req) => (seen.push(req), replay(req)) };
}

/** A clock one second further at every reading: the one-per-second bucket never makes a test wait. */
function steppingClock(): { now: () => Date } {
  let t = Date.UTC(2031, 0, 1);
  return { now: () => new Date((t += 1000)) };
}

describe("searchNominatim", () => {
  it("builds a bounded viewbox 20 km around the tile and sorts hits by distance", async () => {
    await withRollback(async (tx) => {
      const { transport, seen } = spyingFixtures();
      const hits = await searchNominatim(transport, query, { db: tx, stage: "test" }, cfg(), steppingClock());

      const url = new URL(seen[0]!.url);
      expect(`${url.origin}${url.pathname}`).toBe(cfg().endpoint);
      expect(Object.fromEntries(url.searchParams)).toMatchObject({
        format: "jsonv2",
        q: "Kolona",
        bounded: "1",
        limit: "5",
        "accept-language": "de,en,el",
      });
      const [west, north, east, south] = url.searchParams.get("viewbox")!.split(",").map(Number) as [number, number, number, number];
      const dLat = 20 / 111.32;
      const dLon = 20 / (111.32 * Math.cos((37.625 * Math.PI) / 180));
      expect(west).toBeCloseTo(23.25 - dLon, 4);
      expect(east).toBeCloseTo(23.5 + dLon, 4);
      expect(north).toBeCloseTo(37.75 + dLat, 4);
      expect(south).toBeCloseTo(37.5 - dLat, 4);
      expect(nominatimViewbox(TILE, 20)).toEqual([west, north, east, south]);

      // Nominatim answered the beach first; the archaeological site lies nearer to the tile centre.
      expect(hits.map((h) => h.osmId)).toEqual(["way/378823406", "way/1085552444"]);
      expect(hits[1]).toMatchObject({ name: "Kolona Beach", category: "natural", type: "beach" });
      expect(hits[0]!.distanceM).toBeLessThan(hits[1]!.distanceM);
      expect(hits[1]!.distanceM).toBe(Math.round(haversineM({ lon: 23.375, lat: 37.625 }, { lon: 23.4236954, lat: 37.7518394 })));
      for (const h of hits) {
        expect(h.lon).toBeGreaterThanOrEqual(west);
        expect(h.lon).toBeLessThanOrEqual(east);
        expect(h.lat).toBeGreaterThanOrEqual(south);
        expect(h.lat).toBeLessThanOrEqual(north);
      }
    });
  });

  it("records one external call per request under service nominatim at 60 per minute", async () => {
    await withRollback(async (tx) => {
      const { transport, seen } = spyingFixtures();
      const stage = `test:${newId()}`;
      const runQueries = 2;
      const clock = steppingClock();
      for (let i = 0; i < runQueries; i++) await searchNominatim(transport, query, { db: tx, stage }, cfg(), clock);

      expect(seen).toHaveLength(runQueries);
      for (const req of seen) {
        expect(req).toMatchObject({ service: "nominatim", ratePerMinute: 60, rateKey: "nominatim", rateBurst: 1 });
        expect(req.method ?? "GET").toBe("GET");
        expect(req.headers?.["User-Agent"]).toMatch(/^Periplus\/0\.1 \(\+mailto:.+\)$/);
      }
      const calls = await tx
        .select()
        .from(externalCalls)
        .where(and(eq(externalCalls.service, "nominatim"), eq(externalCalls.stage, stage)));
      expect(calls).toHaveLength(runQueries);
      for (const c of calls) {
        expect(c).toMatchObject({ operation: "search", unit: "request", tileId: TILE });
        expect(Number(c.units)).toBe(1);
        expect(Number(c.costEur)).toBe(0);
        expect(c.meta).toMatchObject({ query: "Kolona", tileId: TILE, status: 200 });
      }
    });
  });

  it("two requests in a row are spaced by a second (usage policy)", async () => {
    await withRollback(async (tx) => {
      // A bucket of its own state: the rate row for `http:nominatim` exists only inside this transaction.
      await tx.execute(sql`delete from rate_limits where key = 'http:nominatim'`);
      const at = Date.UTC(2032, 0, 1);
      const sleeps: number[] = [];
      const deps = { now: () => new Date(at + sleeps.reduce((a, b) => a + b, 0)), sleep: async (ms: number) => void sleeps.push(ms) };
      const { transport } = spyingFixtures();
      await searchNominatim(transport, query, { db: tx }, cfg(), deps);
      await searchNominatim(transport, query, { db: tx }, cfg(), deps);
      expect(sleeps).toEqual([1000]);
    });
  });

  it("an answer that is no result list is retryable", async () => {
    await withRollback(async (tx) => {
      const transport: Transport = async () => makeResponse(200, new TextEncoder().encode("<html>overloaded</html>"));
      await expect(searchNominatim(transport, query, { db: tx }, cfg(), steppingClock())).rejects.toBeInstanceOf(RetryableHttpError);
    });
  });
});
