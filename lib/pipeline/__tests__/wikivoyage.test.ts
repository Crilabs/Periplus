import { and, eq, inArray, sql } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import { describe, expect, it, vi } from "vitest";
import { createConverters } from "@/lib/adapters/fetch";
import { makeResponse, type HttpRequest, type Transport } from "@/lib/adapters/http";
import { fixtureTransport } from "@/lib/adapters/http-fixtures";
import { runPdftotext } from "@/lib/adapters/pdf";
import { areaByKey, getConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { geomFromGeoJson } from "@/lib/db/geometry";
import { crawlFrontier, documents, documentVersions, geoObjects, runs, sources, tileGeoObjects, tiles } from "@/lib/db/schema";
import { syncAreas } from "@/lib/domain/gazetteer/areas";
import { newId } from "@/lib/domain/ids";
import { createRun } from "@/lib/domain/runs";
import { getSource, ensureWhitelistSources, setSourceStatus, sourceIdByDomain } from "@/lib/domain/sources/store";
import { tileBbox, tileIdFor } from "@/lib/domain/tiles";
import { STAGES } from "@/lib/jobs/stages";
import { FETCH_RUN_STAGES, startWikivoyageRun } from "@/lib/pipeline/fetch/run";
import { fetchUrl } from "@/lib/pipeline/fetch/url";
import { seedWikivoyage, WIKIVOYAGE_DOMAIN, WIKIVOYAGE_STAGE } from "@/lib/pipeline/sources/wikivoyage";
import { withRollback } from "@/test/db";
import { memoryArchive } from "@/test/s3";
import { WIKIVOYAGE_RECORDING_ITEMS } from "@/scripts/fixtures-record";

// The synthetic area "wikivoyage-test" (languages of the recorded area saronic) joins the configured areas; Wikidata
// calls are not rate limited here. Everything else is the real config.
vi.mock("@/lib/config", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/config")>();
  const base = original.getConfig();
  const saronic = base.areas.find((a) => a.key === "saronic")!;
  const testArea = {
    ...saronic,
    key: "wikivoyage-test",
    names: { de: "Wikivoyage-Test", en: "Wikivoyage Test", el: "Δοκιμή" },
    polygon: { type: "Polygon" as const, coordinates: [[[31, 34], [31.5, 34], [31.5, 34.25], [31, 34.25], [31, 34]]] },
    tileBbox: [31, 34, 31.5, 34.25] as [number, number, number, number],
    coastSections: [],
  };
  const config = {
    ...base,
    areas: [...base.areas, testArea],
    gazetteer: { ...base.gazetteer, wikidata: { ...base.gazetteer.wikidata, ratePerMinute: 1_000_000 } },
  };
  return {
    ...original,
    getConfig: () => config,
    areaByKey: (key: string) => {
      const found = config.areas.find((a) => a.key === key);
      if (!found) throw new Error(`Unknown area ${key}`);
      return found;
    },
  };
});

// Synthetic tiles in open sea outside the pilot box 23.0-23.75 E x 37.0-38.0 N, at spots no other test uses.
const AREA_KEY = "wikivoyage-test";
const TILE_A = tileIdFor(31.1, 34.1);
const TILE_B = tileIdFor(31.3, 34.1);
const AEGINA = WIKIVOYAGE_RECORDING_ITEMS[0]!;
const ARTICLES = [
  "https://de.wikivoyage.org/wiki/%C3%84gina",
  "https://el.wikivoyage.org/wiki/%CE%91%CE%AF%CE%B3%CE%B9%CE%BD%CE%B1",
  "https://en.wikivoyage.org/wiki/Aegina",
];

async function insertTile(tx: Db, id: string, areaId: string): Promise<void> {
  const [w, s, e, n] = tileBbox(id);
  await tx.insert(tiles).values({ id, bbox: sql`ST_MakeEnvelope(${w}, ${s}, ${e}, ${n}, 4326)`, areaId, hasCoast: true });
}

async function insertObject(tx: Db, tileId: string, type: "island" | "islet" | "bay", wikidataId: string | null): Promise<void> {
  const [o] = await tx
    .insert(geoObjects)
    .values({ type, origin: "wikidata", wikidataId, geom: geomFromGeoJson({ type: "Point", coordinates: [31.2, 34.1] }) })
    .returning({ id: geoObjects.id });
  await tx.insert(tileGeoObjects).values({ tileId, geoObjectId: o!.id });
}

/** The area object and its two tiles; tile A holds `objects`. */
async function seedArea(tx: Db, objects: Array<{ type: "island" | "islet" | "bay"; wikidataId: string | null }>): Promise<void> {
  const areaId = (await syncAreas(tx, [areaByKey(AREA_KEY)])).get(AREA_KEY)!;
  await insertTile(tx, TILE_A, areaId);
  await insertTile(tx, TILE_B, areaId);
  for (const o of objects) await insertObject(tx, TILE_A, o.type, o.wikidataId);
}

async function wikivoyageSource(tx: Db): Promise<string> {
  await ensureWhitelistSources(tx);
  return (await sourceIdByDomain(tx, WIKIVOYAGE_DOMAIN))!;
}

const frontierOf = (tx: Db, sourceId: string) =>
  tx
    .select({ url: crawlFrontier.url, depth: crawlFrontier.depth, status: crawlFrontier.status })
    .from(crawlFrontier)
    .where(and(eq(crawlFrontier.sourceId, sourceId), inArray(crawlFrontier.url, ARTICLES)))
    .orderBy(crawlFrontier.url);

function recordingBoss() {
  const inserted: Array<{ queue: string; data: Record<string, unknown> }> = [];
  const boss = {
    insert: async (queue: string, jobs: Array<{ id: string; data: Record<string, unknown> }>) => {
      inserted.push(...jobs.map((j) => ({ queue, data: j.data })));
      return jobs.map((j) => j.id);
    },
  } as unknown as PgBoss;
  return { boss, inserted };
}

describe("ensureWhitelistSources", () => {
  it("ensureWhitelistSources creates wikivoyage once and leaves a paused row alone", async () => {
    await withRollback(async (tx) => {
      expect(await ensureWhitelistSources(tx)).toEqual({ created: 1 });
      const id = (await sourceIdByDomain(tx, WIKIVOYAGE_DOMAIN))!;
      const source = (await getSource(tx, id))!;
      expect(source).toMatchObject({ domain: "wikivoyage.org", type: "travel_guide", weight: 0.5, status: "approved", origin: "whitelist" });
      // Defaults plus the entry's rules.
      expect(source.crawlRules).toMatchObject({ maxDepth: 0, maxPages: 500, ratePerMinute: 30, render: "never", converter: "local", pdf: false });
      expect(source.crawlRules.allow).toEqual(["^/wiki/[^:?]+$"]);

      expect(await ensureWhitelistSources(tx)).toEqual({ created: 0 });
      await setSourceStatus(tx, id, "paused", "admin");
      expect(await ensureWhitelistSources(tx)).toEqual({ created: 0 });
      expect((await getSource(tx, id))!.status).toBe("paused");
      const rows = await tx.select({ id: sources.id }).from(sources).where(eq(sources.domain, "wikivoyage.org"));
      expect(rows).toHaveLength(1);
    });
  });

  it("stores a whitelist entry under its registrable domain", async () => {
    await withRollback(async (tx) => {
      const base = getConfig();
      const domain = `wv-${newId()}.co.uk`;
      const entry = { ...base.whitelist[0]!, domain: `www.${domain}` };
      expect(await ensureWhitelistSources(tx, { ...base, whitelist: [entry] })).toEqual({ created: 1 });
      expect(await sourceIdByDomain(tx, domain)).not.toBeNull();
      expect(await sourceIdByDomain(tx, `www.${domain}`)).toBeNull();
    });
  });
});

describe("seedWikivoyage", () => {
  it("runs on its own queue", () => {
    expect(STAGES[WIKIVOYAGE_STAGE]?.queue).toBe("sources.wikivoyage");
  });

  it("an island with de, el and en sitelinks yields three travel_guide documents at depth 0", async () => {
    await withRollback(async (tx) => {
      // Objects of other types or without an item ask for nothing: the request is the recorded one for Aegina.
      await seedArea(tx, [
        { type: "island", wikidataId: AEGINA },
        { type: "island", wikidataId: null },
        { type: "bay", wikidataId: "Q999999991" },
      ]);
      const sourceId = await wikivoyageSource(tx);
      const result = await seedWikivoyage(tx, AREA_KEY, { transport: fixtureTransport() }, { db: tx, stage: WIKIVOYAGE_STAGE });
      expect(result).toEqual({ objects: 1, articles: 3, newDocuments: 3 });

      const docs = await tx
        .select({ url: documents.url, docType: documents.docType, sourceId: documents.sourceId })
        .from(documents)
        .where(inArray(documents.url, ARTICLES))
        .orderBy(documents.url);
      expect(docs).toEqual(ARTICLES.map((url) => ({ url, docType: "travel_guide", sourceId })));
      expect(await frontierOf(tx, sourceId)).toEqual(ARTICLES.map((url) => ({ url, depth: 0, status: "queued" })));
    });
  });

  it("an object without sitelinks yields nothing", async () => {
    await withRollback(async (tx) => {
      await seedArea(tx, [{ type: "islet", wikidataId: "Q999999992" }]);
      const sourceId = await wikivoyageSource(tx);
      const requests: HttpRequest[] = [];
      const transport: Transport = async (req) => {
        requests.push(req);
        const body = { entities: { Q999999992: { type: "item", id: "Q999999992", sitelinks: {} } } };
        return makeResponse(200, new TextEncoder().encode(JSON.stringify(body)));
      };
      const result = await seedWikivoyage(tx, AREA_KEY, { transport }, { db: tx, stage: WIKIVOYAGE_STAGE });
      expect(result).toEqual({ objects: 1, articles: 0, newDocuments: 0 });
      expect(requests).toHaveLength(1);
      expect(new URL(requests[0]!.url).searchParams.get("sitefilter")).toBe("dewikivoyage|elwikivoyage|enwikivoyage");
      const rows = await tx.select({ id: crawlFrontier.id }).from(crawlFrontier).where(eq(crawlFrontier.sourceId, sourceId));
      expect(rows).toEqual([]);
    });
  });

  it("a second seed adds no documents or frontier rows", async () => {
    await withRollback(async (tx) => {
      await seedArea(tx, [{ type: "island", wikidataId: AEGINA }]);
      const sourceId = await wikivoyageSource(tx);
      const ctx = { db: tx, stage: WIKIVOYAGE_STAGE };
      await seedWikivoyage(tx, AREA_KEY, { transport: fixtureTransport() }, ctx);
      // A crawled article keeps its frontier state.
      await tx.update(crawlFrontier).set({ status: "fetched" }).where(eq(crawlFrontier.url, ARTICLES[2]!));
      const again = await seedWikivoyage(tx, AREA_KEY, { transport: fixtureTransport() }, ctx);
      expect(again).toEqual({ objects: 1, articles: 3, newDocuments: 0 });
      const frontier = await frontierOf(tx, sourceId);
      expect(frontier).toHaveLength(3);
      expect(frontier.map((r) => r.status)).toEqual(["queued", "queued", "fetched"]);
      const docs = await tx.select({ id: documents.id }).from(documents).where(inArray(documents.url, ARTICLES));
      expect(docs).toHaveLength(3);
    });
  });

  it("a paused Wikivoyage source is not seeded and asks Wikidata nothing", async () => {
    await withRollback(async (tx) => {
      await seedArea(tx, [{ type: "island", wikidataId: AEGINA }]);
      await setSourceStatus(tx, await wikivoyageSource(tx), "paused", "admin");
      const transport: Transport = async (req) => {
        throw new Error(`unexpected request ${req.url}`);
      };
      expect(await seedWikivoyage(tx, AREA_KEY, { transport }, { db: tx, stage: WIKIVOYAGE_STAGE })).toEqual({
        objects: 0,
        articles: 0,
        newDocuments: 0,
      });
    });
  });

  it("the seeded articles are crawled with the source's rules from the recorded pages", async () => {
    await withRollback(async (tx) => {
      await seedArea(tx, [{ type: "island", wikidataId: AEGINA }]);
      const sourceId = await wikivoyageSource(tx);
      const { id: runId } = await createRun(tx, {
        kind: "stage",
        scope: { type: "area", id: AREA_KEY },
        stages: [],
        params: { areaKey: AREA_KEY, sourceIds: [sourceId] },
        triggeredBy: "wikivoyage-test",
      });
      const ctx = { db: tx, runId, stage: "fetch.url", sourceId };
      await seedWikivoyage(tx, AREA_KEY, { transport: fixtureTransport() }, ctx);
      const transport = fixtureTransport();
      const deps = {
        transport,
        archive: memoryArchive(),
        converters: createConverters({ transport, cfg: getConfig().fetch }),
        pdf: { pdftotext: runPdftotext },
        enqueue: async () => 0,
        isAllowed: async () => true,
      };
      const english = ARTICLES[2]!;
      const result = await fetchUrl(tx, { sourceId, url: english, depth: 0 }, deps, ctx);
      // maxDepth 0: an article's links are never followed.
      expect(result).toEqual({ outcome: "new_version", newUrls: 0 });
      const [version] = await tx
        .select({ converter: documentVersions.converter, docType: documentVersions.docType, charCount: documentVersions.charCount })
        .from(documentVersions)
        .innerJoin(documents, eq(documents.id, documentVersions.documentId))
        .where(eq(documents.url, english));
      expect(version).toMatchObject({ converter: "local", docType: "travel_guide" });
      expect(version!.charCount).toBeGreaterThan(1000);
    });
  });
});

describe("startWikivoyageRun", () => {
  it("creates the whitelist sources and starts sources.wikivoyage before the crawl stages", async () => {
    await withRollback(async (tx) => {
      const { boss, inserted } = recordingBoss();
      const { id } = await startWikivoyageRun(tx, boss, AREA_KEY, "admin");
      const sourceId = (await sourceIdByDomain(tx, WIKIVOYAGE_DOMAIN))!;
      const [run] = await tx.select().from(runs).where(eq(runs.id, id));
      expect(run).toMatchObject({
        scopeType: "area",
        scopeId: AREA_KEY,
        stages: [WIKIVOYAGE_STAGE, ...FETCH_RUN_STAGES],
        params: { areaKey: AREA_KEY, sourceIds: [sourceId] },
      });
      expect(inserted).toEqual([{ queue: "sources.wikivoyage", data: expect.objectContaining({ key: AREA_KEY, areaKey: AREA_KEY }) }]);
      // The Wikivoyage source is being fetched now: a second run is refused.
      await expect(startWikivoyageRun(tx, boss, AREA_KEY, "admin")).rejects.toMatchObject({ reason: "source_run_active" });
    });
  });

  it("refuses an unknown area and a paused Wikivoyage source before a run exists", async () => {
    await withRollback(async (tx) => {
      const { boss, inserted } = recordingBoss();
      await expect(startWikivoyageRun(tx, boss, "nowhere", "admin")).rejects.toThrow(/Unknown area/);
      await setSourceStatus(tx, await wikivoyageSource(tx), "paused", "admin");
      await expect(startWikivoyageRun(tx, boss, AREA_KEY, "admin")).rejects.toMatchObject({ reason: "source_not_approved" });
      expect(inserted).toEqual([]);
    });
  });
});
