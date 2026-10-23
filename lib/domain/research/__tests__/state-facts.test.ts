import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { getConfig } from "@/lib/config";
import { berthStates, sources } from "@/lib/db/schema";
import { bundleFacts, freeFacts, storeStateFacts, validGroups, type FreeFact } from "@/lib/domain/research/state-facts";
import { insertPlace } from "@/test/consolidation";
import { withRollback } from "@/test/db";
import { seedPage, seedStatement, seedVersion } from "@/test/research-state";

/*
 * Free facts and their bundling (plan N4a task 3): the representative is always an existing fact, a newer fact of the
 * group supersedes an older one, and a broken group never invents or loses a fact.
 */

const config = getConfig();

const free = (id: string, o: Partial<FreeFact> = {}): FreeFact => ({
  id, subject: "berth", subjectName: null, subjectCategory: null, statement: `statement ${id}`, observedAt: "2025-06-15", tone: null, safety: false, domain: `${id}.example`, ...o,
});
const offered = (facts: FreeFact[]) => facts.map((f) => ({ id: f.id, observedAt: f.observedAt }));

describe("bundleFacts", () => {
  it("two equivalent facts of two domains become one with two mentions", () => {
    const facts = [free("a", { observedAt: "2024-05-01" }), free("b")];
    const out = bundleFacts(facts, offered(facts), [{ ids: ["a", "b"], representative: "b", superseded: [] }]);
    expect(out).toEqual([expect.objectContaining({ factId: "b", statement: "statement b", mentions: 2 })]);
  });

  it("counts distinct registrable domains, not facts", () => {
    const facts = [free("a", { domain: "guide.example" }), free("b", { domain: "guide.example" }), free("c", { domain: "other.example" })];
    const [fact] = bundleFacts(facts, offered(facts), [{ ids: ["a", "b", "c"], representative: "a", superseded: [] }]);
    expect(fact!.mentions).toBe(2);
  });

  it("a newer closed fact supersedes the older good one: only the newer remains, the superseded source does not count", () => {
    const facts = [
      free("old", { observedAt: "2019-07-01", statement: "good taverna", tone: "positive", subject: "landside", subjectName: "Taverna Nikos", subjectCategory: "food", domain: "a.example" }),
      free("new", { observedAt: "2025-07-01", statement: "taverna closed", tone: "negative", subject: "landside", subjectName: "Taverna Nikos", subjectCategory: "food", domain: "b.example" }),
    ];
    const out = bundleFacts(facts, offered(facts), [{ ids: ["old", "new"], representative: "new", superseded: ["old"] }]);
    expect(out).toEqual([
      { factId: "new", subject: "landside", subjectName: "Taverna Nikos", subjectCategory: "food", statement: "taverna closed", observedAt: "2025-07-01", tone: "negative", safety: false, mentions: 1 },
    ]);
  });

  it("safety survives: any standing member's safety is kept, a superseded one's is not", () => {
    const facts = [
      free("a", { observedAt: "2024-01-01", safety: true, tone: "negative" }),
      free("b", { observedAt: "2025-01-01", tone: "neutral" }),
      free("c", { observedAt: "2023-01-01", safety: true, tone: "negative" }),
    ];
    const [kept] = bundleFacts(facts, offered(facts), [{ ids: ["a", "b"], representative: "b", superseded: [] }]);
    // the model chose the neutral fact; the negative safety member represents the group instead
    expect(kept).toMatchObject({ factId: "a", safety: true, tone: "negative", mentions: 2 });
    const [dropped] = bundleFacts(facts, offered(facts), [{ ids: ["c", "a", "b"], representative: "b", superseded: ["c", "a"] }]);
    expect(dropped).toMatchObject({ factId: "b", safety: false, tone: "neutral" });
  });

  it("safety of a non-negative member is carried by the chosen representative", () => {
    const facts = [free("x", { safety: true, tone: "neutral" }), free("y", { observedAt: "2026-01-01", tone: "positive" })];
    const [out] = bundleFacts(facts, offered(facts), [{ ids: ["x", "y"], representative: "y", superseded: [] }]);
    expect(out).toMatchObject({ factId: "y", safety: true, tone: "positive" });
  });

  it("without an answer every fact stands alone with one mention, in order", () => {
    const facts = [free("a"), free("b")];
    expect(bundleFacts(facts, offered(facts), null).map((f) => [f.factId, f.mentions])).toEqual([["a", 1], ["b", 1]]);
  });

  it("a group with an unknown id is dropped, its known facts stand alone; facts the answer lacks stand alone", () => {
    const facts = [free("a"), free("b"), free("c")];
    const out = bundleFacts(facts, offered(facts), [{ ids: ["a", "zzz"], representative: "a", superseded: [] }]);
    expect(out.map((f) => [f.factId, f.mentions])).toEqual([["a", 1], ["b", 1], ["c", 1]]);
  });

  it("a fact no longer free leaves its group, and a group without its representative dissolves", () => {
    const all = [free("a"), free("b"), free("c")];
    const now = [all[0]!, all[2]!];
    const out = bundleFacts(now, offered(all), [{ ids: ["a", "b", "c"], representative: "b", superseded: [] }]);
    expect(out.map((f) => f.factId)).toEqual(["a", "c"]);
    const kept = bundleFacts(now, offered(all), [{ ids: ["a", "b", "c"], representative: "a", superseded: [] }]);
    expect(kept.map((f) => [f.factId, f.mentions])).toEqual([["a", 2]]);
  });
});

describe("validGroups", () => {
  const facts = [free("a", { observedAt: "2019-01-01" }), free("b", { observedAt: "2025-01-01" }), free("c", { observedAt: "2025-01-01" })];
  const check = (g: Parameters<typeof validGroups>[1]) => validGroups(offered(facts), g).length;

  it("keeps a sound group and rejects each kind of broken one", () => {
    expect(check([{ ids: ["a", "b"], representative: "b", superseded: ["a"] }])).toBe(1);
    expect(check([{ ids: ["a", "b"], representative: "c", superseded: [] }])).toBe(0); // representative outside ids
    expect(check([{ ids: ["a", "a"], representative: "a", superseded: [] }])).toBe(0); // repeated id
    expect(check([{ ids: [], representative: "a", superseded: [] }])).toBe(0);
    expect(check([{ ids: ["a", "b"], representative: "b", superseded: ["c"] }])).toBe(0); // superseded outside ids
    expect(check([{ ids: ["a", "b"], representative: "b", superseded: ["b"] }])).toBe(0); // representative superseded
    expect(check([{ ids: ["b", "c"], representative: "b", superseded: ["c"] }])).toBe(0); // nothing strictly newer
    expect(check([{ ids: ["a", "b"], representative: "a", superseded: ["b"] }])).toBe(0); // older cannot supersede newer
  });

  it("an id claimed by an earlier group drops the later group", () => {
    const out = validGroups(offered(facts), [
      { ids: ["a", "b"], representative: "b", superseded: [] },
      { ids: ["b", "c"], representative: "c", superseded: [] },
    ]);
    expect(out).toHaveLength(1);
  });
});

describe("freeFacts", () => {
  it("reads the statements of done units of the active extractor on current versions of live pages", () =>
    withRollback(async (tx) => {
      const { placeId } = await insertPlace(tx);
      const guide = await seedPage(tx, config, placeId, { domain: "guide.example" });
      const ended = await seedPage(tx, config, placeId, { domain: "ended.example" });
      const rejected = await seedPage(tx, config, placeId, { domain: "rejected.example" });
      const keep = await seedStatement(tx, placeId, guide, { statement: "Quiet at night", observedAt: "2024-05-15", tone: "positive", safety: true });
      const landside = await seedStatement(tx, placeId, rejected, { statement: "Bakery by the quay", observedAt: "2025-05-15", subjectName: "Bakery Eleni", subjectCategory: "bakery" });
      await seedStatement(tx, placeId, ended, { statement: "Swell in the afternoon" });
      await seedStatement(tx, placeId, await seedPage(tx, config, placeId, { model: "old-model" }), { statement: "stale model" });
      await seedStatement(tx, placeId, await seedPage(tx, config, placeId, { status: "failed" }), { statement: "failed unit" });
      await seedStatement(tx, placeId, await seedPage(tx, config, placeId, { generated: true }), { statement: "generated page" });
      await tx.update(sources).set({ status: "rejected" }).where(eq(sources.id, rejected.sourceId));
      await tx.update(sources).set({ validTo: "2026-10-01" }).where(eq(sources.id, ended.sourceId));

      const rows = await freeFacts(tx, placeId, config);
      expect(rows).toEqual([
        { id: keep, subject: "berth", subjectName: null, subjectCategory: null, statement: "Quiet at night", observedAt: "2024-05-15", tone: "positive", safety: true, domain: "guide.example" },
        { id: landside, subject: "landside", subjectName: "Bakery Eleni", subjectCategory: "bakery", statement: "Bakery by the quay", observedAt: "2025-05-15", tone: null, safety: false, domain: "rejected.example" },
      ]);
    }));

  it("reads the current version of a document only and never a structured fact", () =>
    withRollback(async (tx) => {
      const { placeId } = await insertPlace(tx);
      const p = await seedPage(tx, config, placeId, {});
      await seedStatement(tx, placeId, p, { statement: "on the old version" });
      const current = await seedStatement(tx, placeId, await seedVersion(tx, config, placeId, p.documentId), { statement: "on the new version" });
      expect((await freeFacts(tx, placeId, config)).map((f) => f.id)).toEqual([current]);
    }));
});

describe("storeStateFacts", () => {
  it("creates the row with empty other columns, then changes facts only", () =>
    withRollback(async (tx) => {
      const { placeId } = await insertPlace(tx);
      const a = bundleFacts([free("a")], [], null);
      await storeStateFacts(tx, placeId, a);
      const [row] = await tx.select().from(berthStates).where(eq(berthStates.placeId, placeId));
      expect(row).toMatchObject({ core: {}, gaps: [], landing: [], nearby: [], facts: a });

      await tx.update(berthStates).set({ gaps: ["holding"], landing: [{ kind: "beach", lon: 1, lat: 2, geoObjectId: null, description: null }] }).where(eq(berthStates.placeId, placeId));
      const b = bundleFacts([free("b")], [], null);
      await storeStateFacts(tx, placeId, b);
      const [after] = await tx.select().from(berthStates).where(eq(berthStates.placeId, placeId));
      expect(after).toMatchObject({ gaps: ["holding"], facts: b });
      expect(after!.landing).toHaveLength(1);
    }));

  it("no facts clears an existing row and creates none", () =>
    withRollback(async (tx) => {
      const { placeId } = await insertPlace(tx);
      await storeStateFacts(tx, placeId, []);
      expect(await tx.select().from(berthStates).where(eq(berthStates.placeId, placeId))).toHaveLength(0);
      await storeStateFacts(tx, placeId, bundleFacts([free("a")], [], null));
      await storeStateFacts(tx, placeId, []);
      const [row] = await tx.select().from(berthStates).where(eq(berthStates.placeId, placeId));
      expect(row!.facts).toEqual([]);
    }));
});
