import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { getConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { tileGeoObjects } from "@/lib/db/schema";
import { newId } from "@/lib/domain/ids";
import { tileIdFor } from "@/lib/domain/tiles";
import { insertMention } from "@/test/consolidation";
import { withRollback } from "@/test/db";
import { insertNamedObject, insertTestExtractionRun, insertTestRun, insertTestSubdivision, insertTestTile } from "@/test/text";
import { estimateReprocessCostEur } from "../reprocess-estimate";

// Synthetic subdivision around 61.5° E / 35.9° N (outside the pilot box; no other file uses it), every row rolled back.
const LON = 61.5;
const LAT = 35.9;

async function scopeWithMentions(tx: Db, count: number) {
  const key = `XT-${newId()}`;
  await insertTestSubdivision(tx, key, [61.2, 35.6, 61.9, 36.2]);
  const tileId = await insertTestTile(tx, tileIdFor(LON, LAT));
  const objectId = await insertNamedObject(tx, { type: "bay", names: [{ name: "Estimate Bay" }], lon: LON, lat: LAT });
  await tx.insert(tileGeoObjects).values({ tileId, geoObjectId: objectId });
  for (let i = 0; i < count; i++) await insertMention(tx, objectId);
  return key;
}

/** An extraction run finished at `at` (far in the future, so the 5 newest of any database are these) with the cost per mention. */
async function finishedRun(tx: Db, at: string, costPerMentionEur: number | null, o: { purpose?: "regular" | "reprocess" | "comparison"; status?: "finished" | "failed" } = {}) {
  await insertTestExtractionRun(tx, {
    runId: await insertTestRun(tx),
    purpose: o.purpose ?? "regular",
    status: o.status ?? "finished",
    startedAt: new Date(at),
    finishedAt: new Date(at),
    stats: costPerMentionEur === null ? {} : { costPerMentionEur },
  });
}

describe("estimateReprocessCostEur", () => {
  it("is the mentions in scope times the mean cost per mention of the last 5 finished regular and reprocess runs", () =>
    withRollback(async (tx) => {
      const key = await scopeWithMentions(tx, 3);
      await finishedRun(tx, "2099-01-01T00:00:00Z", 0.5); // the 6th newest: not counted
      await finishedRun(tx, "2099-01-02T00:00:00Z", 0.001);
      await finishedRun(tx, "2099-01-03T00:00:00Z", 0.002, { purpose: "reprocess" });
      await finishedRun(tx, "2099-01-04T00:00:00Z", 0.003);
      await finishedRun(tx, "2099-01-05T00:00:00Z", 0.004);
      await finishedRun(tx, "2099-01-06T00:00:00Z", 0.005);
      await finishedRun(tx, "2099-01-07T00:00:00Z", 9, { purpose: "comparison" }); // not regular or reprocess
      await finishedRun(tx, "2099-01-08T00:00:00Z", 9, { status: "failed" }); // not finished
      await finishedRun(tx, "2099-01-09T00:00:00Z", null); // no stats: skipped

      const r = await estimateReprocessCostEur(tx, key, getConfig());
      expect(r.mentions).toBe(3);
      expect(r.costPerMentionEur).toBeCloseTo(0.003);
      expect(r.estimateEur).toBeCloseTo(0.009);
    }));

  it("has no cost per mention and no estimate without a run with stats", () =>
    withRollback(async (tx) => {
      const key = await scopeWithMentions(tx, 2);
      await tx.execute(sql`update extraction_runs set stats = '{}'::jsonb`);
      const r = await estimateReprocessCostEur(tx, key, getConfig());
      expect(r).toEqual({ mentions: 2, costPerMentionEur: null, estimateEur: null });
    }));
});
