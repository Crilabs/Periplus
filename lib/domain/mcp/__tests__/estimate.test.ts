import { describe, expect, it } from "vitest";
import type { Db } from "@/lib/db/client";
import { runs } from "@/lib/db/schema";
import { newId } from "@/lib/domain/ids";
import { getConfig, type AppConfig } from "@/lib/config";
import { COSTLESS, estimateCost, measureScope, recordScopeSize, scopeSize, STAGES_OF, type ScopeSize } from "@/lib/domain/mcp/estimate";
import { recordExternalCall } from "@/lib/domain/costs";
import { withRollback } from "@/test/db";
import { IMAGE_LAT, IMAGE_LON, insertImageSubdivision, insertSpot } from "@/test/images";
import { insertTestSubdivision } from "@/test/text";
import { eq } from "drizzle-orm";

async function finishedRun(tx: Db, stages: readonly string[], size: ScopeSize | null, costEur: number, finishedAt: string): Promise<string> {
  const [row] = await tx
    .insert(runs)
    .values({
      kind: "stage",
      scopeType: "system",
      scopeId: "places",
      stages: [...stages],
      params: size ? { scopeSize: size } : {},
      triggeredBy: "t",
      status: "finished",
      finishedAt: new Date(finishedAt),
    })
    .returning({ id: runs.id });
  await recordExternalCall(tx, { service: "x", operation: "y", units: 1, unit: "call", costEur, runId: row!.id });
  return row!.id;
}

describe("estimateCost", () => {
  it("scales the cost of the latest comparable run to the new size", () =>
    withRollback(async (tx) => {
      await finishedRun(tx, STAGES_OF.research, { unit: "places", count: 10 }, 5, "2026-10-01T00:00:00Z");
      const newer = await finishedRun(tx, STAGES_OF.research, { unit: "places", count: 20 }, 12, "2026-10-10T00:00:00Z");
      const est = await estimateCost(tx, "research", { unit: "places", count: 50 });
      expect(est.eur).toBe(30);
      expect(est.basis).toEqual({ runId: newer, costEur: 12, size: { unit: "places", count: 20 } });
    }));

  it("has no basis for a run without scopeSize", () =>
    withRollback(async (tx) => {
      await finishedRun(tx, STAGES_OF.research, null, 5, "2026-10-01T00:00:00Z");
      const est = await estimateCost(tx, "research", { unit: "places", count: 5 });
      expect(est).toEqual({ eur: null, basis: null, text: "keine Grundlage (noch kein vergleichbarer Lauf)" });
    }));

  it("ignores a run with other stages, another unit or a count of zero", () =>
    withRollback(async (tx) => {
      await finishedRun(tx, STAGES_OF.images, { unit: "places", count: 10 }, 5, "2026-10-01T00:00:00Z");
      await finishedRun(tx, STAGES_OF.research, { unit: "tiles", count: 10 }, 5, "2026-10-02T00:00:00Z");
      await finishedRun(tx, STAGES_OF.research, { unit: "places", count: 0 }, 5, "2026-10-03T00:00:00Z");
      expect((await estimateCost(tx, "research", { unit: "places", count: 5 })).eur).toBeNull();
    }));

  it("ignores an unfinished run", () =>
    withRollback(async (tx) => {
      const id = await finishedRun(tx, STAGES_OF.research, { unit: "places", count: 10 }, 5, "2026-10-01T00:00:00Z");
      await tx.update(runs).set({ status: "failed" }).where(eq(runs.id, id));
      expect((await estimateCost(tx, "research", { unit: "places", count: 5 })).eur).toBeNull();
    }));

  it("is 0 EUR for a costless kind, without looking at runs", async () => {
    const failing = new Proxy({}, { get: () => { throw new Error("db touched"); } }) as unknown as Db;
    expect(COSTLESS.has("geometry")).toBe(true);
    expect(await estimateCost(failing, "geometry", { unit: "tiles", count: 9 })).toEqual({ eur: 0, basis: null, text: "ohne externe Kosten" });
  });
});

describe("recordScopeSize", () => {
  it("merges scopeSize into the run params", () =>
    withRollback(async (tx) => {
      const [row] = await tx.insert(runs).values({ kind: "stage", scopeType: "system", scopeId: "x", triggeredBy: "t", params: { a: 1 } }).returning({ id: runs.id });
      await recordScopeSize(tx, row!.id, { unit: "places", count: 7 });
      const [r] = await tx.select({ params: runs.params }).from(runs).where(eq(runs.id, row!.id));
      expect(r!.params).toEqual({ a: 1, scopeSize: { unit: "places", count: 7 } });
    }));
});

describe("scopeSize", () => {
  it("counts research candidates of a place list, and fixed sizes for delivery and subdivisions", () =>
    withRollback(async (tx) => {
      expect(await scopeSize(tx, "research", { placeIds: [] })).toEqual({ unit: "places", count: 0 });
      expect(await scopeSize(tx, "delivery", { subdivisionKey: "X" })).toEqual({ unit: "subdivision", count: 1 });
      expect(await scopeSize(tx, "subdivisions", {})).toEqual({ unit: "subdivision", count: 0 });
    }));

  it("is one tile for a tile and the coast tiles for a subdivision", () =>
    withRollback(async (tx) => {
      expect(await scopeSize(tx, "seed", { tileId: "t-1" })).toEqual({ unit: "tiles", count: 1 });
      const key = `XT-${newId()}`;
      await insertTestSubdivision(tx, key, [20.9, 35.0, 21.5, 35.5]);
      expect(await scopeSize(tx, "datasets", { subdivisionKey: key })).toEqual({ unit: "tiles", count: 0 });
    }));

  it("counts pending images of a subdivision without spots as zero", () =>
    withRollback(async (tx) => {
      const key = `XT-${newId()}`;
      await insertTestSubdivision(tx, key, [20.9, 35.0, 21.5, 35.5]);
      expect(await scopeSize(tx, "images", { subdivisionKey: key })).toEqual({ unit: "places", count: 0 });
    }));

  it("caps the images of a run at images.pipeline.maxGenerationsPerRun and reports the whole backlog apart", () =>
    withRollback(async (tx) => {
      const cfg = getConfig();
      const capped: AppConfig = { ...cfg, images: { ...cfg.images, pipeline: { ...cfg.images.pipeline, maxGenerationsPerRun: 2 } } };
      const sd = await insertImageSubdivision(tx);
      await insertSpot(tx, sd.id, { kind: "marina" });
      await insertSpot(tx, sd.id, { lon: IMAGE_LON + 0.05, kind: "port" });
      await insertSpot(tx, sd.id, { lat: IMAGE_LAT + 0.05, kind: "mooring_field" });
      expect(await measureScope(tx, "images", { subdivisionKey: sd.key }, capped)).toEqual({ size: { unit: "places", count: 2 }, backlog: 3 });
      expect(await scopeSize(tx, "images", { subdivisionKey: sd.key }, capped)).toEqual({ unit: "places", count: 2 });
      expect(await measureScope(tx, "images", { subdivisionKey: sd.key })).toEqual({ size: { unit: "places", count: 3 }, backlog: 3 });
      expect((await measureScope(tx, "delivery", { subdivisionKey: sd.key })).backlog).toBeNull();
    }));
});
