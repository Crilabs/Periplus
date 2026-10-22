import { and, desc, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { getConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { placeWebsites, reviewDecisions, reviewTasks, sources, type DocType, type SourceOrigin, type SourceStatus } from "@/lib/db/schema";
import { newId } from "@/lib/domain/ids";
import { attachPlaceWebsite } from "@/lib/domain/places/website-source";
import { createReviewTask } from "@/lib/domain/review";
import { DEFAULT_CRAWL_RULES, type CrawlRules } from "@/lib/domain/sources/crawl-rules";
import { insertPlace } from "@/test/consolidation";
import { withRollback } from "@/test/db";
import { insertTestRun } from "@/test/text";

/*
 * Spec 15 C „Freigabe“ and „Bindung an den Ort“: a found website becomes (or joins) an approved source without a review
 * task; paused and rejected domains are passed over; a start URL several places share, and an authority domain, bind
 * no place. Every domain is `<name>-<uuid>.example`, every row rolled back.
 */

const cfg = () => getConfig();

async function insertSource(
  tx: Db,
  domain: string,
  o: { status: SourceStatus; type?: DocType; origin?: SourceOrigin; crawlRules?: Partial<CrawlRules>; weight?: number },
): Promise<string> {
  const [row] = await tx
    .insert(sources)
    .values({
      domain,
      name: domain,
      type: o.type ?? "pilot_guide",
      weight: o.weight ?? 0.9,
      status: o.status,
      crawlRules: { ...DEFAULT_CRAWL_RULES, ...o.crawlRules },
      origin: o.origin ?? "manual",
    })
    .returning({ id: sources.id });
  return row!.id;
}

const sourceOf = async (tx: Db, id: string) => (await tx.select().from(sources).where(eq(sources.id, id)))[0]!;

async function rowsOf(tx: Db, placeId: string) {
  return tx.select().from(placeWebsites).where(eq(placeWebsites.placeId, placeId)).orderBy(desc(placeWebsites.createdAt), desc(placeWebsites.id));
}

describe("attachPlaceWebsite", () => {
  it("a new domain becomes an approved marina source of origin place_website with small crawl rules", () =>
    withRollback(async (tx) => {
      const runId = await insertTestRun(tx);
      const place = await insertPlace(tx, { type: "harbour", name: "Alpha" });
      const domain = `alpha-${newId()}.example`;
      const url = `https://www.${domain}/en/`;
      const result = await attachPlaceWebsite(tx, { placeId: place.placeId, geoObjectId: place.objectId, url, origin: "osm", runId }, cfg());
      expect(result.bound).toBe(true);
      const source = await sourceOf(tx, result.sourceId!);
      expect(source).toMatchObject({
        domain,
        type: "marina",
        weight: cfg().sourceTypes.marina.weight,
        changeRate: cfg().sourceTypes.marina.changeRate,
        status: "approved",
        origin: "place_website",
      });
      expect(source.crawlRules).toMatchObject({ startUrls: [url], maxDepth: 2, maxPages: 30 });
      const [row] = await rowsOf(tx, place.placeId);
      expect(row).toMatchObject({ url, origin: "osm", sourceId: result.sourceId, bound: true, runId });
      expect((await tx.select().from(reviewTasks).where(eq(reviewTasks.subjectId, result.sourceId!))).length).toBe(0);
    }));

  it("an approved place_website source of a chain gets the start URL and 30 more pages; type and weight stay", () =>
    withRollback(async (tx) => {
      const runId = await insertTestRun(tx);
      const domain = `chain-${newId()}.example`;
      const first = `https://${domain}/gouvia/`;
      const id = await insertSource(tx, domain, {
        status: "approved",
        type: "marina",
        weight: 0.7,
        origin: "place_website",
        crawlRules: { startUrls: [first], maxDepth: 2, maxPages: 30 },
      });
      const place = await insertPlace(tx, { type: "harbour", name: "Lefkas" });
      const url = `https://${domain}/lefkas/`;
      const result = await attachPlaceWebsite(tx, { placeId: place.placeId, geoObjectId: place.objectId, url, origin: "wikidata", runId }, cfg());
      expect(result).toEqual({ sourceId: id, bound: true });
      const source = await sourceOf(tx, id);
      expect(source).toMatchObject({ type: "marina", weight: 0.7, status: "approved" });
      expect(source.crawlRules).toMatchObject({ startUrls: [first, url], maxPages: 60 });
    }));

  it("an approved source of another origin keeps its rules and type; an empty start list keeps the root", () =>
    withRollback(async (tx) => {
      const runId = await insertTestRun(tx);
      const domain = `guide-${newId()}.example`;
      const id = await insertSource(tx, domain, { status: "approved", type: "pilot_guide", origin: "whitelist" });
      const place = await insertPlace(tx, { type: "harbour", name: "Beta" });
      const url = `https://${domain}/beta-marina`;
      const result = await attachPlaceWebsite(tx, { placeId: place.placeId, geoObjectId: place.objectId, url, origin: "osm", runId }, cfg());
      expect(result).toEqual({ sourceId: id, bound: true });
      const source = await sourceOf(tx, id);
      expect(source.type).toBe("pilot_guide");
      expect(source.crawlRules).toMatchObject({ startUrls: [`https://${domain}/`, url], maxPages: DEFAULT_CRAWL_RULES.maxPages, maxDepth: DEFAULT_CRAWL_RULES.maxDepth });
    }));

  it("a proposed source is approved with its proposed settings, its task decided by system", () =>
    withRollback(async (tx) => {
      const runId = await insertTestRun(tx);
      const domain = `proposed-${newId()}.example`;
      const id = await insertSource(tx, domain, { status: "proposed", type: "trip_report", weight: 0.6, origin: "serp" });
      const task = await createReviewTask(tx, { kind: "source_approval", subjectType: "source", subjectId: id, context: {} });
      const place = await insertPlace(tx, { type: "harbour", name: "Gamma" });
      const url = `https://www.${domain}/`;
      const result = await attachPlaceWebsite(tx, { placeId: place.placeId, geoObjectId: place.objectId, url, origin: "osm", runId }, cfg());
      expect(result).toEqual({ sourceId: id, bound: true });
      const source = await sourceOf(tx, id);
      expect(source).toMatchObject({ status: "approved", type: "trip_report", weight: 0.6 });
      expect((source.crawlRules as CrawlRules).startUrls).toContain(url);
      const [t] = await tx.select().from(reviewTasks).where(eq(reviewTasks.id, task.id));
      expect(t!.status).toBe("decided");
      const [decision] = await tx.select().from(reviewDecisions).where(eq(reviewDecisions.taskId, task.id));
      expect(decision).toMatchObject({ decidedBy: "system", decision: { action: "approve", type: "trip_report", weight: 0.6 } });
    }));

  it("a rejected or paused domain gets no source and binds nothing", () =>
    withRollback(async (tx) => {
      const runId = await insertTestRun(tx);
      for (const status of ["rejected", "paused"] as const) {
        const domain = `${status}-${newId()}.example`;
        const id = await insertSource(tx, domain, { status });
        const before = await sourceOf(tx, id);
        const place = await insertPlace(tx, { type: "harbour", name: `Delta ${status}` });
        const url = `https://${domain}/`;
        const result = await attachPlaceWebsite(tx, { placeId: place.placeId, geoObjectId: place.objectId, url, origin: "osm", runId }, cfg());
        expect(result).toEqual({ sourceId: null, bound: false });
        expect(await sourceOf(tx, id)).toEqual(before);
        const [row] = await rowsOf(tx, place.placeId);
        expect(row).toMatchObject({ url, sourceId: null, bound: false });
      }
    }));

  it("the same start URL for two places binds neither of them", () =>
    withRollback(async (tx) => {
      const runId = await insertTestRun(tx);
      const domain = `town-${newId()}.example`;
      const url = `https://www.${domain}/`;
      const a = await insertPlace(tx, { type: "harbour", name: "Epsilon" });
      const b = await insertPlace(tx, { type: "harbour", name: "Zeta" });
      const first = await attachPlaceWebsite(tx, { placeId: a.placeId, geoObjectId: a.objectId, url, origin: "osm", runId }, cfg());
      expect(first.bound).toBe(true);
      const second = await attachPlaceWebsite(tx, { placeId: b.placeId, geoObjectId: b.objectId, url, origin: "osm", runId }, cfg());
      expect(second).toEqual({ sourceId: first.sourceId, bound: false });
      const rowsA = await rowsOf(tx, a.placeId);
      expect(rowsA).toHaveLength(2);
      expect(rowsA[0]).toMatchObject({ url, sourceId: first.sourceId, bound: false });
      expect((await rowsOf(tx, b.placeId))[0]).toMatchObject({ bound: false });
      // the source is not counted twice: the same start URL is not added again
      const source = await sourceOf(tx, first.sourceId!);
      expect((source.crawlRules as CrawlRules).startUrls).toEqual([url]);
      expect((source.crawlRules as CrawlRules).maxPages).toBe(30);
    }));

  it("start URLs differing only in scheme, www. or trailing slash count as the same for two places (final review 2)", () =>
    withRollback(async (tx) => {
      const runId = await insertTestRun(tx);
      const domain = `town-${newId()}.example`;
      const a = await insertPlace(tx, { type: "harbour", name: "Epsilon" });
      const b = await insertPlace(tx, { type: "harbour", name: "Zeta" });
      const first = await attachPlaceWebsite(tx, { placeId: a.placeId, geoObjectId: a.objectId, url: `http://www.${domain}`, origin: "osm", runId }, cfg());
      expect(first.bound).toBe(true);
      const second = await attachPlaceWebsite(tx, { placeId: b.placeId, geoObjectId: b.objectId, url: `https://${domain}/`, origin: "osm", runId }, cfg());
      expect(second.bound).toBe(false);
      expect((await rowsOf(tx, a.placeId))[0]).toMatchObject({ bound: false });
    }));

  it("an authority domain is not created as a marina source and binds nothing", () =>
    withRollback(async (tx) => {
      const runId = await insertTestRun(tx);
      const domain = `limenarxeio-${newId()}.example`;
      const place = await insertPlace(tx, { type: "harbour", name: "Eta" });
      const url = `https://www.${domain}/`;
      const result = await attachPlaceWebsite(tx, { placeId: place.placeId, geoObjectId: place.objectId, url, origin: "osm", runId }, cfg());
      expect(result.bound).toBe(false);
      const source = await sourceOf(tx, result.sourceId!);
      expect(source).toMatchObject({ type: "authority", status: "approved", origin: "place_website" });
      const [row] = await tx
        .select()
        .from(placeWebsites)
        .where(and(eq(placeWebsites.placeId, place.placeId), eq(placeWebsites.url, url)));
      expect(row).toMatchObject({ bound: false, sourceId: result.sourceId });
    }));
});
