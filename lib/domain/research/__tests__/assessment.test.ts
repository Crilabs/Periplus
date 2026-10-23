import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import type { Db } from "@/lib/db/client";
import { pageAssessments } from "@/lib/db/schema";
import type { AssessPageOutput } from "@/lib/ai/tasks/assess-page";
import { storeAssessment } from "@/lib/domain/research/assessment";
import { withRollback } from "@/test/db";
import { insertTestRun, insertTestVersion } from "@/test/text";

const FETCHED = new Date("2026-10-23T10:00:00Z");

const out = (over: Partial<AssessPageOutput> = {}): AssessPageOutput => ({
  page_kind: "trip_report",
  first_hand: true,
  generated: false,
  language: "en",
  observed_at: null,
  observed_at_explicit: false,
  observed_at_reason: null,
  berths: [{ name: "Vathi", island: null, kind: "anchorage" }],
  ...over,
});

async function store(tx: Db, versionId: string, o: AssessPageOutput, publishedAt: string | null) {
  await storeAssessment(tx, versionId, o, { model: "claude-sonnet-5-5", promptVersion: 1, runId: await insertTestRun(tx), fetchedAt: FETCHED, publishedAt });
  const [row] = await tx.select().from(pageAssessments).where(eq(pageAssessments.documentVersionId, versionId));
  return row!;
}

describe("storeAssessment", () => {
  it("drops an observation date in the future and falls back to published_at", () =>
    withRollback(async (tx) => {
      const { versionId } = await insertTestVersion(tx, ["x"]);
      const row = await store(tx, versionId, out({ observed_at: "2031-06", observed_at_explicit: true }), "2024-03-02");
      expect(row).toMatchObject({ observedAt: "2024-03-02", observedAtBasis: "published", model: "claude-sonnet-5-5", promptVersion: 1, pageKind: "trip_report" });
    }));

  it("takes an explicit month as day 15", () =>
    withRollback(async (tx) => {
      const { versionId } = await insertTestVersion(tx, ["x"]);
      const row = await store(tx, versionId, out({ observed_at: "2024-06", observed_at_explicit: true, observed_at_reason: "we anchored in June 2024" }), "2024-07-01");
      expect(row).toMatchObject({ observedAt: "2024-06-15", observedAtBasis: "explicit", observedAtReason: "we anchored in June 2024" });
    }));

  it("ignores a date that is not explicit", () =>
    withRollback(async (tx) => {
      const { versionId } = await insertTestVersion(tx, ["x"]);
      const row = await store(tx, versionId, out({ observed_at: "2024-06-10", observed_at_explicit: false }), "2024-07-01");
      expect(row).toMatchObject({ observedAt: "2024-07-01", observedAtBasis: "published" });
    }));

  it("falls back on an unreadable date, and without published_at on the fetch date", () =>
    withRollback(async (tx) => {
      const { versionId } = await insertTestVersion(tx, ["x"]);
      const row = await store(tx, versionId, out({ observed_at: "Juni 2024", observed_at_explicit: true }), null);
      expect(row).toMatchObject({ observedAt: "2026-10-23", observedAtBasis: "fetched" });
    }));

  it("trims the reason to 300 characters and the berths to 50", () =>
    withRollback(async (tx) => {
      const { versionId } = await insertTestVersion(tx, ["x"]);
      const berths = Array.from({ length: 60 }, (_, i) => ({ name: `Bay ${i}`, island: null, kind: "anchorage" as const }));
      const row = await store(tx, versionId, out({ observed_at_reason: "r".repeat(500), berths }), null);
      expect(row.observedAtReason).toHaveLength(300);
      expect(row.berths).toHaveLength(50);
    }));

  it("a second call for the same version, model and prompt adds no row", () =>
    withRollback(async (tx) => {
      const { versionId } = await insertTestVersion(tx, ["x"]);
      await store(tx, versionId, out(), null);
      await store(tx, versionId, out({ page_kind: "forum" }), null);
      const rows = await tx.select().from(pageAssessments).where(eq(pageAssessments.documentVersionId, versionId));
      expect(rows).toHaveLength(1);
      expect(rows[0]!.pageKind).toBe("trip_report");
    }));
});
