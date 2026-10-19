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

import { removeProfileEntryAction } from "../places/[id]/actions";

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

  it("a run that fails to start leaves the removal standing (it is started after the commit)", () =>
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
