import type { PgBoss } from "pg-boss";
import { describe, expect, it } from "vitest";
import { consolidateAfter } from "@/lib/pipeline/follow-ups";
import { withRollback } from "@/test/db";

/* The follow-up of a committed decision never throws (gesamt review UI-7, UI-16). */

const UNKNOWN = "01a1556d-0000-7000-8000-00000000f011";

describe("consolidateAfter", () => {
  it("a job queue that cannot be reached is a failed follow-up, not an error", () =>
    withRollback(async (tx) => {
      const boss = async (): Promise<PgBoss> => {
        throw new Error("queue down");
      };
      expect(await consolidateAfter(tx, boss, { geoObjectIds: [UNKNOWN], triggeredBy: "t" })).toEqual({ status: "failed" });
    }));

  it("a scope that lacks an input is not_ready with its reason", () =>
    withRollback(async (tx) => {
      const boss = async () => ({}) as PgBoss;
      expect(await consolidateAfter(tx, boss, { geoObjectIds: [UNKNOWN], triggeredBy: "t" })).toEqual({
        status: "not_ready",
        reason: "geo_object_not_consolidatable",
      });
    }));
});
