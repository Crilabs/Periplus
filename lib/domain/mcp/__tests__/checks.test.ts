import { describe, expect, it } from "vitest";
import { workerHeartbeats } from "@/lib/db/schema";
import { newId } from "@/lib/domain/ids";
import { subdivisionChecks, workerStatus } from "@/lib/domain/mcp/checks";
import { withRollback } from "@/test/db";
import { insertTestSubdivision } from "@/test/text";

describe("subdivisionChecks", () => {
  it("returns the gazetteer and the geometry check of a subdivision", () =>
    withRollback(async (tx) => {
      const key = `XT-${newId()}`;
      await insertTestSubdivision(tx, key, [20.9, 35.0, 21.5, 35.5]);
      const res = await subdivisionChecks(tx, key);
      expect(res).toHaveProperty("gazetteer");
      expect(res).toHaveProperty("geometry");
    }));

  it("throws for an unknown subdivision", () =>
    withRollback(async (tx) => {
      await expect(subdivisionChecks(tx, `XT-${newId()}`)).rejects.toThrow(/Unbekannter Landesteil/);
    }));
});

describe("workerStatus", () => {
  it("gives the age of a heartbeat in seconds and the queues", () =>
    withRollback(async (tx) => {
      const now = new Date("2026-10-26T12:00:00Z");
      const workerId = `w-${newId()}`;
      await tx.insert(workerHeartbeats).values({ workerId, host: "h", startedAt: new Date("2026-10-26T11:00:00Z"), beatAt: new Date("2026-10-26T11:59:30Z") });
      const res = await workerStatus(tx, now);
      expect(res.heartbeats.find((h) => h.workerId === workerId)?.ageSeconds).toBe(30);
      expect(res.queues).toBeTypeOf("object");
    }));
});
