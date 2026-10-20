import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { MockModel } from "@/lib/ai/mock";
import { loadPrompt, renderPrompt } from "@/lib/ai/prompts";
import { summarizeProfileTask, type SummarizeInput } from "@/lib/ai/tasks/summarize-profile";
import { getConsolidationConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { profileSummaries, reviewTasks, textShingles } from "@/lib/db/schema";
import { consolidateGeo } from "@/lib/domain/consolidation/store";
import { sentenceCount, summaryInput } from "@/lib/domain/consolidation/summary";
import { shingleHashes } from "@/lib/domain/documents/shingles";
import { newId } from "@/lib/domain/ids";
import { decideReviewTask } from "@/lib/domain/review-decisions";
import { latestProfile } from "@/lib/domain/timeline";
import { summarizeProfile, summaryJobs, summaryTargets } from "@/lib/pipeline/consolidation/summary";
import { insertComputation, insertPlace, insertSource, insertTextFact } from "@/test/consolidation";
import { withRollback } from "@/test/db";
import { insertTestRun, insertTestVersion } from "@/test/text";

/*
 * Stage `consolidation.summary` against the database in withRollback, the model through MockModel (no network, no
 * spend). The archive check reads every chunk by design (ruling M5-P20): copied word runs are salted with a fresh uuid.
 */

const cfg = getConsolidationConfig();
const QUOTE = "good holding in sand";

/** A confirmed anchorage with computed shelter and depth and a quoted holding fact, consolidated in a fresh run. */
async function consolidated(tx: Db): Promise<{ objectId: string; runId: string }> {
  const { objectId } = await insertPlace(tx, { name: "Summarybucht" });
  await insertComputation(tx, objectId, "shelter", { "shelter.N": 0.62 });
  await insertComputation(tx, objectId, "depth", { "depth.min": 4 }, { confidence: 0.85 });
  await insertTextFact(tx, objectId, await insertSource(tx), { attribute: "holding", value: "good", observedAt: "2026-07-01" });
  const runId = await insertTestRun(tx);
  expect(await consolidateGeo(tx, objectId, { runId })).toMatchObject({ status: "created", version: 1 });
  return { objectId, runId };
}

/** A chunk of 30 words no other text has, with its shingles stored as the document store does; returns the words. */
async function archivedWords(tx: Db): Promise<string[]> {
  const salt = newId().replace(/-/g, "").replace(/\d/g, (d) => "ghijklmnop"[Number(d)]!);
  const words = Array.from({ length: 30 }, (_, i) => `${salt}${"abcdefghijklmnopqrstuvwxyz"[i % 26]}${"qrstuvwxyz"[Math.floor(i / 26)]}`);
  const text = words.join(" ");
  const v = await insertTestVersion(tx, [text]);
  await tx.insert(textShingles).values(shingleHashes(text, 15).map((shingleHash) => ({ shingleHash, chunkId: v.chunkIds[0]! })));
  return words;
}

/** A model answering `answers` in turn (the last one repeats), recording every input. */
function scripted(answers: Array<string | { tooLong: true }>): { model: MockModel; inputs: SummarizeInput[] } {
  const inputs: SummarizeInput[] = [];
  const model = new MockModel({
    "summarize-profile": (input) => {
      inputs.push(input as SummarizeInput);
      const answer = answers[Math.min(inputs.length - 1, answers.length - 1)]!;
      return { text: typeof answer === "string" ? answer : "Zu lang. ".repeat(120) };
    },
  });
  return { model, inputs };
}

const GOOD = "Die Summarybucht bietet guten Halt auf Sand. Aus Norden ist sie mäßig geschützt, die Tiefe beträgt mindestens 4 m.";

describe("profile summaries", () => {
  it("the input lists labelled values and never a quote", () =>
    withRollback(async (tx) => {
      const { objectId } = await consolidated(tx);
      const profile = (await latestProfile(tx, objectId))!;
      const input = summaryInput(profile, { level: "place", name: "Summarybucht", cfg });

      expect(input).toMatchObject({ kind: "spot", name: "Summarybucht", sentences: [2, 4], avoid: false });
      expect(input.lowConfidence).toBe(profile.confidence === null || profile.confidence < cfg.summary.lowConfidence);
      expect(input.facts).toEqual(
        expect.arrayContaining([
          { label: "Halt", value: "gut" },
          { label: "Schutz aus N", value: "0,62" },
          { label: "Tiefe min.", value: "4 m" },
        ]),
      );
      // identity fields and ids stay out; no quote, no fact id, no source
      const labels = input.facts.map((f) => f.label);
      expect(labels).not.toEqual(expect.arrayContaining(["Name", "Status", "Position", "Art", "Ausschluss"]));
      const sent = JSON.stringify(input);
      expect(sent).not.toContain(QUOTE);
      for (const id of profile.provenance["holding"]!.factIds) expect(sent).not.toContain(id);
      expect(sent).not.toContain(".test.invalid");

      const prompt = renderPrompt(loadPrompt("summarize-profile", 1).user, summarizeProfileTask.variables(input));
      expect(prompt).toContain("- Halt: gut");
      expect(prompt).toContain("rephrase: no");
    }));

  it("counts sentences without splitting at numbers or lower-case continuations", () => {
    expect(sentenceCount(GOOD)).toBe(2);
    expect(sentenceCount("Ein Satz ohne Punkt")).toBe(1);
    expect(sentenceCount("Tiefe ca. 4 m. Schutz 0,62! Gut?")).toBe(3);
    expect(sentenceCount("")).toBe(0);
  });

  it("does not split at German abbreviations before a capitalised noun", () => {
    expect(sentenceCount("Geeignet für Boote, z. B. Ankerlieger. Ca. Ankerplatz weiter nördlich, d. h. Schutz vor Meltemi.")).toBe(2);
    expect(sentenceCount("Siehe Nr. Fünf, bzw. Ankerplatz zwei u. a. Fels. Gut geschützt.")).toBe(2);
    expect(sentenceCount("Die Bucht ist ruhig. Das Wasser ist klar.")).toBe(2);
  });

  it("a copied first answer is regenerated with avoid and stored", () =>
    withRollback(async (tx) => {
      const { objectId, runId } = await consolidated(tx);
      const words = await archivedWords(tx);
      const { model, inputs } = scripted([`Die Bucht. ${words.slice(3, 19).join(" ")}. Sonst nichts.`, GOOD]);

      expect(await summaryJobs(tx, { id: runId, params: {} })).toEqual([{ key: `${objectId}:1`, geoObjectId: objectId, version: 1 }]);
      expect(await summarizeProfile(tx, { geoObjectId: objectId, version: 1, runId }, { model })).toEqual({ status: "ok", attempts: 2 });
      expect(inputs.map((i) => i.avoid)).toEqual([false, true]);
      const rows = await tx.select().from(profileSummaries).where(eq(profileSummaries.geoObjectId, objectId));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ profileVersion: 1, status: "ok", attempts: 2, text: GOOD, model: "claude-sonnet-5-5", promptVersion: 1, runId });

      // stored once: the plan has nothing left, a retried job writes nothing
      expect(await summaryJobs(tx, { id: runId, params: {} })).toEqual([]);
      expect(await summarizeProfile(tx, { geoObjectId: objectId, version: 1, runId }, { model })).toEqual({ status: "skipped", attempts: 0 });
      expect(inputs).toHaveLength(2);
    }));

  it("three failed attempts store an empty summary and open one failed_job task", () =>
    withRollback(async (tx) => {
      const { objectId, runId } = await consolidated(tx);
      const { model, inputs } = scripted(["Nur ein Satz.", { tooLong: true }, "Wieder nur ein Satz."]);

      expect(await summarizeProfile(tx, { geoObjectId: objectId, version: 1, runId }, { model })).toEqual({ status: "empty", attempts: 3 });
      expect(inputs.map((i) => i.avoid)).toEqual([false, true, true]);
      const rows = await tx.select().from(profileSummaries).where(eq(profileSummaries.geoObjectId, objectId));
      expect(rows).toEqual([expect.objectContaining({ profileVersion: 1, status: "empty", attempts: 3, text: null, runId })]);
      const tasks = await tx
        .select()
        .from(reviewTasks)
        .where(and(eq(reviewTasks.kind, "failed_job"), eq(reviewTasks.subjectType, "profile_summary"), eq(reviewTasks.subjectId, `${objectId}:1`)));
      expect(tasks).toHaveLength(1);
      expect(tasks[0]).toMatchObject({ status: "open", context: { geoObjectId: objectId, version: 1, attempts: 3, reasons: ["sentences", "invalid", "sentences"] } });

      // a retried job of the same run does not try again
      expect(await summarizeProfile(tx, { geoObjectId: objectId, version: 1, runId }, { model })).toEqual({ status: "skipped", attempts: 0 });
      expect(inputs).toHaveLength(3);

      // "Neu erzeugen": the decision asks for a summary-only run of the object, whose plan takes the newest version
      expect(await decideReviewTask(tx, { taskId: tasks[0]!.id, decision: { action: "regenerate_summary" }, decidedBy: "admin@example.invalid" })).toEqual({
        documentVersionIds: [],
        consolidate: { geoObjectId: objectId, stagesOnly: ["consolidation.summary"] },
        regenerateImage: null,
      });
      const again = await insertTestRun(tx);
      expect(await summaryTargets(tx, { id: again, params: { geoObjectIds: [objectId], stagesOnly: ["consolidation.summary"] } })).toEqual([{ geoObjectId: objectId, version: 1 }]);
    }));

  it("an unchanged profile gets no new summary", () =>
    withRollback(async (tx) => {
      const { objectId, runId } = await consolidated(tx);
      await summarizeProfile(tx, { geoObjectId: objectId, version: 1, runId }, scripted([GOOD]));

      const next = await insertTestRun(tx);
      expect(await consolidateGeo(tx, objectId, { runId: next })).toMatchObject({ status: "unchanged", version: 1 });
      expect(await summaryJobs(tx, { id: next, params: {} })).toEqual([]);
      // a summary-only run for the object finds its version summarized already
      expect(await summaryTargets(tx, { id: next, params: { geoObjectIds: [objectId], stagesOnly: ["consolidation.summary"] } })).toEqual([]);
      expect(await tx.select().from(profileSummaries).where(eq(profileSummaries.geoObjectId, objectId))).toHaveLength(1);
    }));
});

describe("an ok summary closes the open summary task", () => {
  it("storing an ok summary dismisses the object's open failed_job task (regeneration after an empty one)", () =>
    withRollback(async (tx) => {
      const { objectId, runId } = await consolidated(tx);
      await summarizeProfile(tx, { geoObjectId: objectId, version: 1, runId }, { model: scripted(["Nur ein Satz."]).model });
      const openTasks = () =>
        tx
          .select({ status: reviewTasks.status })
          .from(reviewTasks)
          .where(and(eq(reviewTasks.kind, "failed_job"), eq(reviewTasks.subjectType, "profile_summary"), eq(reviewTasks.subjectId, `${objectId}:1`)));
      expect(await openTasks()).toEqual([{ status: "open" }]);

      const again = await insertTestRun(tx);
      expect(await summarizeProfile(tx, { geoObjectId: objectId, version: 1, runId: again }, { model: scripted([GOOD]).model })).toEqual({ status: "ok", attempts: 1 });
      expect(await openTasks()).toEqual([{ status: "dismissed" }]);
    }));
});

describe("„Summary neu erzeugen“ (ruling M6-H-R1)", () => {
  const OTHER = "Die Summarybucht hat guten Ankergrund aus Sand. Nach Norden bietet sie mäßigen Schutz bei mindestens 4 m Tiefe.";
  const regenerateParams = (objectId: string) => ({ geoObjectIds: [objectId], stagesOnly: ["consolidation.summary"], regenerateSummary: true as const });

  it("a regenerate run targets a version that has an ok summary and stores a new one beside it, once per run", () =>
    withRollback(async (tx) => {
      const { objectId, runId } = await consolidated(tx);
      await summarizeProfile(tx, { geoObjectId: objectId, version: 1, runId }, scripted([GOOD]));

      const again = await insertTestRun(tx);
      expect(await summaryTargets(tx, { id: again, params: regenerateParams(objectId) })).toEqual([{ geoObjectId: objectId, version: 1 }]);
      expect(await summaryJobs(tx, { id: again, params: regenerateParams(objectId) })).toEqual([
        { key: `${objectId}:1`, geoObjectId: objectId, version: 1, regenerate: true },
      ]);
      expect(await summarizeProfile(tx, { geoObjectId: objectId, version: 1, runId: again, regenerate: true }, scripted([OTHER]))).toEqual({ status: "ok", attempts: 1 });
      // a retried job of the same run does not write a third one
      expect(await summarizeProfile(tx, { geoObjectId: objectId, version: 1, runId: again, regenerate: true }, scripted([OTHER]))).toEqual({ status: "skipped", attempts: 0 });
      const rows = await tx.select({ text: profileSummaries.text, runId: profileSummaries.runId }).from(profileSummaries).where(eq(profileSummaries.geoObjectId, objectId));
      expect(rows.map((r) => [r.runId, r.text]).sort()).toEqual([[runId, GOOD], [again, OTHER]].sort());
      // without the flag the ok summary still counts as done
      expect(await summaryTargets(tx, { id: again, params: { geoObjectIds: [objectId], stagesOnly: ["consolidation.summary"] } })).toEqual([]);
    }));

  it("regenerating needs the run id", () =>
    withRollback(async (tx) => {
      const { objectId } = await consolidated(tx);
      await expect(summarizeProfile(tx, { geoObjectId: objectId, version: 1, regenerate: true }, scripted([GOOD]))).rejects.toThrow(/run id/);
    }));
});
