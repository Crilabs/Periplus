import { eq } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import { describe, expect, it } from "vitest";
import { MockModel } from "@/lib/ai/mock";
import type { Db } from "@/lib/db/client";
import { geomFromGeoJson } from "@/lib/db/geometry";
import { getConfig } from "@/lib/config";
import { crawlFrontier, documents, geoObjects, mentions, placeWebsites, places, runs } from "@/lib/db/schema";
import { mentionsConfigKey, recordMatchPass } from "@/lib/domain/mentions/store";
import { newId } from "@/lib/domain/ids";
import { createRun } from "@/lib/domain/runs";
import { tileIdFor } from "@/lib/domain/tiles";
import { STAGES } from "@/lib/jobs/stages";
import { FETCH_RUN_STAGES } from "@/lib/pipeline/fetch/run";
import { PLACE_WEBSITE_RUN_STAGES, startPlaceWebsiteRun } from "@/lib/pipeline/place-website-run";
import { PLACE_WEBSITE_FREEZE_STAGE, PLACE_WEBSITE_STAGE } from "@/lib/pipeline/places/stage-name";
import { freezePlaceWebsiteRun, runPlaceWebsiteJob } from "@/lib/pipeline/places/website-stage";
import { SUBDIVISION_BUILD_STAGES } from "@/lib/pipeline/subdivision-build";
import { matchVersion } from "@/lib/pipeline/text/mentions";
import { TEXT_RUN_STAGES } from "@/lib/pipeline/text/run";
import { SEED_STAGE } from "@/lib/pipeline/tile-scope";
import { withRollback } from "@/test/db";
import { memoryArchive } from "@/test/s3";
import { insertNamedObject, insertTestSource, insertTestSubdivision, insertTestTile, insertTestVersion } from "@/test/text";

/*
 * Stage `places.website` and the run „Marina-Websites suchen“ (spec 15 C „Crawl“): one job per place without website,
 * the touched sources go into the run's `sourceIds` for its crawl, and the freeze before the text stages takes exactly
 * the pending versions of those sources. Synthetic objects at 27.6° E / 34.1° N.
 */

const SUB = "XT-PW2";
const LON = 27.6;
const LAT = 34.1;
const TILE = tileIdFor(LON, LAT);

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

async function setup(tx: Db, website?: string) {
  const sub = await insertTestSubdivision(tx, SUB, [27.5, 34.0, 28.0, 34.25]);
  await insertTestTile(tx, TILE, null, sub.id);
  const geoObjectId = await insertNamedObject(tx, { type: "harbour", names: [{ name: "Kappa" }], lon: LON, lat: LAT, subdivisionId: sub.id });
  if (website) await tx.update(geoObjects).set({ tags: { website } }).where(eq(geoObjects.id, geoObjectId));
  const [p] = await tx
    .insert(places)
    .values({ geoObjectId, kind: "marina", status: "candidate", position: geomFromGeoJson({ type: "Point", coordinates: [LON, LAT] }) })
    .returning({ id: places.id });
  return { placeId: p!.id, geoObjectId };
}

const paramsOf = async (tx: Db, id: string) => (await tx.select({ params: runs.params }).from(runs).where(eq(runs.id, id)))[0]!.params as Record<string, unknown>;

describe("places.website in the subdivision build", () => {
  it("comes right after seed.tile and the things on land around its candidates (gazetteer.land, N7)", () => {
    const stages = [...SUBDIVISION_BUILD_STAGES] as string[];
    expect(stages.indexOf(PLACE_WEBSITE_STAGE)).toBe(stages.indexOf(SEED_STAGE) + 2);
    expect(stages[stages.indexOf(SEED_STAGE) + 1]).toBe("gazetteer.land");
  });
});

describe("startPlaceWebsiteRun", () => {
  it("starts the stage, crawl, freeze and text stages for the subdivision and plans one job per place", () =>
    withRollback(async (tx) => {
      const place = await setup(tx);
      const { boss, inserted } = recordingBoss();
      const { id } = await startPlaceWebsiteRun(tx, boss, { subdivisionKey: SUB }, "admin@example.invalid");
      const [run] = await tx.select().from(runs).where(eq(runs.id, id));
      expect(run).toMatchObject({ kind: "stage", scopeType: "subdivision", scopeId: SUB, triggeredBy: "admin@example.invalid" });
      expect(run!.stages).toEqual([PLACE_WEBSITE_STAGE, ...FETCH_RUN_STAGES, PLACE_WEBSITE_FREEZE_STAGE, ...TEXT_RUN_STAGES]);
      expect(PLACE_WEBSITE_RUN_STAGES).toEqual(run!.stages);
      expect(run!.params).toMatchObject({ subdivisionKey: SUB, pending: true, sourceIds: [] });
      expect(inserted.filter((j) => j.queue === "places.website").map((j) => j.data.placeId)).toEqual([place.placeId]);
    }));

  it("refuses an unknown subdivision", () =>
    withRollback(async (tx) => {
      const { boss } = recordingBoss();
      await expect(startPlaceWebsiteRun(tx, boss, { subdivisionKey: "XT-NOPE" }, "t")).rejects.toThrow();
    }));
});

describe("runPlaceWebsiteJob and the freeze", () => {
  it("attaches the known website and adds its source to the run once, also when the job runs again", () =>
    withRollback(async (tx) => {
      const url = `https://www.kappa-${newId()}.example/`;
      const place = await setup(tx, url);
      const { boss } = recordingBoss();
      const { id: runId } = await startPlaceWebsiteRun(tx, boss, { subdivisionKey: SUB }, "t");
      const deps = { transport: async () => { throw new Error("no network"); }, archive: memoryArchive(), model: new MockModel({}) };
      const first = await runPlaceWebsiteJob(tx, { ...place, runId }, deps);
      expect(first).toMatchObject({ outcome: "known", bound: true });
      const again = await runPlaceWebsiteJob(tx, { ...place, runId }, deps);
      expect(again).toMatchObject({ outcome: "attached_before" });
      const params = await paramsOf(tx, runId);
      expect(params.sourceIds).toEqual([first.sourceId]);
      expect(await tx.select().from(placeWebsites).where(eq(placeWebsites.placeId, place.placeId))).toHaveLength(1);
      // the fetch.source stage of the run plans that source
      expect(await STAGES["fetch.source"]!.plan(tx, { id: runId, params })).toEqual([{ key: first.sourceId, sourceId: first.sourceId }]);
    }));

  it("a website the build attached (without crawl) is fetched by the next button run, and once crawled not again", () =>
    withRollback(async (tx) => {
      const url = `https://www.lambda-${newId()}.example/`;
      const place = await setup(tx, url);
      // the build's places.website stage: attaches, crawls nothing
      const { id: buildId } = await createRun(tx, {
        kind: "full",
        scope: { type: "subdivision", id: SUB },
        stages: [PLACE_WEBSITE_STAGE],
        params: { subdivisionKey: SUB },
        triggeredBy: "t",
      });
      const deps = { transport: async () => { throw new Error("no network"); }, archive: memoryArchive(), model: new MockModel({}) };
      const attached = await runPlaceWebsiteJob(tx, { ...place, runId: buildId }, deps);
      expect(attached.sourceId).toBeTruthy();

      const { boss, inserted } = recordingBoss();
      const { id: first } = await startPlaceWebsiteRun(tx, boss, { subdivisionKey: SUB }, "t");
      expect(inserted.filter((j) => j.queue === "places.website")).toEqual([]);
      expect((await paramsOf(tx, first)).sourceIds).toEqual([attached.sourceId]);

      // its crawl fetched the start URL; the run ends
      await tx.insert(crawlFrontier).values({ sourceId: attached.sourceId!, url, urlNormalized: url, status: "fetched", lastRunId: first });
      await tx.update(runs).set({ status: "finished" }).where(eq(runs.id, first));
      const { id: second } = await startPlaceWebsiteRun(tx, recordingBoss().boss, { subdivisionKey: SUB }, "t");
      const params = await paramsOf(tx, second);
      expect(params.sourceIds).toEqual([]);
      expect(params.skippedSourceIds).toBeUndefined();
    }));

  it("freezes exactly the pending versions of the run's sources", () =>
    withRollback(async (tx) => {
      const { boss } = recordingBoss();
      await setup(tx);
      const { id: runId } = await startPlaceWebsiteRun(tx, boss, { subdivisionKey: SUB }, "t");
      const own = await insertTestSource(tx);
      const other = await insertTestSource(tx);
      const mine = await insertTestVersion(tx, ["Welcome to Kappa Marina."], { sourceId: own });
      await insertTestVersion(tx, ["Something else."], { sourceId: other });
      await tx.update(runs).set({ params: { ...(await paramsOf(tx, runId)), sourceIds: [own] } }).where(eq(runs.id, runId));
      const frozen = await freezePlaceWebsiteRun(tx, runId);
      expect(frozen.documentVersionIds).toEqual([mine.versionId]);
      expect((await paramsOf(tx, runId)).documentVersionIds).toEqual([mine.versionId]);
      // a retried freeze keeps the list
      expect((await freezePlaceWebsiteRun(tx, runId)).frozenBefore).toBe(true);
    }));

  it("takes the matched versions under a newly bound start URL without a bound mention, and the match binds them (final review 3)", () =>
    withRollback(async (tx) => {
      const host = `mu-${newId()}.example`;
      const place = await setup(tx, `http://www.${host}`);
      const cfg = getConfig();
      // pages of the domain fetched and matched before the website was attached (the start URL counts as fetched)
      const source = await insertTestSource(tx);
      const page = async (path: string) => {
        const url = `https://${host}${path}`;
        const [doc] = await tx.insert(documents).values({ sourceId: source, url, urlNormalized: url, docType: "marina" }).returning({ id: documents.id });
        const v = await insertTestVersion(tx, ["Visitor berths all year, water and power on the pontoons."], { sourceId: source, documentId: doc!.id });
        await recordMatchPass(tx, v.versionId, mentionsConfigKey(cfg), null);
        return v;
      };
      const berths = await page("/berths");
      const done = await page("/prices");
      await tx.insert(mentions).values({ documentVersionId: done.versionId, chunkId: done.chunkIds[0]!, geoObjectId: place.geoObjectId, surface: "", charStart: 0, charEnd: 0, observedAt: "2026-10-19", confidence: 1, matchKind: "bound" });
      const elsewhere = await insertTestVersion(tx, ["Something else."], { sourceId: source });
      await recordMatchPass(tx, elsewhere.versionId, mentionsConfigKey(cfg), null);

      const { boss } = recordingBoss();
      const { id: runId } = await startPlaceWebsiteRun(tx, boss, { subdivisionKey: SUB }, "t");
      const deps = { transport: async () => { throw new Error("no network"); }, archive: memoryArchive(), model: new MockModel({}) };
      const attached = await runPlaceWebsiteJob(tx, { ...place, runId }, deps);
      expect(attached).toMatchObject({ outcome: "known", bound: true });
      await tx.update(runs).set({ params: { ...(await paramsOf(tx, runId)), sourceIds: [attached.sourceId, source] } }).where(eq(runs.id, runId));

      const frozen = await freezePlaceWebsiteRun(tx, runId);
      expect(frozen.documentVersionIds).toEqual([berths.versionId]);
      await matchVersion(tx, berths.versionId, { runId, cfg });
      const bound = await tx.select({ geoObjectId: mentions.geoObjectId }).from(mentions).where(eq(mentions.documentVersionId, berths.versionId));
      expect(bound).toEqual([{ geoObjectId: place.geoObjectId }]);
    }));

  it("a website the build attached to a source whose start URL was fetched before: the next run binds its old pages (final review 3)", () =>
    withRollback(async (tx) => {
      const url = `https://www.nu-${newId()}.example/`;
      const place = await setup(tx, url);
      const cfg = getConfig();
      const { id: buildId } = await createRun(tx, { kind: "full", scope: { type: "subdivision", id: SUB }, stages: [PLACE_WEBSITE_STAGE], params: { subdivisionKey: SUB }, triggeredBy: "t" });
      const deps = { transport: async () => { throw new Error("no network"); }, archive: memoryArchive(), model: new MockModel({}) };
      const attached = await runPlaceWebsiteJob(tx, { ...place, runId: buildId }, deps);
      await tx.insert(crawlFrontier).values({ sourceId: attached.sourceId!, url, urlNormalized: url, status: "fetched", lastRunId: buildId });
      const pageUrl = `${url}fuel`;
      const [doc] = await tx.insert(documents).values({ sourceId: attached.sourceId!, url: pageUrl, urlNormalized: pageUrl, docType: "marina" }).returning({ id: documents.id });
      const v = await insertTestVersion(tx, ["Diesel at the fuel dock."], { sourceId: attached.sourceId!, documentId: doc!.id });
      await recordMatchPass(tx, v.versionId, mentionsConfigKey(cfg), null);

      const { id: runId } = await startPlaceWebsiteRun(tx, recordingBoss().boss, { subdivisionKey: SUB }, "t");
      expect((await paramsOf(tx, runId)).sourceIds).toEqual([]);
      expect((await freezePlaceWebsiteRun(tx, runId)).documentVersionIds).toEqual([v.versionId]);
    }));
});
