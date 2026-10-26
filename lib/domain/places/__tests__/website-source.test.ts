import { and, desc, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { getConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { placeWebsites, reviewTasks, sources, type DocType, type SourceOrigin, type SourceStatus } from "@/lib/db/schema";
import { newId } from "@/lib/domain/ids";
import { attachPlaceWebsite } from "@/lib/domain/places/website-source";
import { createReviewTask } from "@/lib/domain/review";
import { DEFAULT_CRAWL_RULES, type CrawlRules } from "@/lib/domain/sources/crawl-rules";
import { insertPlace } from "@/test/consolidation";
import { withRollback } from "@/test/db";
import { insertTestRun } from "@/test/text";

/*
 * Spec 15 C „Bindung an den Ort“ (N3b): a found website is recorded under the research source of its domain (an existing
 * source is used as it is, none is approved or changed, no review task, no crawl rules); a start URL several places
 * share, an authority domain and a forbidden domain bind no place. Every domain is `<name>-<uuid>.example`, every row
 * rolled back.
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
  it("a new domain gets a research source without crawl rules and the place is bound", () =>
    withRollback(async (tx) => {
      const runId = await insertTestRun(tx);
      const place = await insertPlace(tx, { type: "harbour", name: "Alpha" });
      const domain = `alpha-${newId()}.example`;
      const url = `https://www.${domain}/en/`;
      const result = await attachPlaceWebsite(tx, { placeId: place.placeId, geoObjectId: place.objectId, url, origin: "osm", runId }, cfg());
      expect(result.bound).toBe(true);
      const source = await sourceOf(tx, result.sourceId!);
      expect(source).toMatchObject({ domain, type: "other", status: "approved", origin: "research" });
      expect(source.crawlRules).toMatchObject({ startUrls: [], maxDepth: 0, maxPages: 1 });
      const [row] = await rowsOf(tx, place.placeId);
      expect(row).toMatchObject({ url, origin: "osm", sourceId: result.sourceId, bound: true, runId });
      expect((await tx.select().from(reviewTasks).where(eq(reviewTasks.subjectId, result.sourceId!))).length).toBe(0);
    }));

  it("an existing source of the domain is used as it is, whatever its status, origin or rules", () =>
    withRollback(async (tx) => {
      const runId = await insertTestRun(tx);
      const cases: Array<{ status: SourceStatus; origin: SourceOrigin; type: DocType }> = [
        { status: "approved", origin: "place_website", type: "marina" },
        { status: "approved", origin: "manual", type: "pilot_guide" },
        { status: "rejected", origin: "serp", type: "trip_report" },
        { status: "paused", origin: "manual", type: "forum" },
      ];
      for (const [i, c] of cases.entries()) {
        const domain = `existing${i}-${newId()}.example`;
        const first = `https://${domain}/first/`;
        const id = await insertSource(tx, domain, { ...c, crawlRules: { startUrls: [first], maxDepth: 2, maxPages: 30 } });
        const before = await sourceOf(tx, id);
        const place = await insertPlace(tx, { type: "harbour", name: `Beta ${i}` });
        const url = `https://${domain}/second/`;
        const result = await attachPlaceWebsite(tx, { placeId: place.placeId, geoObjectId: place.objectId, url, origin: "wikidata", runId }, cfg());
        expect(result, c.status).toEqual({ sourceId: id, bound: true });
        expect(await sourceOf(tx, id)).toEqual(before);
      }
    }));

  it("a proposed source keeps its status and its open approval task: no review task is decided", () =>
    withRollback(async (tx) => {
      const runId = await insertTestRun(tx);
      const domain = `proposed-${newId()}.example`;
      const id = await insertSource(tx, domain, { status: "proposed", type: "trip_report", weight: 0.6, origin: "serp" });
      const task = await createReviewTask(tx, { kind: "place_candidate", subjectType: "source", subjectId: id, context: {} });
      const place = await insertPlace(tx, { type: "harbour", name: "Gamma" });
      const result = await attachPlaceWebsite(tx, { placeId: place.placeId, geoObjectId: place.objectId, url: `https://www.${domain}/`, origin: "osm", runId }, cfg());
      expect(result).toEqual({ sourceId: id, bound: true });
      expect((await sourceOf(tx, id)).status).toBe("proposed");
      expect((await tx.select().from(reviewTasks).where(eq(reviewTasks.id, task.id)))[0]!.status).toBe("open");
    }));

  it("a forbidden domain gets no source and binds nothing", () =>
    withRollback(async (tx) => {
      const runId = await insertTestRun(tx);
      const place = await insertPlace(tx, { type: "harbour", name: "Delta" });
      const url = "https://g.page/some-marina";
      const result = await attachPlaceWebsite(tx, { placeId: place.placeId, geoObjectId: place.objectId, url, origin: "osm", runId }, cfg());
      expect(result).toEqual({ sourceId: null, bound: false });
      const [row] = await rowsOf(tx, place.placeId);
      expect(row).toMatchObject({ url, sourceId: null, bound: false });
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

  it("an authority domain is recorded under a research source and binds nothing", () =>
    withRollback(async (tx) => {
      const runId = await insertTestRun(tx);
      const domain = `limenarxeio-${newId()}.example`;
      const place = await insertPlace(tx, { type: "harbour", name: "Eta" });
      const url = `https://www.${domain}/`;
      const result = await attachPlaceWebsite(tx, { placeId: place.placeId, geoObjectId: place.objectId, url, origin: "osm", runId }, cfg());
      expect(result.bound).toBe(false);
      expect(await sourceOf(tx, result.sourceId!)).toMatchObject({ type: "other", status: "approved", origin: "research" });
      const [row] = await tx
        .select()
        .from(placeWebsites)
        .where(and(eq(placeWebsites.placeId, place.placeId), eq(placeWebsites.url, url)));
      expect(row).toMatchObject({ bound: false, sourceId: result.sourceId });
    }));
});
