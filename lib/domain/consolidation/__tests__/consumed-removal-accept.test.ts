import { and, eq, sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/lib/db/client";
import { reviewTasks } from "@/lib/db/schema";
import { consolidateGeo } from "@/lib/domain/consolidation/store";
import { newId } from "@/lib/domain/ids";
import { decideReviewTask } from "@/lib/domain/review-decisions";
import { removeProfileEntry } from "@/lib/domain/profile-entry-removal";
import { latestProfile } from "@/lib/domain/timeline";
import { insertComputation, insertExtraction, insertMention, insertMentionFact, insertPlace, insertSource } from "@/test/consolidation";
import { testDb, withRollback } from "@/test/db";

let today = "";
beforeAll(async () => {
  const { rows } = await testDb().execute<{ today: string }>(sql`select current_date::text as today`);
  today = rows[0]!.today;
});
const ban = { kind: "anchoring", months: null };
const rock = { kind: "rock", name: null };

async function openTasks(tx: Db, objectId: string, attribute: string) {
  return tx
    .select({ id: reviewTasks.id, context: reviewTasks.context })
    .from(reviewTasks)
    .where(and(eq(reviewTasks.subjectId, `${objectId}:${attribute}`), eq(reviewTasks.kind, "uncertain_change"), eq(reviewTasks.status, "open")));
}

async function scenario(tx: Db, attribute: "prohibitions" | "hazards", entry: unknown, lon: number, lat: number, f2Date: string) {
  const place = await insertPlace(tx, { lon, lat, name: `Rr ${newId().slice(-6)}` });
  await insertComputation(tx, place.objectId, "restriction", { prohibitions: [] }, { confidence: 0.9 });
  const s1 = await insertSource(tx, "pilot_guide", 0.9);
  const m1 = await insertMention(tx, place.objectId, { sourceId: s1, observedAt: "2026-06-01" });
  const r1 = await insertExtraction(tx, place.objectId, m1, { startedAt: new Date("2026-10-01T10:00:00Z") });
  await insertMentionFact(tx, place.objectId, m1, r1, { attribute, value: [entry], observedAt: "2026-06-01", confidence: 0.9 });
  await consolidateGeo(tx, place.objectId, { today });
  await tx.execute(sql`update extraction_runs set prompt_version = prompt_version - 1 where id = ${r1}`);
  await consolidateGeo(tx, place.objectId, { today });
  const [t1] = await openTasks(tx, place.objectId, attribute);
  // first removal, decided on 2026-10-10
  await decideReviewTask(tx, { taskId: t1!.id, decision: { action: "accept_change" }, decidedBy: "rr", taskKey: (t1!.context as { key: string }).key, now: new Date("2026-10-10T12:00:00Z") });
  await consolidateGeo(tx, place.objectId, { today });
  expect((await latestProfile(tx, place.objectId))?.attributes[attribute] ?? []).toEqual([]);
  // younger re-mention
  const s2 = await insertSource(tx, "pilot_guide", 0.9);
  const m2 = await insertMention(tx, place.objectId, { sourceId: s2, observedAt: f2Date });
  const r2 = await insertExtraction(tx, place.objectId, m2, { startedAt: new Date("2026-10-15T10:00:00Z") });
  await insertMentionFact(tx, place.objectId, m2, r2, { attribute, value: [entry], observedAt: f2Date, confidence: 0.9 });
  await consolidateGeo(tx, place.objectId, { today });
  expect((await latestProfile(tx, place.objectId))?.attributes[attribute]).toEqual([entry]);
  return { place, r2 };
}

describe("a removal consumed by a re-mention (GR-1, wave-1 re-review)", () => {
  for (const f2Date of ["2026-10-15", "TODAY"]) {
    it(`prohibitions: accepting the consumed-removal task removes the ban (re-mention ${f2Date})`, () =>
      withRollback(async (tx) => {
        const { place, r2 } = await scenario(tx, "prohibitions", ban, 19.771, 34.671, f2Date === "TODAY" ? today : f2Date);
        await tx.execute(sql`update extraction_runs set prompt_version = prompt_version - 1 where id = ${r2}`);
        await consolidateGeo(tx, place.objectId, { today });
        // stays with marker; consolidating again without a decision: one task, same key
        const [t2] = await openTasks(tx, place.objectId, "prohibitions");
        expect(t2).toBeDefined();
        await consolidateGeo(tx, place.objectId, { today });
        const again = await openTasks(tx, place.objectId, "prohibitions");
        expect(again.map((t) => (t.context as { key: string }).key)).toEqual([(t2!.context as { key: string }).key]);
        expect((await latestProfile(tx, place.objectId))?.attributes["prohibitions"]).toEqual([ban]);
        // accept today
        await decideReviewTask(tx, { taskId: again[0]!.id, decision: { action: "accept_change" }, decidedBy: "rr", taskKey: (again[0]!.context as { key: string }).key });
        await consolidateGeo(tx, place.objectId, { today });
        const p = await latestProfile(tx, place.objectId);
        expect(p?.attributes["prohibitions"] ?? []).toEqual([]);
        expect(await openTasks(tx, place.objectId, "prohibitions")).toEqual([]);
        await consolidateGeo(tx, place.objectId, { today });
        expect((await latestProfile(tx, place.objectId))?.attributes["prohibitions"] ?? []).toEqual([]);
        expect(await openTasks(tx, place.objectId, "prohibitions")).toEqual([]);
      }));
  }

  it("hazards: accepting the consumed-removal task removes the hazard", () =>
    withRollback(async (tx) => {
      const { place, r2 } = await scenario(tx, "hazards", rock, 19.772, 34.672, "2026-10-15");
      await tx.execute(sql`update extraction_runs set prompt_version = prompt_version - 1 where id = ${r2}`);
      await consolidateGeo(tx, place.objectId, { today });
      const [t2] = await openTasks(tx, place.objectId, "hazards");
      expect(t2).toBeDefined();
      await decideReviewTask(tx, { taskId: t2!.id, decision: { action: "accept_change" }, decidedBy: "rr", taskKey: (t2!.context as { key: string }).key });
      await consolidateGeo(tx, place.objectId, { today });
      expect((await latestProfile(tx, place.objectId))?.attributes["hazards"] ?? []).toEqual([]);
      expect(await openTasks(tx, place.objectId, "hazards")).toEqual([]);
    }));

  it("a second removal (Eintrag entfernen) after the re-mention holds, also once the re-mention stops counting", () =>
    withRollback(async (tx) => {
      const { place, r2 } = await scenario(tx, "prohibitions", ban, 19.773, 34.673, "2026-10-15");
      const p = (await latestProfile(tx, place.objectId))!;
      await removeProfileEntry(tx, { geoObjectId: place.objectId, attribute: "prohibitions", entryKey: "anchoring", version: p.version, decidedBy: "rr" });
      await consolidateGeo(tx, place.objectId, { today });
      expect((await latestProfile(tx, place.objectId))?.attributes["prohibitions"] ?? []).toEqual([]);
      await tx.execute(sql`update extraction_runs set prompt_version = prompt_version - 1 where id = ${r2}`);
      await consolidateGeo(tx, place.objectId, { today });
      expect((await latestProfile(tx, place.objectId))?.attributes["prohibitions"] ?? []).toEqual([]);
      expect(await openTasks(tx, place.objectId, "prohibitions")).toEqual([]);
    }));

  it("discard of the consumed-removal task, then Eintrag entfernen removes it for good", () =>
    withRollback(async (tx) => {
      const { place, r2 } = await scenario(tx, "prohibitions", ban, 19.774, 34.674, "2026-10-15");
      await tx.execute(sql`update extraction_runs set prompt_version = prompt_version - 1 where id = ${r2}`);
      await consolidateGeo(tx, place.objectId, { today });
      const [t2] = await openTasks(tx, place.objectId, "prohibitions");
      await decideReviewTask(tx, { taskId: t2!.id, decision: { action: "discard_change" }, decidedBy: "rr", taskKey: (t2!.context as { key: string }).key });
      await consolidateGeo(tx, place.objectId, { today });
      const p = (await latestProfile(tx, place.objectId))!;
      expect(p.attributes["prohibitions"]).toEqual([ban]);
      await removeProfileEntry(tx, { geoObjectId: place.objectId, attribute: "prohibitions", entryKey: "anchoring", version: p.version, decidedBy: "rr" });
      await consolidateGeo(tx, place.objectId, { today });
      expect((await latestProfile(tx, place.objectId))?.attributes["prohibitions"] ?? []).toEqual([]);
      expect(await openTasks(tx, place.objectId, "prohibitions")).toEqual([]);
    }));
});
