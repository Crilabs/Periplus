import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { makeResponse, type HttpRequest, type Transport } from "@/lib/adapters/http";
import { MockModel } from "@/lib/ai/mock";
import type { CheckPlaceWebsiteInput } from "@/lib/ai/tasks/check-place-website";
import type { Db } from "@/lib/db/client";
import { geomFromGeoJson } from "@/lib/db/geometry";
import { geoObjects, placeWebsites, places, reviewTasks, serpQueries, sources, type PlaceKind, type PlaceStatus } from "@/lib/db/schema";
import { newId } from "@/lib/domain/ids";
import { acceptWebsiteCheck, findPlaceWebsite, placesNeedingWebsite } from "@/lib/domain/places/website-find";
import { DEFAULT_CRAWL_RULES } from "@/lib/domain/sources/crawl-rules";
import { tileIdFor } from "@/lib/domain/tiles";
import { withRollback } from "@/test/db";
import { memoryArchive } from "@/test/s3";
import { insertNamedObject, insertTestRun, insertTestSubdivision, insertTestTile } from "@/test/text";

/*
 * Spec 16 C, „Herkunft der Adresse“ and „Ist das die Website dieses Ortes?“: a known OSM/Wikidata address wins without
 * search; otherwise the Google search (DataForSEO through a fixture transport) and the model check (MockModel) pick
 * the first hit that is the place's own site. Synthetic objects at 27.1° E / 34.1° N (outside the pilot box).
 */

const SUB = "XT-PW1";
const LON = 27.1;
const LAT = 34.1;
const TILE = tileIdFor(LON, LAT);

async function setup(tx: Db) {
  const sub = await insertTestSubdivision(tx, SUB, [27.0, 34.0, 27.5, 34.25]);
  await insertTestTile(tx, TILE, null, sub.id);
  const island = await insertNamedObject(tx, { type: "island", names: [{ name: "Testisland" }], lon: LON, lat: LAT, subdivisionId: sub.id });
  return { subdivisionId: sub.id, islandId: island, runId: await insertTestRun(tx) };
}

async function insertMarina(
  tx: Db,
  s: { subdivisionId: string; islandId: string },
  o: { name?: string; kind?: PlaceKind; status?: PlaceStatus; tags?: Record<string, string>; websiteWikidata?: string } = {},
) {
  const geoObjectId = await insertNamedObject(tx, {
    type: "harbour",
    names: [{ name: o.name ?? "Alpha" }],
    lon: LON,
    lat: LAT,
    parentId: s.islandId,
    subdivisionId: s.subdivisionId,
  });
  if (o.tags || o.websiteWikidata) {
    await tx
      .update(geoObjects)
      .set({ tags: o.tags ?? {}, websiteWikidata: o.websiteWikidata ?? null })
      .where(eq(geoObjects.id, geoObjectId));
  }
  const [p] = await tx
    .insert(places)
    .values({
      geoObjectId,
      kind: o.kind ?? "marina",
      status: o.status ?? "candidate",
      position: geomFromGeoJson({ type: "Point", coordinates: [LON, LAT] }),
    })
    .returning({ id: places.id });
  return { placeId: p!.id, geoObjectId };
}

type Item = { url: string; title?: string };

/** One DataForSEO answer with organic `items` (rank = position). */
function serpAnswer(items: Item[]): Uint8Array {
  const answer = {
    status_code: 20000,
    status_message: "Ok.",
    tasks: [
      {
        status_code: 20000,
        status_message: "Ok.",
        result: [
          {
            items: items.map((it, i) => ({
              type: "organic",
              rank_absolute: i + 1,
              url: it.url,
              title: it.title ?? `Result ${i + 1}`,
              description: `Snippet ${i + 1}`,
            })),
          },
        ],
      },
    ],
  };
  return new TextEncoder().encode(JSON.stringify(answer));
}

/** SERP answers with `items`, pages by URL (HTML), robots.txt 404 (all allowed), everything else 404. */
function fakeWeb(items: Item[], pages: Record<string, string>): Transport & { requests: HttpRequest[] } {
  const requests: HttpRequest[] = [];
  const transport = (async (req: HttpRequest) => {
    requests.push(req);
    if (req.service === "dataforseo") return makeResponse(200, serpAnswer(items));
    const page = pages[req.url];
    if (page !== undefined) return makeResponse(200, new TextEncoder().encode(page), { headers: { "content-type": "text/html; charset=utf-8" } });
    return makeResponse(404, new Uint8Array());
  }) as Transport & { requests: HttpRequest[] };
  transport.requests = requests;
  return transport;
}

const html = (title: string, body: string) => `<html><head><title>${title}</title></head><body><main><h1>${title}</h1><p>${body}</p></main></body></html>`;

const serpCalls = (t: { requests: HttpRequest[] }) => t.requests.filter((r) => r.service === "dataforseo");

describe("placesNeedingWebsite", () => {
  it("lists valid, unmerged marinas and ports that are candidates or confirmed and have no website yet", () =>
    withRollback(async (tx) => {
      const s = await setup(tx);
      const candidate = await insertMarina(tx, s, { name: "Alpha" });
      const port = await insertMarina(tx, s, { name: "Beta", kind: "port", status: "confirmed" });
      await insertMarina(tx, s, { name: "Gamma", kind: "anchorage" });
      await insertMarina(tx, s, { name: "Delta", status: "rejected" });
      const withSite = await insertMarina(tx, s, { name: "Epsilon" });
      await tx.insert(placeWebsites).values({
        placeId: withSite.placeId,
        geoObjectId: withSite.geoObjectId,
        url: "https://epsilon.example/",
        urlNormalized: "https://epsilon.example/",
        origin: "osm",
        bound: false,
      });
      const ended = await insertMarina(tx, s, { name: "Zeta" });
      await tx.update(places).set({ validTo: "2026-01-01", validFrom: "2020-01-01" }).where(eq(places.id, ended.placeId));

      const listed = await placesNeedingWebsite(tx, SUB);
      expect(listed.map((p) => p.placeId).sort()).toEqual([candidate.placeId, port.placeId].sort());
      expect(listed).toContainEqual({ placeId: candidate.placeId, geoObjectId: candidate.geoObjectId });
    }));
});

describe("findPlaceWebsite", () => {
  it("takes a known OSM website without search or model", () =>
    withRollback(async (tx) => {
      const s = await setup(tx);
      const place = await insertMarina(tx, s, { tags: { website: "https://www.alpha-marina.example/" } });
      const web = fakeWeb([], {});
      const model = new MockModel({});
      const found = await findPlaceWebsite(tx, place, { transport: web, archive: memoryArchive(), model, isAllowed: async () => true }, { runId: s.runId, tileId: TILE });
      expect(found).toEqual({ outcome: "known", url: "https://www.alpha-marina.example/", origin: "osm" });
      expect(web.requests).toHaveLength(0);
    }));

  it("searches without a known address: the model rejects the neighbour marina and accepts the place's own site", () =>
    withRollback(async (tx) => {
      const s = await setup(tx);
      const place = await insertMarina(tx, s);
      const blog = `blog-${newId()}.example`;
      await tx.insert(sources).values({
        domain: blog,
        name: blog,
        type: "trip_report",
        weight: 0.6,
        status: "approved",
        crawlRules: DEFAULT_CRAWL_RULES,
        origin: "manual",
      });
      const neighbour = `https://www.beta-marina-${newId()}.example/`;
      const own = `https://www.alpha-marina-${newId()}.example/`;
      const web = fakeWeb(
        [{ url: "https://navily.com/port/alpha" }, { url: `https://www.${blog}/2024/alpha` }, { url: neighbour }, { url: own }],
        {
          [neighbour]: html("Beta Marina", "Welcome to Beta Marina, the neighbour of Alpha. Berths for 200 boats."),
          [own]: html("Alpha Marina", "Welcome to Alpha Marina on Testisland. Diesel and fresh water at the fuel dock."),
        },
      );
      const inputs: CheckPlaceWebsiteInput[] = [];
      const model = new MockModel({
        "check-place-website": (input) => {
          const i = input as CheckPlaceWebsiteInput;
          inputs.push(i);
          return i.url === neighbour
            ? { isOwnSite: false, quote: "Welcome to Beta Marina", confidence: 0.9 }
            : { isOwnSite: true, quote: "Welcome to Alpha Marina on Testisland.", confidence: 0.95 };
        },
      });
      const found = await findPlaceWebsite(tx, place, { transport: web, archive: memoryArchive(), model, isAllowed: async () => true }, { runId: s.runId, tileId: TILE });
      expect(found).toMatchObject({ outcome: "serp", url: own, origin: "serp", quote: "Welcome to Alpha Marina on Testisland.", confidence: 0.95 });
      expect(found.serpQueryId).toBeDefined();
      // the ignored and the blog domain are never fetched or checked; the neighbour first, then the own site
      expect(inputs.map((i) => i.url)).toEqual([neighbour, own]);
      expect(inputs[1]).toMatchObject({ names: ["Alpha"], island: "Testisland", kindProposal: "marina", lat: LAT, lon: LON });
      expect(inputs[1]!.pageText).toContain("Diesel and fresh water");
      const queries = await tx
        .select({ keyword: serpQueries.keyword, level: serpQueries.level, scopeId: serpQueries.scopeId })
        .from(serpQueries)
        .where(eq(serpQueries.scopeId, place.geoObjectId));
      expect(queries.map((q) => q.keyword).sort()).toEqual(["Alpha Testisland marina", "Alpha marina"]);
      expect(queries.every((q) => q.level === "place_website")).toBe(true);
    }));

  it("rejects an accepted hit whose quote is not on the page", () =>
    withRollback(async (tx) => {
      const s = await setup(tx);
      const place = await insertMarina(tx, s);
      const own = `https://www.alpha-${newId()}.example/`;
      const web = fakeWeb([{ url: own }], { [own]: html("Alpha Marina", "Welcome to Alpha Marina.") });
      const model = new MockModel({ "check-place-website": () => ({ isOwnSite: true, quote: "Alpha Marina, the best of all", confidence: 0.99 }) });
      const found = await findPlaceWebsite(tx, place, { transport: web, archive: memoryArchive(), model, isAllowed: async () => true }, { runId: s.runId, tileId: TILE });
      expect(found).toEqual({ outcome: "none" });
    }));

  it("without an accepted hit: none, no review task, and no second search within retryDays", () =>
    withRollback(async (tx) => {
      const s = await setup(tx);
      const place = await insertMarina(tx, s);
      const hit = `https://www.charter-${newId()}.example/`;
      const web = fakeWeb([{ url: hit }], { [hit]: html("Charter", "Yacht charter from Alpha.") });
      const model = new MockModel({ "check-place-website": () => ({ isOwnSite: false, quote: "", confidence: 0.9 }) });
      const deps = { transport: web, archive: memoryArchive(), model, isAllowed: async () => true };
      const tasksBefore = (await tx.select({ id: reviewTasks.id }).from(reviewTasks)).length;
      expect(await findPlaceWebsite(tx, place, deps, { runId: s.runId, tileId: TILE })).toEqual({ outcome: "none" });
      expect((await tx.select({ id: reviewTasks.id }).from(reviewTasks)).length).toBe(tasksBefore);
      const searched = serpCalls(web).length;
      expect(searched).toBeGreaterThan(0);

      // a retried job of the same run searches again (the SERP reuse answers it), another run within retryDays does not
      expect(await findPlaceWebsite(tx, place, deps, { runId: s.runId, tileId: TILE })).toEqual({ outcome: "none" });
      expect(serpCalls(web)).toHaveLength(searched);
      expect(await findPlaceWebsite(tx, place, deps, { runId: await insertTestRun(tx), tileId: TILE })).toEqual({ outcome: "searched_recently" });
      expect(serpCalls(web)).toHaveLength(searched);
    }));
});

describe("acceptWebsiteCheck", () => {
  const page = "# Alpha Marina\n\nWelcome to **Alpha Marina** on Testisland.";
  const ok = { isOwnSite: true, quote: "Welcome to Alpha Marina on Testisland.", confidence: 0.9 };
  it("accepts a confident yes whose quote is on the page and names the place", () => {
    expect(acceptWebsiteCheck(ok, page, ["Alpha"], 0.8)).toBe(true);
    expect(acceptWebsiteCheck({ ...ok, quote: "welcome to alpha marina on testisland." }, page, ["Alpha"], 0.8)).toBe(false);
  });
  it("rejects a no, a low confidence, an empty quote and a quote without the place's name", () => {
    expect(acceptWebsiteCheck({ ...ok, isOwnSite: false }, page, ["Alpha"], 0.8)).toBe(false);
    expect(acceptWebsiteCheck({ ...ok, confidence: 0.79 }, page, ["Alpha"], 0.8)).toBe(false);
    expect(acceptWebsiteCheck({ ...ok, quote: "" }, page, ["Alpha"], 0.8)).toBe(false);
    expect(acceptWebsiteCheck({ ...ok, quote: "on Testisland." }, page, ["Alpha"], 0.8)).toBe(false);
    expect(acceptWebsiteCheck(ok, page, ["Álpha"], 0.8)).toBe(true);
  });
});
