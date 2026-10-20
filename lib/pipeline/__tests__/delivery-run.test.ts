import { asc, eq } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import { afterEach, describe, expect, it } from "vitest";
import type { Db } from "@/lib/db/client";
import { deliveries, profileSummaries, runs, textShingles } from "@/lib/db/schema";
import { setDeliveryArchive } from "@/lib/domain/delivery/archive";
import { shingleHashes } from "@/lib/domain/documents/shingles";
import { createRun } from "@/lib/domain/runs";
import { newId } from "@/lib/domain/ids";
import { deliveryBuildHandler, deliveryBuildStage } from "@/lib/jobs/handlers/delivery";
import type { JobContext } from "@/lib/jobs/worker";
import { STAGES } from "@/lib/jobs/stages";
import { DELIVERY_STAGE } from "@/lib/pipeline/delivery";
import { startDeliveryRun } from "@/lib/pipeline/delivery-run";
import { RunScopeNotReady } from "@/lib/pipeline/tile-scope";
import { withRollback } from "@/test/db";
import { seedDeliveryArea } from "@/test/fixtures/delivery/area";
import { memoryArchive } from "@/test/s3";
import { insertTestVersion } from "@/test/text";

/*
 * The run "Paket bauen" (plan Task 10): stage plan, job handler and starter, called directly in withRollback (no
 * worker) on the synthetic fixture area; the archive is in memory.
 */

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

/** A job context whose log keeps the info records. */
function jobContext(db: Db) {
  const infos: Array<Record<string, unknown>> = [];
  const log = { info: (o: Record<string, unknown>) => void infos.push(o), warn: () => undefined, error: () => undefined };
  return { ctx: { db, boss: recordingBoss().boss, log, jobId: newId() } as unknown as JobContext, infos };
}

async function deliveryRun(tx: Db, areaId: string): Promise<string> {
  const { id } = await createRun(tx, {
    kind: "stage",
    scope: { type: "area", id: "delivery-test" },
    stages: [DELIVERY_STAGE],
    params: { areaId, areaKey: "delivery-test" },
    triggeredBy: "admin@test.invalid",
  });
  return id;
}

afterEach(() => setDeliveryArchive(null));

describe("delivery run", () => {
  it("the stage plans exactly one job for the area", async () => {
    expect(STAGES[DELIVERY_STAGE]).toBe(deliveryBuildStage);
    expect(deliveryBuildStage.queue).toBe("delivery.build");
    const areaId = newId();
    const jobs = await deliveryBuildStage.plan({} as Db, { id: newId(), params: { areaId, areaKey: "delivery-test" } });
    expect(jobs).toEqual([{ key: areaId, areaId }]);
    await expect(deliveryBuildStage.plan({} as Db, { id: newId(), params: {} })).rejects.toThrow(/areaId/);
  });

  it("the handler builds the package and records status valid", async () => {
    await withRollback(async (tx) => {
      const archive = memoryArchive();
      setDeliveryArchive(archive);
      const f = await seedDeliveryArea(tx);
      const runId = await deliveryRun(tx, f.areaId);
      const { ctx, infos } = jobContext(tx);
      await deliveryBuildHandler({ key: f.areaId, areaId: f.areaId, runId, stage: DELIVERY_STAGE }, ctx);

      const [row] = await tx.select().from(deliveries).where(eq(deliveries.areaId, f.areaId));
      expect(row).toMatchObject({ status: "valid", dataVersion: 1, runId, triggeredBy: "admin@test.invalid" });
      expect(archive.keys()).toContain(`deliveries/${f.areaPublicId}/1/manifest.json`);
      expect(infos).toEqual([expect.objectContaining({ areaId: f.areaId, deliveryId: row!.id, status: "valid", dataVersion: 1, failedChecks: 0 })]);
    });
  });

  it("a rejected package ends the job without error", async () => {
    await withRollback(async (tx) => {
      setDeliveryArchive(memoryArchive());
      const f = await seedDeliveryArea(tx);
      // A's summary copies 16 words of an archived text
      const words = Array.from({ length: 20 }, (_, i) => `w${newId().replace(/-/g, "")}${i}`);
      const v = await insertTestVersion(tx, [words.join(" ")]);
      await tx.insert(textShingles).values(shingleHashes(words.join(" "), 15).map((shingleHash) => ({ shingleHash, chunkId: v.chunkIds[0]! })));
      await tx.insert(profileSummaries).values({ geoObjectId: f.places.A.geoObjectId, profileVersion: 1, text: words.slice(0, 16).join(" "), status: "ok", attempts: 1, model: "test", promptVersion: 2 });
      const runId = await deliveryRun(tx, f.areaId);
      const { ctx, infos } = jobContext(tx);

      await expect(deliveryBuildHandler({ key: f.areaId, areaId: f.areaId, runId, stage: DELIVERY_STAGE }, ctx)).resolves.toBeUndefined();
      const rows = await tx.select().from(deliveries).where(eq(deliveries.areaId, f.areaId));
      expect(rows).toEqual([expect.objectContaining({ status: "rejected", dataVersion: null, runId })]);
      expect(infos).toEqual([expect.objectContaining({ status: "rejected", dataVersion: null, failedChecks: 1 })]);
    });
  });

  it("startDeliveryRun rejects a geo object that is not an area", async () => {
    await withRollback(async (tx) => {
      const { boss, inserted } = recordingBoss();
      const f = await seedDeliveryArea(tx);
      for (const id of [f.islandId, newId(), "not-a-uuid"]) {
        await expect(startDeliveryRun(tx, boss, { areaGeoObjectId: id, triggeredBy: "admin@test.invalid" })).rejects.toMatchObject({
          constructor: RunScopeNotReady,
          reason: "area_without_geo_object",
        });
      }
      expect(inserted).toEqual([]);
      expect(await tx.select().from(runs).where(eq(runs.triggeredBy, "admin@test.invalid"))).toEqual([]);
    });
  });

  it("startDeliveryRun starts the stage run for the area with one job", async () => {
    await withRollback(async (tx) => {
      const { boss, inserted } = recordingBoss();
      const f = await seedDeliveryArea(tx);
      const { id } = await startDeliveryRun(tx, boss, { areaGeoObjectId: f.areaId, triggeredBy: "admin@test.invalid" });
      const [run] = await tx.select().from(runs).where(eq(runs.id, id)).orderBy(asc(runs.createdAt));
      expect(run).toMatchObject({
        kind: "stage",
        scopeType: "area",
        scopeId: "delivery-test",
        stages: [DELIVERY_STAGE],
        params: { areaId: f.areaId, areaKey: "delivery-test" },
        triggeredBy: "admin@test.invalid",
      });
      expect(inserted).toEqual([{ queue: "delivery.build", data: expect.objectContaining({ key: f.areaId, areaId: f.areaId, runId: id }) }]);
    });
  });
});
