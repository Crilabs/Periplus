import { describe, expect, it } from "vitest";
import { getConsolidationConfig } from "@/lib/config";
import { type BuiltProfile, buildProfile } from "@/lib/domain/consolidation/build";
import { diffProfiles, severityFor } from "@/lib/domain/consolidation/changes";
import type { ProfileContext } from "@/lib/domain/consolidation/inputs";
import type { ConsolidationInput, ProfileSnapshot } from "@/lib/domain/consolidation/types";
import { computed, review, text, TODAY } from "@/test/fixtures/consolidation/scenarios";

/* diffProfiles and severityFor are pure: profiles built from constructed inputs, the previous one as stored (JSON). */

const cfg = getConsolidationConfig();

function context(over: Partial<ProfileContext> = {}): ProfileContext {
  return {
    level: "place",
    place: { id: "place-1", kind: "anchorage", status: "confirmed", statusReason: null, position: { lon: 21, lat: 35.2 }, publicId: "sp_1" },
    identity: { name: "Kolona", parentId: "island-1", geometryHash: "hash-1" },
    tileCycleDays: 30,
    areaId: "area-1",
    documentsCount: 2,
    sourcesCount: 2,
    computationGaps: {},
    resolutions: new Map(),
    decidedUncertainKeys: new Set(),
    decidedConflictKeys: new Set(),
    withdrawnFactIds: new Set(),
    withdrawnSourceKeys: new Set(),
    openTasks: new Map(),
    ...over,
  };
}

/** The computed basis every scenario shares: shelter, depth and seabed away from class boundaries. */
function basis(): ConsolidationInput[] {
  const comp = (attribute: string, value: unknown, confidence = 0.55) =>
    computed({ attribute, value, confidence, factId: `fact-${attribute}`, computationId: "comp-1", sourceKey: "computed:shelter", observedAt: "2026-09-01", lastConfirmedAt: "2026-09-01" });
  return [comp("shelter.N", 0.6), comp("depth.min", 4, 0.85), comp("seabed", [{ type: "sand", share: 1 }], 0.85)];
}

const guideWater = () =>
  text({ factId: "fact-guide-water", attribute: "services.water", value: true, sourceKey: "source:guide", sourceWeight: 0.9, confidence: 0.9, observedAt: "2025-07-01", lastConfirmedAt: "2026-10-01" });

function build(inputs: ConsolidationInput[], ctx: ProfileContext = context(), today = TODAY): BuiltProfile {
  return buildProfile({ inputs, context: ctx, derived: { quietness: null, importance: null }, today, cfg, schemaVersion: "v2", rulesVersion: "v1" });
}

/** A built profile as `profiles` stores and `latestProfile` reads it. */
function stored(p: BuiltProfile, version = 1, validFrom = "2026-10-01"): ProfileSnapshot {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { support, ...rest } = p;
  return JSON.parse(JSON.stringify({ ...rest, version, validFrom })) as ProfileSnapshot;
}

const diff = (prev: ProfileSnapshot | null, next: BuiltProfile, ctx: ProfileContext = context(), today = TODAY) =>
  diffProfiles(prev, next, { cfg, level: ctx.level, context: ctx, today });

describe("severityFor", () => {
  it.each([
    ["shelter.N", 0.6, 0.35, "safety"],
    ["shelter.N", 0.6, 0.45, "info"],
    ["shelter.N", 0.6, 0.4, "info"],
    ["services.water", true, false, "notable"],
    ["exclude", { excluded: false, reason: null }, { excluded: true, reason: "military" }, "safety"],
    ["depth.min", 4, 2.5, "safety"],
    ["max_draft", 2.5, 2.0, "safety"],
    ["holding", "good", "poor", "info"],
    ["hazards", [], [{ kind: "rock", name: "Xera" }], "safety"],
    ["restricted_zones", [], [{ kind: "military", name: "Zone A" }], "safety"],
    ["highlight.food", { present: true, names: [] }, { present: false, names: [] }, "notable"],
    ["occupancy", { "7": "full" }, { "7": "moderate" }, "notable"],
  ])("severity of %s %j → %j is %s", (a, o, n, s) => expect(severityFor(a, o, n, cfg)).toBe(s));
});

describe("diffProfiles", () => {
  it("taverna yes → no from a pilot guide (0.9) is changed and notable", () => {
    const yes = text({ attribute: "highlight.food", value: { present: true, names: ["Taverna Kostas"] }, sourceKey: "source:forum", sourceWeight: 0.4, observedAt: "2019-07-01" });
    const no = text({ attribute: "highlight.food", value: { present: false, names: [] }, sourceKey: "source:guide", sourceWeight: 0.9, confidence: 0.9, observedAt: "2024-07-01" });
    const prev = stored(build([...basis(), yes]));
    const r = diff(prev, build([...basis(), yes, no]));
    expect(r.events).toEqual([
      {
        type: "changed",
        attribute: "highlight.food",
        oldValue: { present: true, names: ["Taverna Kostas"] },
        newValue: { present: false, names: [] },
        severity: "notable",
        details: {},
      },
    ]);
    expect(r.tasks).toEqual([]);
    expect(r.profile.attributes["highlight.food"]).toEqual({ present: false, names: [] });
    expect(r.versionNeeded).toBe(true);
  });

  it("a single forum (0.4) saying no is uncertain: old value kept, one task draft with event", () => {
    const prev = stored(build([...basis(), guideWater()]));
    const forum = text({ factId: "fact-forum-water", attribute: "services.water", value: false, sourceKey: "source:forum", sourceWeight: 0.4, observedAt: "2026-07-01" });
    const r = diff(prev, build([...basis(), guideWater(), forum]));

    expect(r.profile.attributes["services.water"]).toBe(true);
    expect(r.profile.provenance["services.water"]).toEqual(prev.provenance["services.water"]);
    expect(r.events).toEqual([]);
    expect(r.tasks).toHaveLength(1);
    const task = r.tasks[0]!;
    expect(task).toMatchObject({ kind: "uncertain_change", attribute: "services.water", priority: 1 });
    expect(task.key).toMatch(/^[0-9a-f]{16}$/);
    expect(task.context).toEqual({
      key: task.key,
      attribute: "services.water",
      oldValue: true,
      newValue: false,
      factIds: ["fact-forum-water"],
      sources: ["source:forum"],
    });
    expect(task.event).toEqual({ type: "uncertain", attribute: "services.water", oldValue: true, newValue: false, severity: "notable", details: { key: task.key } });
    // the old value and its provenance come back: same hash, no version
    expect(r.profile.contentHash).toBe(prev.contentHash);
    expect(r.versionNeeded).toBe(false);
  });

  it("two documents of one forum are still uncertain", () => {
    const prev = stored(build([...basis(), guideWater()]));
    const forum = (n: number) =>
      text({ factId: `fact-forum-${n}`, documentId: `doc-forum-${n}`, attribute: "services.water", value: false, sourceKey: "source:forum", sourceWeight: 0.4, observedAt: "2026-07-0" + n });
    const r = diff(prev, build([...basis(), guideWater(), forum(1), forum(2)]));
    expect(r.profile.attributes["services.water"]).toBe(true);
    expect(r.tasks.map((t) => [t.kind, t.context.factIds])).toEqual([["uncertain_change", ["fact-forum-1", "fact-forum-2"]]]);
  });

  it("two independent forums make it changed", () => {
    const prev = stored(build([...basis(), guideWater()]));
    const forum = (source: string) => text({ attribute: "services.water", value: false, sourceKey: source, sourceWeight: 0.4, observedAt: "2026-07-01" });
    const r = diff(prev, build([...basis(), guideWater(), forum("source:forum-a"), forum("source:forum-b")]));
    expect(r.profile.attributes["services.water"]).toBe(false);
    expect(r.events).toEqual([{ type: "changed", attribute: "services.water", oldValue: true, newValue: false, severity: "notable", details: {} }]);
    expect(r.tasks).toEqual([]);
    expect(r.versionNeeded).toBe(true);
  });

  it("a discarded uncertain key keeps the old value silently", () => {
    const prev = stored(build([...basis(), guideWater()]));
    const inputs = [...basis(), guideWater(), text({ factId: "fact-forum-water", attribute: "services.water", value: false, sourceKey: "source:forum", sourceWeight: 0.4, observedAt: "2026-07-01" })];
    const key = diff(prev, build(inputs)).tasks[0]!.key;

    const decided = context({ decidedUncertainKeys: new Set([key]) });
    const r = diff(prev, build(inputs, decided), decided);
    expect(r.profile.attributes["services.water"]).toBe(true);
    expect(r.events).toEqual([]);
    expect(r.tasks).toEqual([]);
    expect(r.versionNeeded).toBe(false);

    // another fact makes another key: a new task
    const more = [...inputs, text({ factId: "fact-forum-water-2", attribute: "services.water", value: false, sourceKey: "source:forum", sourceWeight: 0.4, observedAt: "2026-08-01" })];
    expect(diff(prev, build(more, decided), decided).tasks.map((t) => t.key)).not.toContain(key);
  });

  it("an unchanged profile needs no version and has no events", () => {
    const inputs = [...basis(), guideWater()];
    const r = diff(stored(build(inputs)), build(inputs));
    expect(r).toMatchObject({ events: [], tasks: [], versionNeeded: false });
  });

  it("a value without inputs stays without an event; it expires by its last confirmation", () => {
    const prev = stored(build([...basis(), guideWater()]));
    const r = diff(prev, build(basis()));
    expect(r.profile.attributes["services.water"]).toBe(true);
    expect(r.profile.gaps.map((g) => g.attribute)).not.toContain("services.water");
    expect(r).toMatchObject({ events: [], tasks: [], versionNeeded: false });

    // last confirmed 2026-10-01, a 30-day tile: expired after two cycles (61 days later)
    const later = "2026-12-01";
    const expired = diff(prev, build(basis(), context(), later), context(), later);
    expect(expired.profile.attributes["services.water"]).toBe(true);
    expect(expired.profile.provenance["services.water"]).toMatchObject({ expired: true, confidenceClass: "low" });
    expect(expired.events).toEqual([
      { type: "expired", attribute: "services.water", oldValue: true, newValue: true, severity: "notable", details: { lastConfirmedAt: "2026-10-01" } },
    ]);
    expect(expired.versionNeeded).toBe(true);
  });

  it("a value resting only on facts of an ended source is withdrawn, not kept (ruling M6-H-R1)", () => {
    const prev = stored(build([...basis(), guideWater()]));
    const ended = context({ withdrawnFactIds: new Set(["fact-guide-water"]) });
    const gone = diff(prev, build(basis(), ended), ended);
    expect(gone.profile.attributes["services.water"]).toBeUndefined();
    expect(gone.events).toEqual([expect.objectContaining({ type: "changed", attribute: "services.water", oldValue: true, newValue: null })]);
    expect(gone.versionNeeded).toBe(true);

    // a non-safety attribute: a single forum saying otherwise replaces it without the support rule (else uncertain,
    // see above); a safety attribute does not (ruling M6-FIN-R2, next test)
    const forum = text({ factId: "fact-forum-water", attribute: "services.water", value: false, sourceKey: "source:forum", sourceWeight: 0.4, observedAt: "2026-07-01" });
    const replaced = diff(prev, build([...basis(), forum], ended), ended);
    expect(replaced.profile.attributes["services.water"]).toBe(false);
    expect(replaced.tasks).toEqual([]);
    expect(replaced.events).toEqual([expect.objectContaining({ type: "changed", attribute: "services.water", oldValue: true, newValue: false })]);

    // one fact of a still counting source keeps it
    const partly = context({ withdrawnFactIds: new Set(["other-fact"]) });
    expect(diff(prev, build(basis(), partly), partly).profile.attributes["services.water"]).toBe(true);
  });

  it("a withdrawn safety value is not replaced by one weak text: null and a priority-2 uncertain_change (ruling M6-FIN-R2)", () => {
    // a Navily-style source gave the south sector 0.4; it ends, and one forum post (0.4) says 0.9
    const navily = text({ factId: "fact-navily-s", attribute: "shelter.S", value: 0.4, sourceKey: "source:navily", sourceWeight: 0.9, confidence: 0.9, observedAt: "2026-06-01" });
    const post = text({ factId: "fact-forum-s", attribute: "shelter.S", value: 0.9, sourceKey: "source:forum", sourceWeight: 0.4, observedAt: "2026-07-01" });
    const prev = stored(build([...basis(), navily]));
    expect(prev.attributes["shelter.S"]).toBe(0.4);
    const ended = { withdrawnFactIds: new Set(["fact-navily-s"]), withdrawnSourceKeys: new Set(["source:navily"]) };
    const ctx1 = context(ended);
    const r = diff(prev, build([...basis(), post], ctx1), ctx1);
    expect(r.profile.attributes["shelter.S"]).toBeUndefined();
    expect(r.profile.provenance["shelter.S"]).toBeUndefined();
    expect(r.profile.gaps).toContainEqual({ attribute: "shelter.S", reason: "in_review" });
    expect(r.events).toEqual([{ type: "changed", attribute: "shelter.S", oldValue: 0.4, newValue: null, severity: "safety", details: {} }]);
    expect(r.tasks).toHaveLength(1);
    const task = r.tasks[0]!;
    expect(task).toMatchObject({
      kind: "uncertain_change",
      attribute: "shelter.S",
      priority: 2,
      context: { attribute: "shelter.S", oldValue: null, newValue: 0.9, factIds: ["fact-forum-s"] },
      event: { type: "uncertain", attribute: "shelter.S", oldValue: null, newValue: 0.9, severity: "safety" },
    });
    expect(r.versionNeeded).toBe(true);

    // the next run while the task is open: still null, the task kept (no second event), no new version
    const ctx2 = context({ ...ended, openTasks: new Map([["uncertain_change:shelter.S", { taskId: "task-1", key: task.key }]]) });
    const again = diff(stored(r.profile, 2), build([...basis(), post], ctx2), ctx2);
    expect(again.profile.attributes["shelter.S"]).toBeUndefined();
    expect(again.events).toEqual([]);
    expect(again.tasks).toEqual([expect.objectContaining({ kind: "uncertain_change", attribute: "shelter.S", key: task.key, event: null })]);
    expect(again.versionNeeded).toBe(false);

    // discarded: stays null without a task
    const ctx3 = context({ ...ended, decidedUncertainKeys: new Set([task.key]) });
    const discarded = diff(stored(r.profile, 2), build([...basis(), post], ctx3), ctx3);
    expect(discarded.profile.attributes["shelter.S"]).toBeUndefined();
    expect(discarded.tasks).toEqual([]);
    expect(discarded.versionNeeded).toBe(false);

    // accepted: the review fact supports the value, which comes as new_attribute
    const accepted = review({ attribute: "shelter.S", value: 0.9, observedAt: TODAY });
    const applied = diff(stored(r.profile, 2), build([...basis(), post, accepted], ctx3), ctx3);
    expect(applied.profile.attributes["shelter.S"]).toBe(0.9);
    expect(applied.events).toEqual([expect.objectContaining({ type: "new_attribute", attribute: "shelter.S", newValue: 0.9 })]);
    expect(applied.tasks).toEqual([]);
  });

  it("a withdrawn safety value goes when two independent sources or a strong one bring another (ruling M6-FIN-R2)", () => {
    const navily = text({ factId: "fact-navily-draft", attribute: "max_draft", value: 3, sourceKey: "source:navily", sourceWeight: 0.9, confidence: 0.9, observedAt: "2026-06-01" });
    const prev = stored(build([...basis(), navily]));
    const ctx = context({ withdrawnFactIds: new Set(["fact-navily-draft"]), withdrawnSourceKeys: new Set(["source:navily"]) });
    const guide = text({ attribute: "max_draft", value: 2.5, sourceKey: "source:guide", sourceWeight: 0.9, confidence: 0.9, observedAt: "2026-07-01" });
    const r = diff(prev, build([...basis(), guide], ctx), ctx);
    expect(r.profile.attributes["max_draft"]).toBe(2.5);
    expect(r.events).toEqual([expect.objectContaining({ type: "changed", attribute: "max_draft", oldValue: 3, newValue: 2.5, severity: "safety" })]);
    expect(r.tasks).toEqual([]);
  });

  it("a withdrawn hazard list takes the entries a weak text names, each mention counts (ruling M6-FIN-R2, M5-F-R3 I-3)", () => {
    const rock = { kind: "rock", name: "Xera" };
    const shoal = { kind: "shoal", name: null };
    const navily = text({ factId: "fact-navily-hz", attribute: "hazards", value: [rock], sourceKey: "source:navily", sourceWeight: 0.9, confidence: 0.9, observedAt: "2026-06-01" });
    const post = text({ factId: "fact-forum-hz", attribute: "hazards", value: [shoal], sourceKey: "source:forum", sourceWeight: 0.4, observedAt: "2026-07-01" });
    const prev = stored(build([...basis(), navily]));
    const ctx = context({ withdrawnFactIds: new Set(["fact-navily-hz"]), withdrawnSourceKeys: new Set(["source:navily"]) });
    const r = diff(prev, build([...basis(), post], ctx), ctx);
    expect(r.profile.attributes["hazards"]).toEqual([shoal]);
    expect(r.events).toEqual([expect.objectContaining({ type: "changed", attribute: "hazards", oldValue: [rock], newValue: [shoal], severity: "safety" })]);
    expect(r.tasks).toEqual([]);
  });

  it("an open uncertain_change task holds back an unsupported new safety value, not a non-safety one (ruling M6-FIN-R2)", () => {
    const prev = stored(build(basis()));
    const post = text({ factId: "fact-forum-draft", attribute: "max_draft", value: 4, sourceKey: "source:forum", sourceWeight: 0.4, observedAt: "2026-07-01" });
    const water = text({ factId: "fact-forum-water", attribute: "services.water", value: true, sourceKey: "source:forum", sourceWeight: 0.4, observedAt: "2026-07-01" });
    const open = context({
      openTasks: new Map([
        ["uncertain_change:max_draft", { taskId: "task-1", key: "k-draft" }],
        ["uncertain_change:services.water", { taskId: "task-2", key: "k-water" }],
      ]),
    });
    const r = diff(prev, build([...basis(), post, water], open), open);
    expect(r.profile.attributes["max_draft"]).toBeUndefined();
    expect(r.profile.attributes["services.water"]).toBe(true);
    expect(r.events).toEqual([expect.objectContaining({ type: "new_attribute", attribute: "services.water" })]);
    expect(r.tasks).toEqual([expect.objectContaining({ kind: "uncertain_change", attribute: "max_draft", priority: 2, event: null })]);

    // without an open task the same value is new_attribute as before (M5)
    expect(diff(prev, build([...basis(), post])).events).toEqual([
      expect.objectContaining({ type: "new_attribute", attribute: "max_draft", newValue: 4 }),
    ]);
  });

  describe("the profile's in_review gap holds a weak safety value until support or a decision (ruling M6-FIN-R3)", () => {
    const navily = () => text({ factId: "fact-navily-s", attribute: "shelter.S", value: 0.4, sourceKey: "source:navily", sourceWeight: 0.9, confidence: 0.9, observedAt: "2026-06-01" });
    const post = () => text({ factId: "fact-forum-s", attribute: "shelter.S", value: 0.9, sourceKey: "source:forum", sourceWeight: 0.4, observedAt: "2026-07-01" });
    const ended = { withdrawnFactIds: new Set(["fact-navily-s"]), withdrawnSourceKeys: new Set(["source:navily"]) };
    /** The held profile after run 1 (Navily ended, one forum post) and the key of its task. */
    function held() {
      const ctx = context(ended);
      const r = diff(stored(build([...basis(), navily()])), build([...basis(), post()], ctx), ctx);
      expect(r.profile.gaps).toContainEqual({ attribute: "shelter.S", reason: "in_review" });
      return { prev: stored(r.profile, 2), key: r.tasks[0]!.key };
    }

    it("after a discard, a second weak post (a new key) stays null and opens a new task with its event", () => {
      const { prev, key } = held();
      const ctx = context({ ...ended, decidedUncertainKeys: new Set([key]) });
      const second = text({ factId: "fact-forum-s2", attribute: "shelter.S", value: 0.9, sourceKey: "source:forum", sourceWeight: 0.4, observedAt: "2026-08-01" });
      const r = diff(prev, build([...basis(), post(), second], ctx), ctx);
      expect(r.profile.attributes["shelter.S"]).toBeUndefined();
      expect(r.profile.gaps).toContainEqual({ attribute: "shelter.S", reason: "in_review" });
      expect(r.events).toEqual([]);
      expect(r.versionNeeded).toBe(false);
      expect(r.tasks).toHaveLength(1);
      expect(r.tasks[0]!.key).not.toBe(key);
      expect(r.tasks[0]).toMatchObject({
        kind: "uncertain_change",
        priority: 2,
        context: { oldValue: null, newValue: 0.9, factIds: ["fact-forum-s", "fact-forum-s2"] },
        event: { type: "uncertain", attribute: "shelter.S", oldValue: null, newValue: 0.9, severity: "safety" },
      });

      // the same discarded key alone stays null without a task
      const same = diff(prev, build([...basis(), post()], ctx), ctx);
      expect(same.profile.attributes["shelter.S"]).toBeUndefined();
      expect(same.tasks).toEqual([]);
    });

    it("a run without the fact keeps the gap; the fact returning after a superseded dismissal stays null and opens a task", () => {
      const { prev, key } = held();
      const ctx = context(ended);
      const without = diff(prev, build(basis(), ctx), ctx);
      expect(without.profile.attributes["shelter.S"]).toBeUndefined();
      expect(without.profile.gaps).toContainEqual({ attribute: "shelter.S", reason: "in_review" });
      expect(without.tasks).toEqual([]);
      expect(without.events).toEqual([]);

      // the store dismissed the open task as superseded (not decided): the fact returns with no open task
      const back = diff(stored(without.profile, 2), build([...basis(), post()], ctx), ctx);
      expect(back.profile.attributes["shelter.S"]).toBeUndefined();
      expect(back.events).toEqual([]);
      expect(back.tasks).toEqual([expect.objectContaining({ kind: "uncertain_change", key, priority: 2, event: expect.objectContaining({ type: "uncertain" }) })]);
    });

    it("an accepted change and a strong value end the gap", () => {
      const { prev, key } = held();
      const decided = context({ ...ended, decidedUncertainKeys: new Set([key]) });
      const accepted = review({ attribute: "shelter.S", value: 0.9, observedAt: TODAY });
      const applied = diff(prev, build([...basis(), post(), accepted], decided), decided);
      expect(applied.profile.attributes["shelter.S"]).toBe(0.9);
      expect(applied.profile.gaps.filter((g) => g.attribute === "shelter.S")).toEqual([]);
      expect(applied.tasks).toEqual([]);

      const ctx = context({ ...ended, openTasks: new Map([["uncertain_change:shelter.S", { taskId: "task-1", key }]]) });
      const guide = text({ factId: "fact-guide-s", attribute: "shelter.S", value: 0.7, sourceKey: "source:guide", sourceWeight: 0.9, confidence: 0.9, observedAt: "2026-08-01" });
      const strong = diff(prev, build([...basis(), post(), guide], ctx), ctx);
      expect(strong.profile.attributes["shelter.S"]).toBeDefined();
      expect(strong.profile.gaps.filter((g) => g.attribute === "shelter.S")).toEqual([]);
      expect(strong.events).toEqual([expect.objectContaining({ type: "new_attribute", attribute: "shelter.S" })]);
      expect(strong.tasks).toEqual([]);
      expect(strong.versionNeeded).toBe(true);
    });

    it("the held task shows both weak values of a conflict", () => {
      const guide = text({ factId: "fact-navily-draft", attribute: "max_draft", value: 3, sourceKey: "source:navily", sourceWeight: 0.9, confidence: 0.9, observedAt: "2026-06-01" });
      const ctx = context({ withdrawnFactIds: new Set(["fact-navily-draft"]), withdrawnSourceKeys: new Set(["source:navily"]) });
      const forum = text({ factId: "fact-forum-draft", attribute: "max_draft", value: 4, sourceKey: "source:forum", sourceWeight: 0.4, observedAt: "2026-07-01" });
      const trip = text({ factId: "fact-trip-draft", attribute: "max_draft", value: 2, sourceKey: "source:trip", sourceWeight: 0.4, observedAt: "2026-07-01" });
      const next = build([...basis(), forum, trip], ctx);
      const note = next.conflicts.find((c) => c.attribute === "max_draft");
      expect(note).toBeDefined();
      const r = diff(stored(build([...basis(), guide])), next, ctx);
      expect(r.profile.attributes["max_draft"]).toBeUndefined();
      expect(r.profile.gaps).toContainEqual({ attribute: "max_draft", reason: "in_review" });
      expect(r.tasks.filter((t) => t.kind === "conflict")).toEqual([]);
      const task = r.tasks.find((t) => t.kind === "uncertain_change")!;
      expect(task.context.conflict).toEqual({ key: note!.key, a: note!.a, b: note!.b, others: note!.others });
    });
  });

  it("a kept safety-list entry citing no fact while its removal waits is marked in_review (ruling M6-FIN-R3)", () => {
    const rock = { kind: "rock", name: "Xera" };
    const shoal = { kind: "shoal", name: null };
    const navily = text({ factId: "fact-navily-hz", attribute: "hazards", value: [rock], sourceKey: "source:navily", sourceWeight: 0.9, confidence: 0.9, observedAt: "2026-06-01" });
    const report = text({ factId: "fact-report-hz", attribute: "hazards", value: [shoal], sourceKey: "source:report", sourceWeight: 0.6, observedAt: "2026-06-01" });
    const prev = stored(build([...basis(), navily, report]));
    const ctx = context({ withdrawnFactIds: new Set(["fact-navily-hz"]), withdrawnSourceKeys: new Set(["source:navily"]) });
    const r = diff(prev, build([...basis(), report], ctx), ctx);
    expect(r.profile.attributes["hazards"]).toEqual(prev.attributes["hazards"]);
    const p = r.profile.provenance["hazards"]!;
    const [rockKey] = Object.entries(p.entryFactIds!).find(([, ids]) => ids.length === 0)!;
    expect(p.entryMarkers).toEqual({ [rockKey]: "in_review" });
    expect(r.versionNeeded).toBe(true);
    expect(Object.values(p.entryFactIds!).flat()).toEqual(["fact-report-hz"]);
    expect(r.tasks).toEqual([expect.objectContaining({ kind: "uncertain_change", attribute: "hazards", context: expect.objectContaining({ newValue: [shoal] }) })]);

    // once the change is decided the entry still stays (safe direction), without the marker
    const decided = context({ ...ctx, decidedUncertainKeys: new Set([r.tasks[0]!.key]) });
    const after = diff(stored(r.profile, 2), build([...basis(), report], decided), decided);
    expect(after.profile.attributes["hazards"]).toEqual(prev.attributes["hazards"]);
    expect(after.profile.provenance["hazards"]!.entryMarkers).toBeUndefined();
    expect(after.versionNeeded).toBe(true);
    expect(after.events).toEqual([]);
  });

  it("a kept value stops citing facts and sources that are withdrawn now (ruling M6-FIN-R2)", () => {
    const guide = guideWater();
    const report = text({ factId: "fact-report-water", attribute: "services.water", value: true, sourceKey: "source:report", sourceWeight: 0.6, observedAt: "2026-07-01", lastConfirmedAt: "2026-10-01" });
    const prev = stored(build([...basis(), guide, report]));
    expect(prev.provenance["services.water"]).toMatchObject({ factIds: ["fact-guide-water", "fact-report-water"] });
    // the guide ends; a single forum says otherwise: the value stays (uncertain), citing only the report
    const ctx = context({ withdrawnFactIds: new Set(["fact-guide-water"]), withdrawnSourceKeys: new Set(["source:guide"]) });
    const forum = text({ factId: "fact-forum-water", attribute: "services.water", value: false, sourceKey: "source:forum", sourceWeight: 0.4, observedAt: "2026-08-01" });
    const r = diff(prev, build([...basis(), forum], ctx), ctx);
    expect(r.profile.attributes["services.water"]).toBe(true);
    expect(r.profile.provenance["services.water"]).toMatchObject({ factIds: ["fact-report-water"], sourceKeys: ["source:report"] });
    expect(r.tasks).toEqual([expect.objectContaining({ kind: "uncertain_change", attribute: "services.water" })]);
    // the citations changed: a new version without an event, so the package stops naming the ended source (ruling M6-FIN-R3)
    expect(r.events).toEqual([]);
    expect(r.versionNeeded).toBe(true);
    expect(diff(stored(r.profile, 2), build([...basis(), forum], ctx), ctx).versionNeeded).toBe(false);
  });

  it("a newly expired value emits expired with its severity and last confirmation", () => {
    const depth = text({ attribute: "max_draft", value: 2.5, sourceKey: "source:guide", sourceWeight: 0.9, confidence: 0.9, observedAt: "2026-06-01", lastConfirmedAt: "2026-09-01" });
    const prev = stored(build([...basis(), depth]));
    const later = "2026-11-15";
    const r = diff(prev, build([...basis(), depth], context(), later), context(), later);
    expect(r.events).toEqual([
      { type: "expired", attribute: "max_draft", oldValue: 2.5, newValue: 2.5, severity: "safety", details: { lastConfirmedAt: "2026-09-01" } },
    ]);
    expect(r.versionNeeded).toBe(true);
    // already expired before: no second event
    const again = diff(stored(r.profile, 2, later), build([...basis(), depth], context(), "2026-11-16"), context(), "2026-11-16");
    expect(again.events).toEqual([]);
  });

  it("a new attribute emits new_attribute without an old value", () => {
    const prev = stored(build(basis()));
    const r = diff(prev, build([...basis(), guideWater()]));
    expect(r.events).toEqual([{ type: "new_attribute", attribute: "services.water", oldValue: null, newValue: true, severity: "notable", details: {} }]);
  });

  it("a crossed confidence class without another value is a version without an event (ruling M5-P25)", () => {
    const prev = stored(build(basis()));
    // the same shelter value with a confidence in the next class
    const crossed = basis().map((i) => (i.attribute === "shelter.N" ? { ...i, confidence: 0.75 } : i));
    const r = diff(prev, build(crossed));
    expect(r.events).toEqual([]);
    expect(r.versionNeeded).toBe(true);
  });

  it("first profile of a confirmed place emits only place_new", () => {
    const r = diff(null, build([...basis(), guideWater()]));
    expect(r.events).toEqual([{ type: "place_new", attribute: null, oldValue: null, newValue: "confirmed", severity: "info", details: {} }]);
    expect(r.tasks).toEqual([]);
    expect(r.versionNeeded).toBe(true);

    const candidate = context({ place: { ...context().place!, status: "candidate" } });
    expect(diff(null, build(basis(), candidate), candidate).events).toEqual([]);
  });

  it("a renamed object emits geo_changed, a newly abandoned place place_abandoned", () => {
    const prev = stored(build(basis()));
    const renamed = context({ identity: { ...context().identity, name: "Kolona Bay" } });
    expect(diff(prev, build(basis(), renamed), renamed).events).toEqual([
      { type: "geo_changed", attribute: "geo.name", oldValue: "Kolona", newValue: "Kolona Bay", severity: "info", details: {} },
    ]);

    const abandoned = context({ place: { ...context().place!, status: "abandoned" } });
    const r = diff(prev, build(basis(), abandoned), abandoned);
    expect(r.events).toEqual([{ type: "place_abandoned", attribute: null, oldValue: "confirmed", newValue: "abandoned", severity: "info", details: {} }]);
    expect(r.versionNeeded).toBe(true);
  });

  it("a candidate confirmed emits place_new, an exclusion changed with safety, another kind changed with info", () => {
    const candidate = context({ place: { ...context().place!, status: "candidate" } });
    const prev = stored(build(basis(), candidate));
    expect(diff(prev, build(basis())).events.map((e) => e.type)).toEqual(["place_new"]);

    const confirmed = stored(build(basis()));
    const excluded = context({ place: { ...context().place!, status: "no_anchoring", statusReason: "restricted:military:area-9" } });
    expect(diff(confirmed, build(basis(), excluded), excluded).events).toEqual([
      {
        type: "changed",
        attribute: "exclude",
        oldValue: { excluded: false, reason: null, detail: null },
        newValue: { excluded: true, reason: "military", detail: null },
        severity: "safety",
        details: {},
      },
    ]);
    const marina = context({ place: { ...context().place!, kind: "mooring_field" } });
    expect(diff(confirmed, build(basis(), marina), marina).events).toEqual([
      { type: "changed", attribute: "place.kind", oldValue: "anchorage", newValue: "mooring_field", severity: "info", details: {} },
    ]);
  });

  it("a conflict without resolution opens a conflict draft once", () => {
    const holding = [
      text({ attribute: "holding", value: "good", sourceKey: "source:a", sourceWeight: 0.6, observedAt: "2026-07-01" }),
      text({ attribute: "holding", value: "poor", sourceKey: "source:b", sourceWeight: 0.5, observedAt: "2026-07-02" }),
    ];
    const inputs = [...basis(), ...holding];
    const prev = stored(build(inputs));
    const r = diff(prev, build(inputs));
    const conflict = build(inputs).conflicts[0]!;
    expect(r.tasks).toEqual([
      {
        kind: "conflict",
        attribute: "holding",
        key: conflict.key,
        context: { key: conflict.key, attribute: "holding", a: conflict.a, b: conflict.b, others: conflict.others },
        priority: 1,
        event: null,
      },
    ]);
    expect(r.events).toEqual([]);
    expect(r.versionNeeded).toBe(false);
    // also on the first profile
    expect(diff(null, build(inputs)).tasks.map((t) => t.kind)).toEqual(["conflict"]);

    // a resolution or a decision for one value: no draft
    const seasonal = context({ resolutions: new Map([[conflict.key, "seasonal"]]) });
    expect(diff(prev, build(inputs, seasonal), seasonal).tasks).toEqual([]);
    const decided = context({ decidedConflictKeys: new Set([conflict.key]) });
    expect(diff(prev, build(inputs, decided), decided).tasks).toEqual([]);
  });

  it("a conflict on a safety attribute has priority 2", () => {
    const depth = [
      text({ attribute: "max_draft", value: 2.5, sourceKey: "source:a", sourceWeight: 0.6, observedAt: "2026-07-01" }),
      text({ attribute: "max_draft", value: 4, sourceKey: "source:b", sourceWeight: 0.5, observedAt: "2026-07-02" }),
    ];
    const r = diff(null, build([...basis(), ...depth]));
    expect(r.tasks.map((t) => [t.attribute, t.priority])).toEqual([["max_draft", 2]]);
  });

  it("a vanished computed value is dropped with its gap reason and emits changed → null (ruling M5-F-R3 I-1)", () => {
    const prev = stored(build(basis()));
    const withoutDepth = basis().filter((i) => i.attribute !== "depth.min");
    const gap = context({ computationGaps: { "depth.min": "no_bathymetry" } });
    const r = diff(prev, build(withoutDepth, gap), gap);
    expect(r.profile.attributes).not.toHaveProperty("depth.min");
    expect(r.profile.provenance).not.toHaveProperty("depth.min");
    expect(r.profile.gaps).toContainEqual({ attribute: "depth.min", reason: "no_bathymetry" });
    expect(r.events).toEqual([{ type: "changed", attribute: "depth.min", oldValue: 4, newValue: null, severity: "safety", details: {} }]);
    expect(r.versionNeeded).toBe(true);
  });

  it("the harbour floor goes when the kind changes; a vanished shelter value is safety", () => {
    const marina = context({ place: { ...context().place!, kind: "marina" } });
    const prev = stored(build(basis(), marina));
    expect(prev.attributes["shelter.S"]).toBe(0.8);
    const r = diff(prev, build(basis()));
    expect(r.profile.attributes).not.toHaveProperty("shelter.S");
    expect(r.events).toContainEqual({ type: "changed", attribute: "shelter.S", oldValue: 0.8, newValue: null, severity: "safety", details: {} });
    expect(r.events).toContainEqual({ type: "changed", attribute: "place.kind", oldValue: "marina", newValue: "anchorage", severity: "info", details: {} });
  });

  it("an uncertain run keeps the previous conflict note of the attribute (ruling M5-F-R3 I-2)", () => {
    const good = text({ attribute: "holding", value: "good", sourceKey: "source:a", sourceWeight: 0.6, observedAt: "2026-07-01" });
    const poor = text({ factId: "fact-poor", attribute: "holding", value: "poor", sourceKey: "source:b", sourceWeight: 0.5, observedAt: "2026-07-02" });
    const prev = stored(build([...basis(), good, poor]));
    expect(prev.conflicts.map((c) => c.attribute)).toEqual(["holding"]);
    // source a's statement is no longer among the inputs: no conflict, poor picked, but only one weak source has it
    const next = build([...basis(), poor]);
    expect(next.attributes["holding"]).toBe("poor");
    expect(next.conflicts).toEqual([]);

    const r = diff(prev, next);
    expect(r.profile.attributes["holding"]).toBe("good");
    expect(r.profile.conflicts).toEqual(prev.conflicts);
    expect(r.tasks.map((t) => t.kind).sort()).toEqual(["conflict", "uncertain_change"]);
    expect(r.versionNeeded).toBe(false);
  });

  it("an addition to a safety list is changed per entry, never withheld (ruling M5-F-R3 I-3)", () => {
    const rock = { kind: "rock", name: "Xera" };
    const shoal = { kind: "shoal", name: null };
    const forum = (factId: string, value: unknown, observedAt: string) =>
      text({ factId, attribute: "hazards", value, sourceKey: "source:forum", sourceWeight: 0.4, observedAt });
    const prev = stored(build([...basis(), forum("fact-rock", [rock], "2026-06-01")]));

    // one more forum document names a shoal: one source only, but an added hazard is never held back
    const r = diff(prev, build([...basis(), forum("fact-rock", [rock], "2026-06-01"), forum("fact-shoal", [shoal], "2026-07-01")]));
    expect(r.profile.attributes["hazards"]).toEqual(expect.arrayContaining([rock, shoal]));
    expect(r.profile.attributes["hazards"]).toHaveLength(2);
    expect(r.events).toEqual([
      { type: "changed", attribute: "hazards", oldValue: [rock], newValue: r.profile.attributes["hazards"], severity: "safety", details: {} },
    ]);
    expect(r.tasks).toEqual([]);
    expect(r.versionNeeded).toBe(true);

    // an addition together with a removal: the addition holds, the removal waits for review
    const swapped = diff(prev, build([...basis(), forum("fact-shoal", [shoal], "2026-07-01")]));
    expect(swapped.profile.attributes["hazards"]).toEqual([shoal, rock]);
    expect(swapped.events).toEqual([{ type: "changed", attribute: "hazards", oldValue: [rock], newValue: [shoal, rock], severity: "safety", details: {} }]);
    expect(swapped.tasks).toHaveLength(1);
    expect(swapped.tasks[0]).toMatchObject({ kind: "uncertain_change", attribute: "hazards", priority: 2, context: { oldValue: [shoal, rock], newValue: [shoal] } });
    // the task and its event show the profile's list after the accepted addition (ruling M5-F-R3 N-1)
    expect(swapped.tasks[0]!.event).toMatchObject({ type: "uncertain", oldValue: [shoal, rock], newValue: [shoal] });
    expect(swapped.profile.provenance["hazards"]!.entryFactIds).toEqual({
      [JSON.stringify(["shoal", null])]: ["fact-shoal"],
      [JSON.stringify(["rock", "Xera"])]: ["fact-rock"],
    });
  });

  it("a supported list without a text entry never drops it; only a review removal does (GR-1, SAF-1)", () => {
    const rock = { kind: "rock", name: "Xera" };
    const shoal = { kind: "shoal", name: null };
    const hz = (factId: string, source: string, value: unknown) =>
      text({ factId, attribute: "hazards", value, sourceKey: `source:${source}`, sourceWeight: 0.9, confidence: 0.9, observedAt: "2026-06-01" });
    const prev = stored(build([...basis(), hz("fact-rock", "guide", [rock])]));
    // two strong independent sources name only the shoal; the rock's own fact no longer counts (reprocess, prompt switch)
    const r = diff(prev, build([...basis(), hz("fact-a", "a", [shoal]), hz("fact-b", "b", [shoal])]));
    expect(r.profile.attributes["hazards"]).toEqual([shoal, rock]);
    expect(r.profile.provenance["hazards"]!.entryMarkers).toEqual({ [JSON.stringify(["rock", "Xera"])]: "in_review" });
    expect(r.events).toEqual([expect.objectContaining({ type: "changed", attribute: "hazards", oldValue: [rock], newValue: [shoal, rock] })]);
    expect(r.tasks).toEqual([expect.objectContaining({ kind: "uncertain_change", attribute: "hazards", priority: 2, context: expect.objectContaining({ newValue: [shoal] }) })]);

    // the accepted removal (`{ remove: [<entry>] }`, also when nothing names the rock any more) takes it out
    const removal = review({ attribute: "hazards", value: { remove: [rock] }, observedAt: TODAY });
    const removed = diff(prev, build([...basis(), hz("fact-a", "a", [shoal]), hz("fact-b", "b", [shoal]), removal]));
    expect(removed.profile.attributes["hazards"]).toEqual([shoal]);
    expect(removed.tasks).toEqual([]);
    const only = diff(prev, build([...basis(), removal]));
    expect(only.profile.attributes["hazards"]).toBeUndefined();
    expect(only.events).toEqual([expect.objectContaining({ type: "changed", attribute: "hazards", oldValue: [rock], newValue: null })]);
  });

  it("a kept value still confirmed by its source does not expire (ruling M5-F-R3 M-1)", () => {
    const prev = stored(build([...basis(), guideWater()]));
    // the guide is fetched again and still says yes; a newer forum says no (uncertain)
    const rechecked = { ...guideWater(), lastConfirmedAt: "2026-11-20" };
    const forum = text({ factId: "fact-forum-water", attribute: "services.water", value: false, sourceKey: "source:forum", sourceWeight: 0.4, observedAt: "2026-07-01", lastConfirmedAt: "2026-11-20" });
    const later = "2026-12-15";
    const r = diff(prev, build([...basis(), rechecked, forum], context(), later), context(), later);
    expect(r.profile.attributes["services.water"]).toBe(true);
    expect(r.profile.provenance["services.water"]).toMatchObject({ expired: false, lastConfirmedAt: "2026-11-20" });
    expect(r.events).toEqual([]);
    expect(r.tasks.map((t) => t.kind)).toEqual(["uncertain_change"]);
  });

  it("carried entries of a merged safety list follow the rule's order, not the history (ruling M5-F-R3 N-3)", () => {
    const wreck = { kind: "wreck", name: null };
    const rock = { kind: "rock", name: null };
    const shoal = { kind: "shoal", name: null };
    const forum = (source: string, value: unknown) =>
      text({ attribute: "hazards", value, sourceKey: `source:${source}`, sourceWeight: 0.4, observedAt: "2026-06-01" });
    // two sources name the wreck, one the rock: the union puts the wreck first
    const prev = stored(build([...basis(), forum("a", [wreck]), forum("b", [wreck]), forum("c", [rock])]));
    expect(prev.attributes["hazards"]).toEqual([wreck, rock]);

    // all three vanish, one forum names a shoal: the addition holds, the carried entries come by key
    const r = diff(prev, build([...basis(), forum("d", [shoal])]));
    expect(r.profile.attributes["hazards"]).toEqual([shoal, rock, wreck]);
  });

  it("a kept list no single input carries is confirmed again by its current inputs (ruling M5-F-R3 N-2)", () => {
    const doc = (factId: string, value: unknown, lastConfirmedAt: string) =>
      text({ factId, attribute: "mooring.types", value, sourceKey: "source:forum", sourceWeight: 0.4, observedAt: "2026-06-01", lastConfirmedAt });
    // two documents of one forum: the list [anchor, buoy] is carried by no single input
    const prev = stored(build([...basis(), doc("fact-anchor", ["anchor"], "2026-10-01"), doc("fact-buoy", ["buoy"], "2026-10-01")]));
    expect(prev.attributes["mooring.types"]).toEqual(["anchor", "buoy"]);

    // both are fetched again; a third document of the same forum adds a pontoon (one source: uncertain, kept)
    const later = "2026-12-15";
    const next = build(
      [...basis(), doc("fact-anchor", ["anchor"], "2026-11-20"), doc("fact-buoy", ["buoy"], "2026-11-20"), doc("fact-pontoon", ["pontoon"], "2026-11-20")],
      context(),
      later,
    );
    const r = diff(prev, next, context(), later);
    expect(r.profile.attributes["mooring.types"]).toEqual(["anchor", "buoy"]);
    expect(r.profile.provenance["mooring.types"]).toMatchObject({ expired: false, lastConfirmedAt: "2026-11-20" });
    expect(r.events).toEqual([]);

    // with one of its entries no longer named, the kept list is not refreshed and expires
    const partial = build([...basis(), doc("fact-anchor", ["anchor"], "2026-11-20"), doc("fact-pontoon", ["pontoon"], "2026-11-20")], context(), later);
    expect(diff(prev, partial, context(), later).profile.provenance["mooring.types"]).toMatchObject({ expired: true, lastConfirmedAt: "2026-10-01" });
  });

  it("a conflict decided for one value is marked decided (ruling M5-F-R3 M-2)", () => {
    const holding = [
      text({ attribute: "holding", value: "good", sourceKey: "source:a", sourceWeight: 0.6, observedAt: "2026-07-01" }),
      text({ attribute: "holding", value: "poor", sourceKey: "source:b", sourceWeight: 0.5, observedAt: "2026-07-02" }),
    ];
    const key = build([...basis(), ...holding]).conflicts[0]!.key;
    const decided = context({ decidedConflictKeys: new Set([key]) });
    expect(build([...basis(), ...holding], decided).conflicts.map((c) => [c.key, c.resolution])).toEqual([[key, "decided"]]);
  });
});
