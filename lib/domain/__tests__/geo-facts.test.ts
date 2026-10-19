import { describe, expect, it } from "vitest";
import { withRollback } from "@/test/db";
import { insertNamedObject, insertTestExtractionRun, insertTestRun, insertTestVersion } from "@/test/text";
import { loadConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { computations, extractionUnits, facts, mentions, type ExtractionPurpose } from "@/lib/db/schema";
import { geoFacts, geoMentions, MENTIONS_PER_PAGE } from "@/lib/domain/geo-facts";

/*
 * Facts and mentions of a geo object for the geo and place pages, inside withRollback (21.0° E / 35.2° N).
 */

const config = loadConfig("config");
const taskConfig = config.models.tasks["extract-facts"]!;

type Scene = { kolona: string; versionId: string; chunkId: string; mentionId: string; text: string; sourceId: string; documentId: string };

async function scene(tx: Db, text: string): Promise<Scene> {
  const kolona = await insertNamedObject(tx, { type: "bay", names: [{ name: "Kolona" }], lon: 21.1, lat: 35.1 });
  const v = await insertTestVersion(tx, [text]);
  const [m] = await tx
    .insert(mentions)
    .values({ documentVersionId: v.versionId, chunkId: v.chunkIds[0]!, geoObjectId: kolona, surface: "Kolona", charStart: text.indexOf("Kolona"), charEnd: text.indexOf("Kolona") + 6, observedAt: "2026-10-19", confidence: 1, matchKind: "deterministic" })
    .returning({ id: mentions.id });
  return { kolona, versionId: v.versionId, chunkId: v.chunkIds[0]!, mentionId: m!.id, text, sourceId: v.sourceId, documentId: v.documentId };
}

/** A finished extraction run of `purpose` with a done unit for the scene's (version, object). */
async function extractionRun(tx: Db, s: Scene, purpose: ExtractionPurpose, startedAt: Date) {
  const id = await insertTestExtractionRun(tx, {
    runId: await insertTestRun(tx),
    model: purpose === "comparison" ? "claude-opus-5-5" : taskConfig.model,
    promptVersion: taskConfig.promptVersion,
    purpose,
    status: "finished",
    startedAt,
  });
  await tx.insert(extractionUnits).values({ extractionRunId: id, documentVersionId: s.versionId, geoObjectId: s.kolona, part: 0, level: "place", mentionIds: [s.mentionId], chunkIds: [s.chunkId], status: "done" });
  return id;
}

async function textFact(tx: Db, s: Scene, extractionRunId: string, attribute: string, value: unknown, quote: string, observedAt: string) {
  const start = s.text.indexOf(quote);
  const [row] = await tx
    .insert(facts)
    .values({
      geoObjectId: s.kolona,
      attribute,
      value,
      mentionId: s.mentionId,
      quote,
      quoteVerified: true,
      quoteChunkId: s.chunkId,
      quoteStart: start,
      quoteEnd: start + quote.length,
      observedAt,
      confidence: 0.8,
      extractionRunId,
      factSchemaVersion: "v2",
    })
    .returning({ id: facts.id });
  return row!.id;
}

describe("geoFacts", () => {
  it("geoFacts groups by attribute, newest first, and marks comparison facts inactive", () =>
    withRollback(async (tx) => {
      const text = "Kolona is a quiet bay. Holding is good in sand. Depth is 6 m in the middle.";
      const s = await scene(tx, text);
      const regular = await extractionRun(tx, s, "regular", new Date("2026-10-18T10:00:00Z"));
      const comparison = await extractionRun(tx, s, "comparison", new Date("2026-10-19T10:00:00Z"));
      const older = await textFact(tx, s, regular, "holding", "good", "Holding is good in sand", "2026-05-15");
      const depth = await textFact(tx, s, regular, "depth.min", 6, "Depth is 6 m in the middle", "2026-05-15");
      const compared = await textFact(tx, s, comparison, "holding", "moderate", "Holding is good in sand", "2026-10-19");
      // a computed fact of the same object counts as active
      const [c] = await tx
        .insert(computations)
        .values({ geoObjectId: s.kolona, kind: "shelter", inputs: {}, inputsHash: `h-${s.kolona}`, rulesVersion: "test" })
        .returning({ id: computations.id });
      const computed = (
        await tx
          .insert(facts)
          .values({ geoObjectId: s.kolona, attribute: "shelter.N", value: 0.4, computationId: c!.id, observedAt: "2026-10-01", confidence: 1, factSchemaVersion: "v2" })
          .returning({ id: facts.id })
      )[0]!.id;

      const all = await geoFacts(tx, s.kolona, { runs: "all" }, config);
      // fact schema order: shelter.<S> before depth before holding
      expect(all.map((g) => g.attribute)).toEqual(["shelter.N", "depth.min", "holding"]);
      const holding = all.find((g) => g.attribute === "holding")!.facts;
      expect(holding.map((f) => [f.id, f.active])).toEqual([
        [compared, false],
        [older, true],
      ]);
      expect(holding[1]).toMatchObject({
        origin: "text",
        quote: "Holding is good in sand",
        context: { before: "Kolona is a quiet bay. ", quote: "Holding is good in sand", after: ". Depth is 6 m in the middle." },
        source: { domain: expect.stringMatching(/\.test\.invalid$/), weight: 0.6 },
        documentId: s.documentId,
        model: taskConfig.model,
        extractionRunId: regular,
        observedAt: "2026-05-15",
      });
      expect(all[0]!.facts).toMatchObject([{ id: computed, origin: "computed", active: true, quote: null, context: null, source: null }]);

      const active = await geoFacts(tx, s.kolona, { runs: "active" }, config);
      expect(active.flatMap((g) => g.facts.map((f) => f.id)).sort()).toEqual([computed, depth, older].sort());
    }));
});

describe("geoMentions", () => {
  it("pages the mentions newest first with a snippet around the name", () =>
    withRollback(async (tx) => {
      const s = await scene(tx, "Wir ankerten in Kolona auf Sand.");
      const page = await geoMentions(tx, s.kolona, 1);
      expect(page.total).toBe(1);
      expect(page.rows).toEqual([
        expect.objectContaining({ id: s.mentionId, documentId: s.documentId, matchKind: "deterministic", confidence: 1, snippet: { before: "Wir ankerten in ", quote: "Kolona", after: " auf Sand." } }),
      ]);
      expect(MENTIONS_PER_PAGE).toBe(50);
      expect(await geoMentions(tx, s.kolona, 2)).toEqual({ rows: [], total: 1 });
    }));
});
