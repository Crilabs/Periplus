import { sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import type { AttributeProvenance, ProfileSnapshot } from "@/lib/domain/consolidation/types";
import { consolidateGeo } from "@/lib/domain/consolidation/store";
import { diffVersions, profileTimeline, timelineView } from "@/lib/domain/profile-timeline";
import { profileView } from "@/lib/domain/profile-view";
import { insertComputation, insertPlace, insertSource, insertTextFact } from "@/test/consolidation";
import { testDb, withRollback } from "@/test/db";

/* The timeline tab's data (Task 18): version diff, versions with their events, the profile as of a date. */

const db = testDb();
let today = "";
let tomorrow = "";
let yesterday = "";
beforeAll(async () => {
  const { rows } = await db.execute<{ today: string; tomorrow: string; yesterday: string }>(
    sql`select current_date::text as today, (current_date + 1)::text as tomorrow, (current_date - 1)::text as yesterday`,
  );
  ({ today, tomorrow, yesterday } = rows[0]!);
});

const prov = (confidenceClass: AttributeProvenance["confidenceClass"]): AttributeProvenance => ({
  origin: "text",
  rule: "default",
  confidence: confidenceClass === "high" ? 0.8 : 0.5,
  confidenceClass,
  observedAt: null,
  lastConfirmedAt: null,
  factIds: [],
  sourceKeys: [],
  computationIds: [],
  poiIds: [],
  expired: false,
  onlyGoneSources: false,
  conflictKey: null,
  observedMonths: [],
});

const snapshot = (version: number, attrs: Record<string, [unknown, AttributeProvenance["confidenceClass"]]>): ProfileSnapshot => ({
  version,
  validFrom: "2026-10-01",
  attributes: Object.fromEntries(Object.entries(attrs).map(([k, [v]]) => [k, v])),
  provenance: Object.fromEntries(Object.entries(attrs).map(([k, [, c]]) => [k, prov(c)])),
  conflicts: [],
  gaps: [],
  sourcesCount: 1,
  documentsCount: 1,
  confidence: null,
  contentHash: String(version),
  rulesVersion: "v1",
  factSchemaVersion: "v2",
});

describe("profile timeline", () => {
  it("diffVersions reports added, removed, changed and class-only changes", () => {
    const a = snapshot(1, { holding: ["good", "high"], "services.water": [true, "medium"], hazards: [[{ kind: "rock", name: null }], "medium"], seabed: ["sand", "high"] });
    const b = snapshot(2, { holding: ["good", "medium"], "services.water": [false, "medium"], seabed: ["sand", "high"], "depth.min": [4, "high"] });
    expect(diffVersions(a, b)).toEqual([
      { attribute: "depth.min", kind: "added", before: null, after: 4, classBefore: null, classAfter: "high" },
      { attribute: "hazards", kind: "removed", before: [{ kind: "rock", name: null }], after: null, classBefore: "medium", classAfter: null },
      { attribute: "holding", kind: "class", before: "good", after: "good", classBefore: "high", classAfter: "medium" },
      { attribute: "services.water", kind: "changed", before: true, after: false, classBefore: "medium", classAfter: "medium" },
    ]);
    expect(diffVersions(a, a)).toEqual([]);
  });

  it("the timeline lists versions with event counts and events newest first", () =>
    withRollback(async (tx) => {
      const { objectId } = await insertPlace(tx, { name: "Zeitbucht" });
      await insertComputation(tx, objectId, "shelter", { "shelter.N": 0.6 });
      await insertTextFact(tx, objectId, await insertSource(tx, "forum", 0.4), { attribute: "services.water", value: true, observedAt: "2025-07-01" });
      await consolidateGeo(tx, objectId, { today });
      await insertTextFact(tx, objectId, await insertSource(tx, "pilot_guide", 0.9), { attribute: "services.water", value: false, observedAt: "2026-07-01", confidence: 0.9 });
      await consolidateGeo(tx, objectId, { today: tomorrow });

      const t = await profileTimeline(tx, objectId);
      expect(t.versions.map((v) => [v.version, v.validFrom, v.events])).toEqual([
        [1, today, 1],
        [2, tomorrow, 1],
      ]);
      expect(t.events.map((e) => [e.type, e.attribute, e.profileVersion])).toEqual([
        ["changed", "services.water", 2],
        ["place_new", null, 1],
      ]);
      expect(t.events[0]).toMatchObject({ oldValue: true, newValue: false, severity: "notable" });
      expect(t.events[0]!.seq).toBeGreaterThan(t.events[1]!.seq);

      // the tab: version 2 with its diff to version 1; an asOf picks version 1
      const latest = await timelineView(tx, objectId, { today });
      expect(latest.view!.snapshot.version).toBe(2);
      expect(latest.diff).toEqual([
        expect.objectContaining({ attribute: "services.water", kind: "changed", before: true, after: false }),
      ]);
      const first = await timelineView(tx, objectId, { asOf: today, version: 2, today });
      expect(first).toMatchObject({ asOf: today, asOfInvalid: false, diff: null });
      expect(first.view!.snapshot.version).toBe(1);
    }));

  it("asOf before the first version yields no profile", () =>
    withRollback(async (tx) => {
      const { objectId } = await insertPlace(tx, { name: "Frühbucht" });
      await insertComputation(tx, objectId, "shelter", { "shelter.N": 0.6 });
      await consolidateGeo(tx, objectId, { today });
      expect(await profileView(tx, objectId, { asOf: yesterday, today })).toBeNull();
      expect(await timelineView(tx, objectId, { asOf: yesterday, today })).toMatchObject({ view: null, asOf: yesterday, asOfInvalid: false });
      // an impossible date is refused before profileAsOf and the newest version is shown
      const invalid = await timelineView(tx, objectId, { asOf: "2026-02-30", today });
      expect(invalid).toMatchObject({ asOf: null, asOfInvalid: true });
      expect(invalid.view!.snapshot.version).toBe(1);
    }));
});
