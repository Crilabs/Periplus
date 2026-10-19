import { and, eq, sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/lib/db/client";
import { facts, profileSummaries, profiles, reviewDecisions, reviewTasks } from "@/lib/db/schema";
import { getConsolidationConfig } from "@/lib/config";
import type { AttributeProvenance } from "@/lib/domain/consolidation/types";
import { ruleLabel } from "@/lib/domain/consolidation/format";
import { consolidateGeo } from "@/lib/domain/consolidation/store";
import { mapLayer } from "@/lib/domain/map-data";
import { ENTRY_REMOVAL_TASK, ProfileChanged, removeProfileEntry } from "@/lib/domain/profile-entry-removal";
import { profileAttributeFacts, profileEntryKey, profileView } from "@/lib/domain/profile-view";
import { DecisionNotAllowed } from "@/lib/domain/review-decisions";
import { insertComputation, insertPlace, insertSource, insertTextFact } from "@/test/consolidation";
import { testDb, withRollback } from "@/test/db";

/*
 * The profile tab's data (Task 17): rows with provenance, the facts of one attribute, older versions, the map colour
 * and „Eintrag entfernen“. Everything in withRollback on synthetic places outside the pilot box; the map test uses
 * its own coordinate (20.43° E / 34.43° N) and asserts only on its own places.
 */

const db = testDb();
let today = "";
let tomorrow = "";
beforeAll(async () => {
  const { rows } = await db.execute<{ today: string; tomorrow: string }>(
    sql`select current_date::text as today, (current_date + 1)::text as tomorrow`,
  );
  today = rows[0]!.today;
  tomorrow = rows[0]!.tomorrow;
});

const cfg = getConsolidationConfig("v1");

/** A confirmed anchorage with computed shelter and depth, a pilot-guide holding and two hazards from a trip report. */
async function profiledPlace(tx: Db, o: { lon?: number; lat?: number } = {}) {
  const { objectId, placeId } = await insertPlace(tx, { name: "Profilbucht", lon: o.lon, lat: o.lat });
  const computation = await insertComputation(tx, objectId, "shelter", { "shelter.N": 0.6, "depth.min": 4 });
  const guide = await insertSource(tx, "pilot_guide", 0.9);
  const holdingFact = await insertTextFact(tx, objectId, guide, { attribute: "holding", value: "good", confidence: 0.9, observedAt: "2026-06-01" });
  const report = await insertSource(tx, "trip_report", 0.6);
  const hazardFact = await insertTextFact(tx, objectId, report, {
    attribute: "hazards",
    value: [
      { kind: "rock", name: "Xera" },
      { kind: "shoal", name: null },
    ],
    observedAt: "2026-06-02",
  });
  const prohibitionFact = await insertTextFact(tx, objectId, guide, {
    attribute: "prohibitions",
    value: [
      { kind: "anchoring", months: [7, 8] },
      { kind: "fishing", months: null },
    ],
    observedAt: "2026-06-03",
    confidence: 0.9,
  });
  await consolidateGeo(tx, objectId, { today });
  return { objectId, placeId, computation, holdingFact, hazardFact, prohibitionFact, guide, report };
}

describe("profileView", () => {
  it("profileView lists rows in schema order with provenance and gaps", () =>
    withRollback(async (tx) => {
      const p = await profiledPlace(tx);
      // an open uncertain change of holding (read from the task, ruling M5-P8)
      const [task] = await tx
        .insert(reviewTasks)
        .values({ kind: "uncertain_change", subjectType: "profile_attribute", subjectId: `${p.objectId}:holding`, context: { key: "k1", newValue: "poor" } })
        .returning({ id: reviewTasks.id });
      await tx.insert(profileSummaries).values({ geoObjectId: p.objectId, profileVersion: 1, text: "Gute Bucht.", status: "ok", attempts: 1, model: "m", promptVersion: 1 });

      const view = (await profileView(tx, p.objectId, { today }))!;
      expect(view).toMatchObject({ latest: true, versions: 1, summary: { text: "Gute Bucht.", status: "ok" } });
      expect(view.snapshot.version).toBe(1);
      const keys = view.rows.map((r) => r.attribute);
      // fact schema order: shelter before depth before holding before hazards; exclude after the schema keys
      expect(keys.indexOf("shelter.N")).toBeLessThan(keys.indexOf("depth.min"));
      expect(keys.indexOf("depth.min")).toBeLessThan(keys.indexOf("holding"));
      expect(keys.indexOf("holding")).toBeLessThan(keys.indexOf("hazards"));
      expect(keys.at(-1)).toBe("exclude");
      // identity fields in the head, not as rows
      expect(keys.some((k) => k.startsWith("geo.") || k.startsWith("place."))).toBe(false);
      expect(view.identity.map((i) => i.attribute)).toContain("geo.name");
      expect(view.identity.find((i) => i.attribute === "geo.name")?.display).toBe("Profilbucht");

      const shelter = view.rows.find((r) => r.attribute === "shelter.N")!;
      expect(shelter).toMatchObject({
        label: "Schutz aus N",
        display: "0,60",
        origin: "computed",
        rule: "shelter",
        ruleLabel: "Berechnung, Text korrigiert um höchstens ±0,3, Häfen mind. 0,8",
        pending: null,
        conflict: null,
      });
      const holding = view.rows.find((r) => r.attribute === "holding")!;
      expect(holding).toMatchObject({
        display: "gut",
        origin: "text",
        rule: "holding",
        observedAt: "2026-06-01",
        expired: false,
        factCount: 1,
        pending: { taskId: task!.id, key: "k1", newValue: "poor", display: "schlecht" },
      });
      const hazards = view.rows.find((r) => r.attribute === "hazards")!;
      expect(hazards.entries).toEqual([
        { key: profileEntryKey("hazards", { kind: "rock", name: "Xera" }, cfg), entry: { kind: "rock", name: "Xera" }, display: "Fels (Xera)", inputIds: [p.hazardFact], removable: true },
        { key: profileEntryKey("hazards", { kind: "shoal", name: null }, cfg), entry: { kind: "shoal", name: null }, display: "Untiefe", inputIds: [p.hazardFact], removable: true },
      ]);
      // gaps with their reason: no seabed fact and no computation gap for it
      expect(view.gaps).toContainEqual({ attribute: "seabed", label: "Grund", reason: "no_facts" });
      expect(view.gaps.some((g) => g.attribute === "holding")).toBe(false);
    }));

  it("profileAttributeFacts returns exactly the provenance facts with quote context", () =>
    withRollback(async (tx) => {
      const p = await profiledPlace(tx);
      // the holding row cites its one fact, not the prohibitions fact of the same pilot guide
      const holding = (await profileAttributeFacts(tx, p.objectId, 1, "holding"))!;
      expect(holding.facts.map((f) => f.id)).toEqual([p.holdingFact]);
      expect(holding.facts[0]!.context).toMatchObject({ quote: "good holding in sand" });
      expect(holding.facts[0]!.source).toMatchObject({ weight: 0.9 });
      expect(holding.computations).toEqual([]);

      const shelter = (await profileAttributeFacts(tx, p.objectId, 1, "shelter.N"))!;
      expect(shelter.computations.map((c) => [c.id, c.kind])).toEqual([[p.computation.computationId, "shelter"]]);
      const { rows } = await tx.execute<{ provenance: Record<string, { factIds: string[] }> }>(
        sql`select provenance from profiles where geo_object_id = ${p.objectId} and version = 1`,
      );
      expect(shelter.facts.map((f) => f.id).sort()).toEqual([...rows[0]!.provenance["shelter.N"]!.factIds].sort());

      const hazards = (await profileAttributeFacts(tx, p.objectId, 1, "hazards"))!;
      expect(hazards.entries!.map((e) => e.facts.map((f) => f.id))).toEqual([[p.hazardFact], [p.hazardFact]]);
      expect(await profileAttributeFacts(tx, p.objectId, 1, "no.such")).toBeNull();
      expect(await profileAttributeFacts(tx, p.objectId, 9, "holding")).toBeNull();
    }));

  it("an older version is shown with ?version", () =>
    withRollback(async (tx) => {
      const p = await profiledPlace(tx);
      await insertTextFact(tx, p.objectId, await insertSource(tx, "pilot_guide", 0.9), { attribute: "services.water", value: true, observedAt: "2026-07-01", confidence: 0.9 });
      expect(await consolidateGeo(tx, p.objectId, { today: tomorrow })).toMatchObject({ status: "created", version: 2 });

      const latest = (await profileView(tx, p.objectId, { today }))!;
      expect(latest).toMatchObject({ latest: true, versions: 2 });
      expect(latest.rows.find((r) => r.attribute === "services.water")?.display).toBe("ja");

      const old = (await profileView(tx, p.objectId, { version: 1, today }))!;
      expect(old).toMatchObject({ latest: false, versions: 2 });
      expect(old.snapshot).toMatchObject({ version: 1, validFrom: today });
      expect(old.rows.some((r) => r.attribute === "services.water")).toBe(false);
      // an older version offers no removal
      expect(old.rows.find((r) => r.attribute === "hazards")!.entries!.every((e) => !e.removable)).toBe(true);

      expect((await profileView(tx, p.objectId, { asOf: today, today }))!.snapshot.version).toBe(1);
      expect((await profileView(tx, p.objectId, { asOf: tomorrow, today }))!.snapshot.version).toBe(2);
      expect(await profileView(tx, p.objectId, { version: 3, today })).toBeNull();
      await expect(profileView(tx, p.objectId, { asOf: "2026-02-30" })).rejects.toThrow();
    }));

  it("map places carry the latest profile confidence", () =>
    withRollback(async (tx) => {
      const lon = 20.43;
      const lat = 34.43;
      const p = await profiledPlace(tx, { lon, lat });
      const bare = await insertPlace(tx, { lon: lon + 0.01, lat, name: "Ohne Profil" });
      const [{ confidence }] = (await tx
        .select({ confidence: profiles.confidence })
        .from(profiles)
        .where(and(eq(profiles.geoObjectId, p.objectId), eq(profiles.version, 1)))) as [{ confidence: number }];
      // a newer version with another confidence wins
      await tx.insert(profiles).select(
        sql`select gen_random_uuid(), geo_object_id, 2, valid_from, attributes, provenance, conflicts, gaps, sources_count,
                   documents_count, 0.3::real, 'other', fact_schema_version, rules_version, run_id, now()
            from profiles where geo_object_id = ${p.objectId} and version = 1`,
      );

      const layer = await mapLayer(tx, "places", [lon - 0.05, lat - 0.05, lon + 0.05, lat + 0.05]);
      const own = new Map(layer.features.map((f) => [f.properties!.id as string, f.properties!]));
      expect(confidence).not.toBeCloseTo(0.3);
      expect(own.get(p.placeId)).toMatchObject({ profileClass: "low" });
      expect(own.get(p.placeId)!.profileConfidence).toBeCloseTo(0.3);
      expect(own.get(p.placeId)).not.toHaveProperty("profile");
      expect(own.get(bare.placeId)).toMatchObject({ profileConfidence: null, profileClass: null, hasProfile: false });
      expect(own.get(p.placeId)).toMatchObject({ hasProfile: true });
    }));

  it("a place whose newest profile has no confidence is told apart from one without a profile", () =>
    withRollback(async (tx) => {
      const lon = 20.45;
      const lat = 34.43;
      const p = await profiledPlace(tx, { lon, lat });
      await tx.insert(profiles).select(
        sql`select gen_random_uuid(), geo_object_id, 2, valid_from, attributes, provenance, conflicts, gaps, sources_count,
                   documents_count, null::real, 'nullconf', fact_schema_version, rules_version, run_id, now()
            from profiles where geo_object_id = ${p.objectId} and version = 1`,
      );
      const layer = await mapLayer(tx, "places", [lon - 0.05, lat - 0.05, lon + 0.05, lat + 0.05]);
      const own = layer.features.find((f) => f.properties!.id === p.placeId)!.properties!;
      expect(own).toMatchObject({ profileConfidence: null, profileClass: null, hasProfile: true });
    }));

  it("the rule sentence follows the rules version's thresholds", () => {
    expect(ruleLabel("shelter", cfg)).toBe("Berechnung, Text korrigiert um höchstens ±0,3, Häfen mind. 0,8");
    const changed = { ...cfg, rules: { ...cfg.rules, shelter: { ...cfg.rules.shelter, maxCorrection: 0.2 } } };
    expect(ruleLabel("shelter", changed)).toBe("Berechnung, Text korrigiert um höchstens ±0,2, Häfen mind. 0,8");
    expect(ruleLabel("union", cfg)).toBe("Vereinigung, sortiert nach Zahl unabhängiger Nennungen");
  });
});

describe("„Eintrag entfernen“", () => {
  const rock = { kind: "rock", name: "Xera" };

  it("removing a hazard writes the review fact { remove } and the next consolidation drops the entry", () =>
    withRollback(async (tx) => {
      const p = await profiledPlace(tx);
      const key = profileEntryKey("hazards", rock, cfg);
      const { factId } = await removeProfileEntry(tx, { geoObjectId: p.objectId, attribute: "hazards", entryKey: key, version: 1, decidedBy: "admin@example.invalid" });

      const [fact] = await tx.select().from(facts).where(eq(facts.id, factId));
      expect(fact).toMatchObject({ attribute: "hazards", value: { remove: rock }, confidence: 0.95, observedAt: today, geoObjectId: p.objectId });
      const [decision] = await tx.select().from(reviewDecisions).where(eq(reviewDecisions.id, fact!.reviewDecisionId!));
      expect(decision!.decision).toEqual({ action: "remove_entry", attribute: "hazards", entry: rock });
      const [task] = await tx.select().from(reviewTasks).where(eq(reviewTasks.id, decision!.taskId));
      expect(task).toMatchObject({ ...ENTRY_REMOVAL_TASK, status: "decided", subjectId: `${p.objectId}:hazards` });
      // the decision did not consolidate
      expect((await profileView(tx, p.objectId, { today }))!.versions).toBe(1);

      expect(await consolidateGeo(tx, p.objectId, { today })).toMatchObject({ status: "created", version: 2 });
      const view = (await profileView(tx, p.objectId, { today }))!;
      expect(view.snapshot.attributes.hazards).toEqual([{ kind: "shoal", name: null }]);
      const { rows } = await tx.execute<{ type: string; severity: string }>(
        sql`select type::text, severity::text from change_events where geo_object_id = ${p.objectId} and attribute = 'hazards'`,
      );
      expect(rows).toEqual([{ type: "changed", severity: "safety" }]);
    }));

  it("removing a text prohibition writes the remaining kinds; a computed one cannot be removed", () =>
    withRollback(async (tx) => {
      const p = await profiledPlace(tx);
      await removeProfileEntry(tx, { geoObjectId: p.objectId, attribute: "prohibitions", entryKey: "fishing", version: 1, decidedBy: "admin@example.invalid" });
      const review = await tx.select({ value: facts.value }).from(facts).where(and(eq(facts.geoObjectId, p.objectId), sql`${facts.reviewDecisionId} is not null`));
      expect(review.map((r) => r.value)).toEqual([[{ kind: "anchoring", months: [7, 8] }]]);
      await consolidateGeo(tx, p.objectId, { today });
      expect((await profileView(tx, p.objectId, { today }))!.snapshot.attributes.prohibitions).toEqual([{ kind: "anchoring", months: [7, 8] }]);

      // an attribute that is no safety list, an unknown entry and a stale version are refused
      await expect(removeProfileEntry(tx, { geoObjectId: p.objectId, attribute: "holding", entryKey: "x", version: 2, decidedBy: "a" })).rejects.toBeInstanceOf(DecisionNotAllowed);
      await expect(removeProfileEntry(tx, { geoObjectId: p.objectId, attribute: "hazards", entryKey: "nope", version: 2, decidedBy: "a" })).rejects.toBeInstanceOf(DecisionNotAllowed);
      await expect(
        removeProfileEntry(tx, { geoObjectId: p.objectId, attribute: "hazards", entryKey: profileEntryKey("hazards", rock, cfg), version: 1, decidedBy: "a" }),
      ).rejects.toBeInstanceOf(ProfileChanged);
    }));

  it("consecutive prohibition removals on the same shown version compose (ruling M5-I-R2)", () =>
    withRollback(async (tx) => {
      const { objectId } = await insertPlace(tx, { name: "Verbotsbucht" });
      const guide = await insertSource(tx, "pilot_guide", 0.9);
      const [a, b, c] = [
        { kind: "anchoring", months: [7, 8] },
        { kind: "fishing", months: null },
        { kind: "swimming", months: null },
      ];
      await insertTextFact(tx, objectId, guide, { attribute: "prohibitions", value: [a, b, c], observedAt: "2026-06-03", confidence: 0.9 });
      await consolidateGeo(tx, objectId, { today });
      const by = "admin@example.invalid";
      await removeProfileEntry(tx, { geoObjectId: objectId, attribute: "prohibitions", entryKey: "anchoring", version: 1, decidedBy: by });
      // the follow-up run has not written version 2 yet: version 1 is still the one shown
      await removeProfileEntry(tx, { geoObjectId: objectId, attribute: "prohibitions", entryKey: "fishing", version: 1, decidedBy: by });
      const review = await tx
        .select({ value: facts.value })
        .from(facts)
        .where(and(eq(facts.geoObjectId, objectId), sql`${facts.reviewDecisionId} is not null`))
        .orderBy(sql`${facts.createdAt} desc`);
      expect(review[0]!.value).toEqual([c]);
      await consolidateGeo(tx, objectId, { today });
      expect((await profileView(tx, objectId, { today }))!.snapshot.attributes.prohibitions).toEqual([c]);
    }));

  it("an entry's computation and POI inputs are identified per entry, not only counted", () =>
    withRollback(async (tx) => {
      const p = await insertPlace(tx, { name: "Eintragsbucht" });
      const poi = await insertPlace(tx, { name: "Mole", lon: 21.01 });
      const computation = await insertComputation(tx, p.objectId, "shelter", { "shelter.N": 0.6 });
      const key = profileEntryKey("hazards", rock, cfg);
      const prov: AttributeProvenance = {
        origin: "text", rule: "union", confidence: 0.6, confidenceClass: "medium", observedAt: null, lastConfirmedAt: null,
        factIds: [], sourceKeys: [], computationIds: ["not-a-uuid"], poiIds: ["not-a-uuid"], expired: false, onlyGoneSources: false, conflictKey: null, observedMonths: [],
        entryFactIds: { [key]: [`computation:${computation.computationId}`, `poi:${poi.objectId}`, `computation:${poi.objectId}`] },
      };
      await tx.insert(profiles).values({
        geoObjectId: p.objectId, version: 1, validFrom: today, attributes: { hazards: [rock] }, provenance: { hazards: prov },
        sourcesCount: 1, documentsCount: 1, contentHash: "entry-inputs", factSchemaVersion: "v2", rulesVersion: "v1",
      });
      const detail = (await profileAttributeFacts(tx, p.objectId, 1, "hazards"))!;
      // ids that are no uuid never reach a query (M-2)
      expect([detail.computations, detail.pois]).toEqual([[], []]);
      expect(detail.entries![0]!.otherInputs).toEqual([
        { type: "computation", id: computation.computationId, kind: "shelter", createdAt: expect.any(Date) },
        { type: "poi", id: poi.objectId, name: "Mole" },
        // a reference that no longer resolves stays listed, without kind
        { type: "computation", id: poi.objectId, kind: null, createdAt: null },
      ]);
    }));

  it("a computed restricted-area prohibition is not removable", () =>
    withRollback(async (tx) => {
      const { objectId } = await insertPlace(tx, { name: "Sperrbucht" });
      const entry = { kind: "military", restrictedAreaId: "00000000-0000-4000-8000-000000000001", sourceRef: null, share: 0.4, anchoringBan: true };
      await insertComputation(tx, objectId, "restriction", { prohibitions: [entry] });
      await consolidateGeo(tx, objectId, { today });
      const row = (await profileView(tx, objectId, { today }))!.rows.find((r) => r.attribute === "prohibitions")!;
      expect(row.entries).toMatchObject([{ entry, removable: false }]);

      await expect(
        removeProfileEntry(tx, { geoObjectId: objectId, attribute: "prohibitions", entryKey: profileEntryKey("prohibitions", entry, cfg), version: 1, decidedBy: "a" }),
      ).rejects.toBeInstanceOf(DecisionNotAllowed);
    }));

  it("a removal never takes the profile lock (ruling M5-F-R4)", () =>
    withRollback(async (tx) => {
      // the profile row inserted directly: a consolidation here would hold the lock itself until the rollback
      const p = await insertPlace(tx, { name: "Sperrfrei" });
      await tx.insert(profiles).values({
        geoObjectId: p.objectId,
        version: 1,
        validFrom: today,
        attributes: { hazards: [rock] },
        provenance: {},
        sourcesCount: 1,
        documentsCount: 1,
        contentHash: "test",
        factSchemaVersion: "v2",
        rulesVersion: "v1",
      });
      // another connection holds the object's profile lock; a removal waiting for it would fail after 300 ms
      let release!: () => void;
      const held = new Promise<void>((resolve) => (release = resolve));
      let locked!: () => void;
      const isLocked = new Promise<void>((resolve) => (locked = resolve));
      const holder = db.transaction(async (other) => {
        await other.execute(sql`select pg_advisory_xact_lock(hashtext(${`profile:${p.objectId}`}))`);
        locked();
        await held;
      });
      await isLocked;
      try {
        await tx.execute(sql`set local lock_timeout = '300ms'`);
        await expect(
          removeProfileEntry(tx, { geoObjectId: p.objectId, attribute: "hazards", entryKey: profileEntryKey("hazards", rock, cfg), version: 1, decidedBy: "a" }),
        ).resolves.toMatchObject({ factId: expect.any(String) });
        // the same lock taken here does wait: the guard is real
        await expect(tx.transaction((sp) => sp.execute(sql`select pg_advisory_xact_lock(hashtext(${`profile:${p.objectId}`}))`))).rejects.toThrow();
      } finally {
        release();
        await holder;
      }
    }));
});
