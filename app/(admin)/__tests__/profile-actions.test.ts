import { and, eq, sql } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@/lib/db/client";
import { facts, runs } from "@/lib/db/schema";
import { getConsolidationConfig } from "@/lib/config";
import { consolidateGeo } from "@/lib/domain/consolidation/store";
import { profileEntryKey } from "@/lib/domain/profile-view";
import { insertPlace, insertSource, insertTextFact } from "@/test/consolidation";
import { testDb, withRollback } from "@/test/db";

/*
 * „Eintrag entfernen“ through the server action: the review fact, then the consolidation run after the commit, the
 * redirect back to the attribute with a notice. withRollback on the synthetic grid around 21.0° E / 35.2° N; the
 * action's `getDb()` is the test's transaction (its own transactions become savepoints).
 */

let current: Db | undefined;
const requireAdmin = vi.fn();
const redirect = vi.fn();
vi.mock("@/lib/security/require-admin", () => ({ requireAdmin: () => requireAdmin() }));
vi.mock("@/lib/db/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db/client")>()),
  getDb: () => current ?? testDb(),
}));
const bossInsert = vi.fn();
vi.mock("@/lib/jobs/boss", () => ({ getBoss: async () => ({ insert: (...args: unknown[]) => bossInsert(...args) }) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: (url: string) => redirect(url) }));

import { regenerateSummaryAction, removeProfileEntryAction, setPlacePositionAction } from "../places/[id]/actions";

const db = testDb();
const cfg = getConsolidationConfig("v1");
const rock = { kind: "rock", name: "Xera" };
let today = "";
beforeAll(async () => {
  const { rows } = await db.execute<{ today: string }>(sql`select current_date::text as today`);
  today = rows[0]!.today;
});

beforeEach(() => {
  vi.resetAllMocks();
  requireAdmin.mockResolvedValue({ email: "admin@example.invalid" });
  bossInsert.mockResolvedValue([]);
  current = undefined;
});

const form = (fields: Record<string, string>) => {
  const data = new FormData();
  for (const [k, v] of Object.entries(fields)) data.set(k, v);
  return data;
};

async function hazardPlace(tx: Db) {
  const { objectId, placeId } = await insertPlace(tx, { name: "Gefahrenbucht" });
  await insertTextFact(tx, objectId, await insertSource(tx, "trip_report", 0.6), { attribute: "hazards", value: [rock, { kind: "shoal", name: null }], observedAt: "2026-06-02" });
  await consolidateGeo(tx, objectId, { today });
  return { objectId, placeId };
}

const removalFacts = (tx: Db, objectId: string) =>
  tx.select({ value: facts.value }).from(facts).where(and(eq(facts.geoObjectId, objectId), sql`${facts.reviewDecisionId} is not null`));

describe("removeProfileEntryAction", () => {
  it("writes the removal, then starts the consolidation run and returns to the attribute", () =>
    withRollback(async (tx) => {
      current = tx;
      const p = await hazardPlace(tx);
      await removeProfileEntryAction(
        form({ geoObjectId: p.objectId, attribute: "hazards", entryKey: profileEntryKey("hazards", rock, cfg), version: "1", placeId: p.placeId }),
      );
      expect((await removalFacts(tx, p.objectId)).map((f) => f.value)).toEqual([{ remove: rock }]);
      const [run] = await tx.select({ id: runs.id, params: runs.params }).from(runs).where(sql`${runs.params}->'geoObjectIds' ? ${p.objectId}`);
      expect(run).toBeDefined();
      expect(bossInsert).toHaveBeenCalled();
      expect(redirect).toHaveBeenCalledWith(`/places/${p.placeId}?tab=profile&attr=hazards&notice=entry_removed&run=${run!.id}`);
    }));

  it("a run that fails to start leaves the removal standing and says so", () =>
    withRollback(async (tx) => {
      current = tx;
      const p = await hazardPlace(tx);
      bossInsert.mockRejectedValue(new Error("queue down"));
      await removeProfileEntryAction(form({ geoObjectId: p.objectId, attribute: "hazards", entryKey: profileEntryKey("hazards", rock, cfg), version: "1" }));
      expect(await removalFacts(tx, p.objectId)).toHaveLength(1);
      expect(redirect).toHaveBeenCalledWith(`/geo/${p.objectId}?attr=hazards&notice=entry_removed_no_run`);
    }));

  it("a stale version or an unknown entry writes nothing and says so", () =>
    withRollback(async (tx) => {
      current = tx;
      const p = await hazardPlace(tx);
      await removeProfileEntryAction(form({ geoObjectId: p.objectId, attribute: "hazards", entryKey: profileEntryKey("hazards", rock, cfg), version: "2", placeId: p.placeId }));
      expect(redirect).toHaveBeenLastCalledWith(`/places/${p.placeId}?tab=profile&attr=hazards&notice=changed`);
      await removeProfileEntryAction(form({ geoObjectId: p.objectId, attribute: "hazards", entryKey: "nope", version: "1", placeId: p.placeId }));
      expect(redirect).toHaveBeenLastCalledWith(`/places/${p.placeId}?tab=profile&attr=hazards&notice=error`);
      expect(await removalFacts(tx, p.objectId)).toHaveLength(0);
      expect(bossInsert).not.toHaveBeenCalled();
    }));

  it("a place of another geo object is refused and nothing is written", () =>
    withRollback(async (tx) => {
      current = tx;
      const p = await hazardPlace(tx);
      const other = await insertPlace(tx, { name: "Andere Bucht", lon: 21.01 });
      await expect(
        removeProfileEntryAction(form({ geoObjectId: p.objectId, attribute: "hazards", entryKey: profileEntryKey("hazards", rock, cfg), version: "1", placeId: other.placeId })),
      ).rejects.toThrow("does not belong");
      expect(await removalFacts(tx, p.objectId)).toHaveLength(0);
      expect(redirect).not.toHaveBeenCalled();
    }));

  it("refuses without an admin session", () =>
    withRollback(async (tx) => {
      current = tx;
      const p = await hazardPlace(tx);
      requireAdmin.mockRejectedValue(new Error("NEXT_REDIRECT"));
      await expect(
        removeProfileEntryAction(form({ geoObjectId: p.objectId, attribute: "hazards", entryKey: profileEntryKey("hazards", rock, cfg), version: "1" })),
      ).rejects.toThrow("NEXT_REDIRECT");
      expect(await removalFacts(tx, p.objectId)).toHaveLength(0);
    }));
});

describe("regenerateSummaryAction (ruling M6-H-R1)", () => {
  it("starts a summary-only run that regenerates, then goes to the run; admin only", () =>
    withRollback(async (tx) => {
      current = tx;
      const p = await hazardPlace(tx);
      await regenerateSummaryAction(form({ geoObjectId: p.objectId, placeId: p.placeId }));
      expect(requireAdmin).toHaveBeenCalled();
      const [run] = await tx.select({ id: runs.id, stages: runs.stages, params: runs.params }).from(runs).where(sql`${runs.params}->'geoObjectIds' ? ${p.objectId}`);
      expect(run).toMatchObject({ stages: ["consolidation.summary"], params: { stagesOnly: ["consolidation.summary"], regenerateSummary: true } });
      expect(bossInsert).toHaveBeenCalled();
      expect(redirect).toHaveBeenCalledWith(`/runs/${run!.id}`);
    }));

  it("refuses a place of another object and a missing admin", () =>
    withRollback(async (tx) => {
      current = tx;
      const p = await hazardPlace(tx);
      const other = await insertPlace(tx, { name: "Andere Bucht", lon: 21.01 });
      await expect(regenerateSummaryAction(form({ geoObjectId: p.objectId, placeId: other.placeId }))).rejects.toThrow(/does not belong/);
      requireAdmin.mockRejectedValue(new Error("not an admin"));
      await expect(regenerateSummaryAction(form({ geoObjectId: p.objectId }))).rejects.toThrow("not an admin");
      expect(await tx.select().from(runs).where(sql`${runs.params}->'geoObjectIds' ? ${p.objectId}`)).toEqual([]);
    }));
});

describe("setPlacePositionAction (ruling M6-H-R1)", () => {
  it("moves the place point, then starts a run after the commit and returns to the geometry tab", () =>
    withRollback(async (tx) => {
      current = tx;
      const { objectId, placeId } = await insertPlace(tx, { name: "Landbucht" });
      await setPlacePositionAction(form({ placeId, lon: "21.001", lat: "35.2005" }));
      expect(requireAdmin).toHaveBeenCalled();
      const { rows } = await tx.execute<{ lon: number; lat: number }>(sql`select ST_X(position) as lon, ST_Y(position) as lat from places where id = ${placeId}`);
      expect(rows[0]).toEqual({ lon: 21.001, lat: 35.2005 });
      // no geometry inputs on the synthetic grid: the consolidation run takes the new position into the profile
      const [run] = await tx.select({ id: runs.id }).from(runs).where(sql`${runs.params}->'geoObjectIds' ? ${objectId}`);
      expect(run).toBeDefined();
      expect(redirect).toHaveBeenCalledWith(`/places/${placeId}?tab=geometry&position=moved&run=${run!.id}`);
    }));

  it("a point too far away comes back with too_far and changes nothing; admin only", () =>
    withRollback(async (tx) => {
      current = tx;
      const { placeId } = await insertPlace(tx, { name: "Landbucht" });
      await setPlacePositionAction(form({ placeId, lon: "21.0", lat: "35.25" }));
      expect(redirect).toHaveBeenCalledWith(`/places/${placeId}?tab=geometry&position=too_far`);
      requireAdmin.mockRejectedValue(new Error("not an admin"));
      await expect(setPlacePositionAction(form({ placeId, lon: "21.0", lat: "35.2001" }))).rejects.toThrow("not an admin");
      const { rows } = await tx.execute<{ lat: number }>(sql`select ST_Y(position) as lat from places where id = ${placeId}`);
      expect(rows[0]!.lat).toBe(35.2);
    }));
});
