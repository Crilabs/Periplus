import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { withRollback } from "@/test/db";
import { memoryArchive } from "@/test/s3";
import { insertNamedObject, insertTestTile, insertTestVersion } from "@/test/text";
import { buildParams } from "@/lib/ai/anthropic";
import { extractRouteTask, type ExtractRouteInput, type ExtractRouteOutput } from "@/lib/ai/tasks/extract-route";
import { loadConfig, type AppConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { aiBatches, aiBatchItems, documentVersions, extractionRuns, mentions, routes, routeStops } from "@/lib/db/schema";
import { newId } from "@/lib/domain/ids";
import { createRun } from "@/lib/domain/runs";
import { tileIdFor } from "@/lib/domain/tiles";
import { planRoutes, ROUTE_STAGE, routeSectionBatchEntry } from "@/lib/pipeline/text/routes";

/*
 * Stage extraction.route end to end inside withRollback: plan → job (message batch via MockModel) → poll (handler) →
 * check. Reports are cut into sections by a small `routeSectionWords`.
 */

const base = loadConfig("config");
const config: AppConfig = {
  ...base,
  budgets: { ...base.budgets, anthropic: { dailyEur: 1000 } },
  extraction: { ...base.extraction, routeSectionWords: 20 },
};

const CHUNKS = [
  "# Day 1\n\nWe left Ermioni early and anchored in Kolona Bay for the night.",
  "# Day 2\n\nNext morning we sailed 12 nm to Vathy with a NE 4 and moored at the quay.",
];

const ANSWERS: Record<number, ExtractRouteOutput> = {
  1: { stops: [{ name: "Kolona Bay", date: null, mooring: "anchor", quote: "anchored in Kolona Bay for the night", leg: null }] },
  2: {
    stops: [
      {
        name: "Vathy",
        date: null,
        mooring: "quay",
        quote: "Next morning we sailed 12 nm to Vathy",
        leg: { distance_nm: 12, duration_h: null, wind_direction: "NE", wind_beaufort: 4, quote: "we sailed 12 nm to Vathy with a NE 4" },
      },
    ],
  },
};

/** A trip report in the archive (two sections at 20 words), Kolona and Vathy mentioned, and a pilot guide. */
async function scene(tx: Db) {
  const archive = memoryArchive();
  const tile = await insertTestTile(tx, tileIdFor(21.0, 35.2));
  const kolona = await insertNamedObject(tx, { type: "bay", names: [{ name: "Kolona" }], lon: 21.0, lat: 35.2, tiles: [tile] });
  const vathy = await insertNamedObject(tx, { type: "bay", names: [{ name: "Vathy" }], lon: 21.02, lat: 35.2, tiles: [tile] });
  const report = await insertTestVersion(tx, CHUNKS);
  const guide = await insertTestVersion(tx, CHUNKS);
  await tx.update(documentVersions).set({ classifiedDocType: "pilot_guide" }).where(eq(documentVersions.id, guide.versionId));
  for (const v of [report, guide]) {
    const [row] = await tx.select({ mdKey: documentVersions.mdKey }).from(documentVersions).where(eq(documentVersions.id, v.versionId));
    await archive.put(row!.mdKey, CHUNKS.join("\n\n"), "text/markdown");
  }
  for (const [chunk, surface, geoObjectId] of [
    [0, "Kolona Bay", kolona],
    [1, "Vathy", vathy],
  ] as const) {
    const at = CHUNKS[chunk]!.indexOf(surface);
    await tx.insert(mentions).values({
      documentVersionId: report.versionId,
      chunkId: report.chunkIds[chunk]!,
      geoObjectId,
      surface,
      charStart: at,
      charEnd: at + surface.length,
      observedAt: "2026-10-19",
      confidence: 1,
      matchKind: "deterministic",
    });
  }
  const params = { documentVersionIds: [report.versionId, guide.versionId] };
  const { id: runId } = await createRun(tx, { kind: "stage", scope: { type: "system", id: `route-test-${newId()}` }, stages: [ROUTE_STAGE], params, triggeredBy: "test" });
  return { archive, report, guide, kolona, vathy, params, runId };
}

describe("stage extraction.route", () => {

  it("of two answers to a section the latest by creation counts, not the higher id", () =>
    withRollback(async (tx) => {
      const s = await scene(tx);
      await planRoutes(tx, { id: s.runId, params: s.params }, config);
      const [run] = await tx.select().from(extractionRuns).where(eq(extractionRuns.runId, s.runId));
      const subjectId = `${s.report.versionId}:1`;
      const input: ExtractRouteInput = { section: 1, sections: 1, observedAt: "2026-10-19", maxStops: 60, quoteMinChars: 12, quoteMaxChars: 300, stopNameMaxChars: 80, maxBeaufort: 12, text: CHUNKS.join("\n\n") };
      const answer = async (id: string, createdAt: Date, output: ExtractRouteOutput) => {
        const [batch] = await tx
          .insert(aiBatches)
          .values({ task: "extract-route", model: run!.model, promptVersion: 1, status: "distributed", runId: s.runId, stage: ROUTE_STAGE, outcomeKey: `route:${id}`, requestCount: 1 })
          .returning();
        await tx.insert(aiBatchItems).values({ id, batchId: batch!.id, subjectType: "route_section", subjectId, input, status: "succeeded", output, createdAt });
        return batch!;
      };
      // the older answer has the higher uuid
      await answer("ffffffff-ffff-4fff-8fff-ffffffffffff", new Date("2026-10-19T08:00:00Z"), ANSWERS[1]!);
      const newer = await answer("00000000-0000-4000-8000-000000000001", new Date("2026-10-19T09:00:00Z"), ANSWERS[2]!);
      await routeSectionBatchEntry.handle(
        tx,
        {
          id: "00000000-0000-4000-8000-000000000001",
          subjectType: "route_section",
          subjectId,
          input,
          output: ANSWERS[2],
          usage: { inputTokens: 0, outputTokens: 0 },
          costEur: 0,
          batch: { id: newer.id, model: newer.model, promptVersion: newer.promptVersion, runId: s.runId, stage: ROUTE_STAGE },
        },
        { config },
      );
      const stops = await tx
        .select({ name: routeStops.name })
        .from(routeStops)
        .innerJoin(routes, eq(routes.id, routeStops.routeId))
        .where(eq(routes.extractionRunId, run!.id));
      expect(stops).toEqual([{ name: "Vathy" }]);
    }));

  it("the prompt states the rules and the configured limits and carries the section", () => {
    const input: ExtractRouteInput = {
      section: 2,
      sections: 3,
      observedAt: "2024-05-15",
      maxStops: 7,
      quoteMinChars: 11,
      quoteMaxChars: 299,
      stopNameMaxChars: 79,
      maxBeaufort: 13,
      text: "## Day 2\n\nWe anchored in Kolona.",
    };
    const params = buildParams(extractRouteTask, input, config.models.tasks["extract-route"]!, "claude-sonnet-5-5");
    const system = JSON.stringify(params.system);
    expect(system).toContain("At most 7 stops.");
    expect(system).toContain("at least 11 and at most 299 characters");
    expect(system).toContain("at most 79 characters");
    expect(system).toContain("Beaufort (0 to 13)");
    expect(system).not.toContain("{{");
    expect(system).toContain("anchor, buoy, quay, marina, unknown");
    expect(system).toContain("N, NE, E, SE, S, SW, W, NW");
    expect(system).toContain("verbatim quote");
    const user = JSON.stringify(params.messages);
    expect(user).toContain("Section 2 of 3. Observed: 2024-05-15");
    expect(user).toContain("We anchored in Kolona.");
  });
});
