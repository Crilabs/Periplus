import { eq, sql } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { setSimulationMode } from "@/lib/adapters/simulation";
import { loadConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { crawlFrontier, documents, documentVersions, runs, sources, tileGeoObjects } from "@/lib/db/schema";
import { consolidationTargets } from "@/lib/domain/consolidation/targets";
import { newId } from "@/lib/domain/ids";
import { createRun } from "@/lib/domain/runs";
import { REVISIT_STAGES } from "@/lib/pipeline/revisit-run";
import { freezeRevisitRun } from "@/lib/pipeline/revisit-stages";
import { foreignJobs, revisitPreflight, SIM_TRIGGERED_BY } from "@/lib/domain/revisit/preflight";
import { insertExtraction, insertMention, insertMentionFact, insertPlace } from "@/test/consolidation";
import { withRollback } from "@/test/db";
import { insertQualitySubdivision } from "@/test/quality";
import { memoryArchive } from "@/test/s3";
import { insertTestSource } from "@/test/text";
import { RUN_KIND_LABELS } from "@/app/(admin)/_components/labels";

/*
 * The revisit run (plan Task 13, rulings M7-P6/P7/P8): stage list, starter, freeze stage and the simulation's stage
 * skipping, in withRollback with a recording boss (no worker); the whole run is driven in revisit-run.test.ts.
 */

const base = loadConfig("config");

const someone = () => `${newId()}@test.invalid`;

/** A synthetic subdivision (one coast tile) and an approved source. */
async function revisitSubdivision(tx: Db) {
  const subdivision = await insertQualitySubdivision(tx, [{ lon: 21.01, lat: 35.2 }]);
  const sourceId = await insertTestSource(tx);
  await tx.update(sources).set({ status: "approved" }).where(eq(sources.id, sourceId));
  return { ...subdivision, sourceId };
}

afterEach(() => setSimulationMode(undefined));

/** A new document of the source with one current version, written by run `runId` (a crawl) or by none. */
async function crawledVersion(tx: Db, sourceId: string, runId: string | null, documentId?: string): Promise<{ versionId: string }> {
  const url = `https://${newId()}.test.invalid/page`;
  const [doc] = documentId
    ? [{ id: documentId }]
    : await tx.insert(documents).values({ sourceId, url, urlNormalized: url, docType: "trip_report" }).returning({ id: documents.id });
  const [version] = await tx
    .insert(documentVersions)
    .values({
      documentId: doc!.id,
      fetchedAt: new Date("2026-06-01T06:00:00Z"),
      contentHash: newId(),
      rawHash: "r",
      rawKey: `archive/${doc!.id}/${newId()}.raw.md`,
      mdKey: `archive/${doc!.id}/${newId()}.md`,
      observedAt: "2026-06-01",
      observedAtBasis: "fetched",
      docType: "trip_report",
      converter: "local",
      charCount: 10,
      runId,
    })
    .returning({ id: documentVersions.id });
  await tx.update(documents).set({ currentVersionId: version!.id }).where(eq(documents.id, doc!.id));
  return { versionId: version!.id };
}

describe("revisit.freeze", () => {
  it("freezes the pending versions and the objects of pages gone in the run's crawl, once", () =>
    withRollback(async (tx) => {
      const a = await revisitSubdivision(tx);
      const { id: runId } = await createRun(tx, {
        kind: "revisit",
        scope: { type: "subdivision", id: a.subdivisionKey },
        stages: [...REVISIT_STAGES],
        params: { sourceIds: [a.sourceId], subdivisionKey: a.subdivisionKey },
        triggeredBy: "test",
      });
      // a page the crawl found gone: a place with a fact from it
      const { objectId: goneObject } = await insertPlace(tx, { lon: 21.02, lat: 35.21, name: "Verschwunden" });
      const m = await insertMention(tx, goneObject, { sourceId: a.sourceId });
      await insertMentionFact(tx, goneObject, m, await insertExtraction(tx, goneObject, m));
      const [doc] = await tx.select().from(documents).where(eq(documents.id, m.documentId));
      await tx.update(documents).set({ status: "gone", consecutiveGone: base.fetch.goneAfter }).where(eq(documents.id, doc!.id));
      await tx.insert(crawlFrontier).values({ sourceId: a.sourceId, url: doc!.url, urlNormalized: doc!.urlNormalized, status: "failed", reason: "HTTP 404", lastRunId: runId });
      // a page that missed once in this run is not gone yet; one gone before the run answered 404 again
      const { objectId: missedObject } = await insertPlace(tx, { lon: 21.03, lat: 35.21, name: "Verfehlt" });
      const missed = await insertMention(tx, missedObject, { sourceId: a.sourceId });
      await insertMentionFact(tx, missedObject, missed, await insertExtraction(tx, missedObject, missed));
      const [missedDoc] = await tx.update(documents).set({ consecutiveGone: 1 }).where(eq(documents.id, missed.documentId)).returning();
      await tx.insert(crawlFrontier).values({ sourceId: a.sourceId, url: missedDoc!.url, urlNormalized: missedDoc!.urlNormalized, status: "failed", reason: "HTTP 404", lastRunId: runId });
      // a version the crawl just wrote of a page that mentioned a place of the subdivision before, and one of another run
      // (not matched either: never taken in by the database-wide pending set)
      const { geoObjectId: areaPlace } = await a.addPlace();
      await tx.insert(tileGeoObjects).values({ tileId: a.tileIds[0]!, geoObjectId: areaPlace });
      const earlier = await insertMention(tx, areaPlace, { sourceId: a.sourceId });
      const fresh = await crawledVersion(tx, a.sourceId, runId, earlier.documentId);
      const elsewhere = await crawledVersion(tx, a.sourceId, null);
      // a page of another subdivision the same crawl wrote: neither a source of this one nor a mention of it (ruling M7-G-R4)
      const otherSubdivision = await crawledVersion(tx, a.sourceId, runId);

      const frozen = await freezeRevisitRun(tx, runId, base);
      expect(frozen.frozenBefore).toBe(false);
      expect(frozen.documentVersionIds).toContain(fresh.versionId);
      expect(frozen.documentVersionIds).not.toContain(elsewhere.versionId);
      expect(frozen.documentVersionIds).not.toContain(otherSubdivision.versionId);
      expect(frozen.goneGeoObjectIds).toEqual([goneObject]);
      const [run] = await tx.select({ params: runs.params }).from(runs).where(eq(runs.id, runId));
      expect(run!.params).toMatchObject({ documentVersionIds: frozen.documentVersionIds, goneGeoObjectIds: [goneObject], subdivisionKey: a.subdivisionKey });
      // the gone page's object is a consolidation target of the run
      expect(await consolidationTargets(tx, { id: runId, params: run!.params as Record<string, unknown> })).toContain(goneObject);

      // a retried job keeps the frozen list, also when more versions arrived meanwhile
      const later = await crawledVersion(tx, a.sourceId, runId);
      const again = await freezeRevisitRun(tx, runId, base);
      expect(again).toEqual({ ...frozen, frozenBefore: true });
      expect(again.documentVersionIds).not.toContain(later.versionId);
    }));
});

describe("sim:revisit preflight", () => {
  it("revisit preflight fails on queued pg-boss jobs", () =>
    withRollback(
      async (tx) => {
        const a = await revisitSubdivision(tx);
        const before = await foreignJobs(tx);
        const insertJob = (runId: string) =>
          tx.execute(sql`insert into pgboss.job (name, data, state) values ('system.ping', ${JSON.stringify({ runId, key: "x" })}::jsonb, 'created')`);
        // a job of a run this CLI started is not foreign; a waiting job of any other run is
        const sim = await createRun(tx, { kind: "revisit", scope: { type: "subdivision", id: a.subdivisionKey }, stages: [], params: {}, triggeredBy: SIM_TRIGGERED_BY });
        await insertJob(sim.id);
        expect(await foreignJobs(tx)).toBe(before);
        const other = await createRun(tx, { kind: "system", scope: { type: "system", id: "ping" }, stages: [], params: {}, triggeredBy: someone() });
        await insertJob(other.id);
        expect(await foreignJobs(tx)).toBe(before + 1);
        // a leftover job of an earlier sim run that failed is foreign: only a live sim run owns its jobs (ruling M7-G-R4)
        const failed = await createRun(tx, { kind: "revisit", scope: { type: "subdivision", id: a.subdivisionKey }, stages: [], params: {}, triggeredBy: SIM_TRIGGERED_BY });
        await insertJob(failed.id);
        expect(await foreignJobs(tx)).toBe(before + 1);
        await tx.update(runs).set({ status: "failed" }).where(eq(runs.id, failed.id));
        expect(await foreignJobs(tx)).toBe(before + 2);
        await tx.update(runs).set({ status: "running" }).where(eq(runs.id, failed.id));

        const scenario = {
          name: "t",
          entries: [{ id: "e1", url: `https://${newId()}.test.invalid/x`, edit: { op: "gone" as const }, expect: { document: "gone" as const, events: [] } }],
        };
        const problems = await revisitPreflight(tx, memoryArchive(), { subdivisionKey: a.subdivisionKey, scenario });
        expect(problems).toEqual([
          "keine Sim-Datenbank – scripts/sim/clone.sh",
          `${before + 1} fremde Jobs in der Warteschlange (wartend, wiederholt oder laufend) – erst abwarten oder beenden`,
          expect.stringMatching(/^Szenario-Eintrag e1: kein Dokument für /),
          `erst Paket bauen: Landesteil ${a.subdivisionKey} hat keine gültige Lieferung`,
        ]);
      },
      { isolationLevel: "repeatable read" },
    ));
});

describe("revisit wording (final review B M-11)", () => {
  it("the runs list names a revisit run „Revisit“, as the button, the dialog and the docs do", () => {
    expect(RUN_KIND_LABELS.revisit).toBe("Revisit");
  });
});
