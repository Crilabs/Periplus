import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import { afterEach, describe, expect, it } from "vitest";
import type { Manifest, SpotsFile } from "@/contract";
import type { Db } from "@/lib/db/client";
import { berthStates, deliveries, geoObjects, runs, subdivisions, textShingles } from "@/lib/db/schema";
import { setDeliveryArchive } from "@/lib/domain/delivery/archive";
import { buildDelivery } from "@/lib/domain/delivery/build";
import { sha256Hex } from "@/lib/domain/delivery/serialize";
import { shingleHashes } from "@/lib/domain/documents/shingles";
import { createRun, endRun } from "@/lib/domain/runs";
import { newId } from "@/lib/domain/ids";
import { deliveryBuildHandler, deliveryBuildStage } from "@/lib/jobs/handlers/delivery";
import type { JobContext } from "@/lib/jobs/worker";
import { STAGES } from "@/lib/jobs/stages";
import { DELIVERY_STAGE } from "@/lib/pipeline/delivery";
import { startDeliveryRun } from "@/lib/pipeline/delivery-run";
import { testDb, withRollback } from "@/test/db";
import { COMMITTED_SHIFT, endCommittedDeliverySubdivision, seedDeliverySubdivision, type DeliveryFixture } from "@/test/fixtures/delivery/subdivision";
import { deleteTestObjects, testArchive, testObjectContentType } from "@/test/s3";

/*
 * The run "Paket bauen" (plan Task 10): stage plan and starter in withRollback (no worker); the job handler on the
 * pool, the way the worker calls it, against a committed fixture subdivision at −150.1° / −50.1° (ruling M6-E-R2) that the
 * test ends again, with its files in the test bucket deleted.
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

/** A job context as the worker builds it (`runId` = the job's), whose log keeps its records by level. */
function jobContext(db: Db, runId: string) {
  const logs: Array<{ level: "info" | "warn"; fields: Record<string, unknown>; msg: string }> = [];
  const record = (level: "info" | "warn") => (fields: Record<string, unknown>, msg: string) => void logs.push({ level, fields, msg });
  const log = { info: record("info"), warn: record("warn"), error: () => undefined };
  return { ctx: { db, boss: recordingBoss().boss, log, jobId: newId(), runId } as unknown as JobContext, logs };
}

/** A unique address per test: runs are never counted DB-wide. */
const someone = () => `${newId()}@test.invalid`;

/** `pg_current_xact_id()` of the transaction `fn` runs in, committed on return. */
async function committedXact<T>(db: Db, fn: (tx: Db) => Promise<T>): Promise<{ xid: string; result: T }> {
  return db.transaction(async (tx) => {
    const result = await fn(tx);
    const { rows } = await tx.execute<{ xid: string }>(sql`select pg_current_xact_id()::text as xid`);
    return { xid: rows[0]!.xid, result };
  });
}

afterEach(() => setDeliveryArchive(null));

describe("delivery run", () => {
  it("the stage plans exactly one job for the subdivision", async () => {
    expect(STAGES[DELIVERY_STAGE]).toBe(deliveryBuildStage);
    expect(deliveryBuildStage.queue).toBe("delivery.build");
    const subdivisionId = newId();
    const jobs = await deliveryBuildStage.plan({} as Db, { id: newId(), params: { subdivisionId, subdivisionKey: "XT-DELIVERY" } });
    expect(jobs).toEqual([{ key: subdivisionId, subdivisionId }]);
    await expect(deliveryBuildStage.plan({} as Db, { id: newId(), params: {} })).rejects.toThrow(/subdivisionId/);
  });

  it("startDeliveryRun rejects an unknown key, an excluded subdivision and an area key, naming the way out", async () => {
    await withRollback(async (tx) => {
      const { boss, inserted } = recordingBoss();
      const triggeredBy = someone();
      const f = await seedDeliverySubdivision(tx);
      await expect(startDeliveryRun(tx, boss, "XT-UNKNOWN", triggeredBy)).rejects.toThrow("Unbekannter Landesteil XT-UNKNOWN");
      // a geo object id is no subdivision key
      await expect(startDeliveryRun(tx, boss, f.regionId, triggeredBy)).rejects.toThrow(/Unbekannter Landesteil/);
      await expect(startDeliveryRun(tx, boss, "saronic", triggeredBy)).rejects.toThrow(/Landesteil angeben/);
      await tx.update(subdivisions).set({ status: "excluded", statusReason: "test" }).where(eq(subdivisions.id, f.subdivisionId));
      await expect(startDeliveryRun(tx, boss, f.subdivisionKey, triggeredBy)).rejects.toThrow(`Landesteil ${f.subdivisionKey} ist ausgeschlossen`);
      expect(inserted).toEqual([]);
      expect(await tx.select().from(runs).where(eq(runs.triggeredBy, triggeredBy))).toEqual([]);
    });
  });

  it("startDeliveryRun starts the stage run for the subdivision with one job", async () => {
    await withRollback(async (tx) => {
      const { boss, inserted } = recordingBoss();
      const f = await seedDeliverySubdivision(tx);
      const triggeredBy = someone();
      const { id } = await startDeliveryRun(tx, boss, f.subdivisionKey, triggeredBy);
      const [run] = await tx.select().from(runs).where(eq(runs.id, id)).orderBy(asc(runs.createdAt));
      expect(run).toMatchObject({
        kind: "stage",
        scopeType: "subdivision",
        scopeId: "XT-DELIVERY",
        stages: [DELIVERY_STAGE],
        params: { subdivisionId: f.subdivisionId, subdivisionKey: "XT-DELIVERY" },
        triggeredBy,
      });
      expect(inserted).toEqual([
        { queue: "delivery.build", data: expect.objectContaining({ key: f.subdivisionId, subdivisionId: f.subdivisionId, runId: id }) },
      ]);
    });
  });
});

describe("delivery build on the pool (committed, ruling M6-E-R2)", () => {
  it("the handler builds under the subdivision lock from one read-only snapshot, which it stores", { timeout: 60_000 }, async () => {
    const db = testDb();
    const archive = testArchive();
    await archive.ensureBucket();
    setDeliveryArchive(archive);
    const triggeredBy = someone();
    let f: DeliveryFixture | undefined;
    let runId: string | undefined;
    const chunkIds: string[] = [];
    const row = async (id: string) => (await db.select().from(deliveries).where(eq(deliveries.id, id)))[0]!;
    const visible = async (xid: string, deliveryId: string) =>
      (
        await db.execute<{ v: boolean }>(
          sql`select pg_visible_in_snapshot(${xid}::xid8, change_snapshot) as v from deliveries where id = ${deliveryId}`,
        )
      ).rows[0]!.v;
    const readJson = async <T,>(key: string): Promise<T> => JSON.parse(new TextDecoder().decode((await archive.get(key))!)) as T;
    try {
      const seeded = await committedXact(db, (tx) => seedDeliverySubdivision(tx, { key: `pool-${newId()}`, shift: COMMITTED_SHIFT, committed: true }));
      f = seeded.result;
      runId = (
        await createRun(db, {
          kind: "stage",
          scope: { type: "subdivision", id: f.subdivisionKey },
          stages: [DELIVERY_STAGE],
          params: { subdivisionId: f.subdivisionId, subdivisionKey: f.subdivisionKey },
          triggeredBy,
        })
      ).id;
      const job = { key: f.subdivisionId, subdivisionId: f.subdivisionId, runId, stage: DELIVERY_STAGE };

      // 1. the first package, as the worker runs it: ctx.db is the pool
      const first = jobContext(db, runId);
      await deliveryBuildHandler(job, first.ctx);
      expect(first.logs).toEqual([
        { level: "info", msg: "delivery built", fields: expect.objectContaining({ subdivisionId: f.subdivisionId, status: "valid", dataVersion: 1, failedChecks: 0 }) },
      ]);
      const v1 = await row(first.logs[0]!.fields.deliveryId as string);
      expect(v1).toMatchObject({ status: "valid", dataVersion: 1, runId, triggeredBy, storagePrefix: `deliveries/${f.subdivisionKey}/1/` });
      // the stored snapshot is the one the contents were read under: it sees the seed, and its xmin is the stored one
      expect(await visible(seeded.xid, v1.id)).toBe(true);
      expect(v1.changeXmin).toBe((await db.execute<{ x: string }>(sql`select pg_snapshot_xmin(${v1.changeSnapshot}::pg_snapshot)::text as x`)).rows[0]!.x);
      const manifest = await readJson<Manifest>(`${v1.storagePrefix}manifest.json`);
      for (const entry of manifest.files) {
        const stored = (await archive.get(`${v1.storagePrefix}${entry.name}`))!;
        expect(entry, entry.name).toEqual({ name: entry.name, sha256: sha256Hex(stored), bytes: stored.byteLength });
        expect(v1.fileHashes[entry.name], entry.name).toEqual({ sha256: entry.sha256, bytes: entry.bytes });
      }
      expect(await testObjectContentType(`${v1.storagePrefix}coast.geojson`)).toBe("application/geo+json");
      expect(await testObjectContentType(`${v1.storagePrefix}spots.json`)).toBe("application/json");

      // 2. a change committed after the build opened its snapshot is neither in the package nor in its window
      const words = Array.from({ length: 16 }, (_, i) => `p${newId().replace(/-/g, "").replace(/\d/g, "")}${"abcdefghijklmnop"[i]}`);
      const [state] = await db.select().from(berthStates).where(eq(berthStates.placeId, f.places.A.placeId));
      let concurrent: { xid: string } | undefined;
      const probe = await buildDelivery(db, archive, f.subdivisionId, {
        afterSnapshot: async (tx) => {
          // the read path cannot write: read only, one snapshot for every read
          const { rows } = await tx.execute<{ ro: string; iso: string }>(
            sql`select current_setting('transaction_read_only') as ro, current_setting('transaction_isolation') as iso`,
          );
          expect(rows[0]).toEqual({ ro: "on", iso: "repeatable read" });
          concurrent = await committedXact(db, async (other) => {
            // the research rewrites A's state: a changed east shelter and a landside fact that will turn out copied
            const core = { ...state!.core, "shelter.E": { ...state!.core["shelter.E"]!, value: 0.8 } };
            const facts = state!.facts.map((x) => (x.subject === "landside" ? { ...x, statement: `Die Bucht: ${words.join(" ")}.` } : x));
            await other.update(berthStates).set({ core, facts, updatedAt: new Date("2026-10-23T08:00:00Z") }).where(eq(berthStates.placeId, f!.places.A.placeId));
          });
        },
      });
      expect(probe).toMatchObject({ status: "unchanged", dataVersion: null });
      expect(await db.execute<{ s: string }>(sql`select pg_xact_status(${concurrent!.xid}::xid8)::text as s`)).toMatchObject({ rows: [{ s: "committed" }] });
      expect(await visible(concurrent!.xid, probe.deliveryId)).toBe(false);
      expect(await visible(seeded.xid, probe.deliveryId)).toBe(true);

      // 3. the next build reads it: data version 2 with A changed
      const second = jobContext(db, runId);
      await deliveryBuildHandler(job, second.ctx);
      expect(second.logs).toEqual([{ level: "info", msg: "delivery built", fields: expect.objectContaining({ status: "valid", dataVersion: 2 }) }]);
      const v2 = await row(second.logs[0]!.fields.deliveryId as string);
      expect(v2).toMatchObject({ dataVersion: 2, previousDeliveryId: v1.id });
      expect(await visible(concurrent!.xid, v2.id)).toBe(true);
      const a = (await readJson<SpotsFile>(`${v2.storagePrefix}spots.json`)).spots.find((s) => s.id === f!.places.A.publicId)!;
      expect(a).toMatchObject({ asOf: "2026-10-23", shelter: { sectors: { E: 0.8 } } });
      expect(v2.fileHashes).not.toHaveProperty("changes.json");

      // 4. the same content once A's fact statement turns out copied: the fact is dropped (F3), a new valid package, not unchanged
      const archivedChunkId = newId();
      chunkIds.push(archivedChunkId);
      await db.insert(textShingles).values(shingleHashes(words.join(" "), 15).map((shingleHash) => ({ shingleHash, chunkId: archivedChunkId })));
      const third = jobContext(db, runId);
      await expect(deliveryBuildHandler(job, third.ctx)).resolves.toBeUndefined();
      expect(third.logs).toEqual([{ level: "info", msg: "delivery built", fields: expect.objectContaining({ status: "valid", dataVersion: 3 }) }]);
      const v3 = await row(third.logs[0]!.fields.deliveryId as string);
      expect(v3).toMatchObject({ status: "valid", dataVersion: 3, previousDeliveryId: v2.id });
      const a3 = (await readJson<SpotsFile>(`${v3.storagePrefix}spots.json`)).spots.find((s) => s.id === f!.places.A.publicId)!;
      expect(a3.facts.some((x) => x.text.includes(words[0]!))).toBe(false);
    } finally {
      if (f) {
        const stored = await db.select().from(deliveries).where(eq(deliveries.subdivisionId, f.subdivisionId));
        await deleteTestObjects(stored.flatMap((d) => (d.storagePrefix ? Object.keys(d.fileHashes).map((file) => `${d.storagePrefix}${file}`) : [])));
        if (chunkIds.length > 0) await db.delete(textShingles).where(inArray(textShingles.chunkId, chunkIds));
        await endCommittedDeliverySubdivision(db, f);
      }
      if (runId) await endRun(db, runId, "test");
    }
    // nothing of the subdivision is left to meet: no valid subdivision or objects, no files
    expect(await db.select({ id: subdivisions.id }).from(subdivisions).where(and(eq(subdivisions.id, f!.subdivisionId), sql`${subdivisions.validTo} is null`))).toEqual([]);
    expect(await db.select({ id: geoObjects.id }).from(geoObjects).where(and(eq(geoObjects.id, f!.areaId), sql`${geoObjects.validTo} is null`))).toEqual([]);
    const left = await db.select().from(deliveries).where(eq(deliveries.subdivisionId, f!.subdivisionId));
    for (const d of left) for (const file of Object.keys(d.fileHashes)) expect(await archive.exists(`${d.storagePrefix}${file}`)).toBe(false);
  });
});
