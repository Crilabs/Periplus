import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { getConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { berthStates, geoObjects, reviewTasks } from "@/lib/db/schema";
import { newId } from "@/lib/domain/ids";
import type { NavilySpot } from "@/lib/domain/quality/navily-sample";
import { syncConflictTasks } from "@/lib/domain/research/gate-conflicts";
import { evaluateGateInput, gateConfigOf, loadGateInput, measureGate, type GateInput } from "@/lib/domain/research/gate-report";
import { decideReviewTask } from "@/lib/domain/review-decisions";
import { tileIdFor } from "@/lib/domain/tiles";
import { insertPlace } from "@/test/consolidation";
import { withRollback } from "@/test/db";
import { signalPage } from "@/test/research-signals";
import { insertTestSubdivision, insertTestTile } from "@/test/text";

/* The gate split into its database part (`loadGateInput`, plain JSON) and the pure evaluation; synthetic spots only. */

const cfg = getConfig();
const spot = (over: Partial<NavilySpot>): NavilySpot => ({ lat: 35.2, lon: 21.0, prot: null, seabeds: null, name: null, kind: "mooring", type: null, water: null, shop: null, ...over });

/** A subdivision with one worked-on tile and the given places (name, lon, independent domains, status). */
async function setup(tx: Db, list: Array<{ name: string; lon: number; domains: number; lat?: number; status?: "candidate" | "confirmed" }>) {
  const key = `XT-${newId()}`;
  const sub = await insertTestSubdivision(tx, key, [20.9, 35.0, 21.5, 35.5]);
  await insertTestTile(tx, tileIdFor(21.0, 35.2), null, sub.id);
  await insertTestTile(tx, tileIdFor(21.4, 35.2), null, sub.id); // not worked on
  const out = [];
  for (const p of list) {
    const place = await insertPlace(tx, { name: p.name, lon: p.lon, lat: p.lat ?? 35.2, status: p.status ?? "candidate" });
    await tx.update(geoObjects).set({ subdivisionId: sub.id }).where(eq(geoObjects.id, place.objectId));
    for (const d of ["a", "b", "c"].slice(0, p.domains)) await signalPage(tx, cfg, place, { domain: `${d}.example` });
    out.push(place);
  }
  return { key, places: out };
}

describe("gate split", () => {
  it("loadGateInput is JSON round-trippable and evaluates like measureGate", () =>
    withRollback(async (tx) => {
      const s = await setup(tx, [
        { name: "Zzyzx Cove", lon: 21.0, domains: 2 },
        { name: "Qwoxx Bay", lon: 21.05, domains: 2 },
        { name: "Zzyzx Edge", lon: 21.0008, lat: 35.1, domains: 2 },
        { name: "Qwoxx Shelf", lon: 21.2, lat: 35.1, domains: 0, status: "confirmed" },
      ]);
      const [known, unknown] = s.places;
      await tx.insert(berthStates).values({
        placeId: known!.placeId, gaps: [], facts: [], landing: [], nearby: [],
        core: { "shelter.N": { value: 0.9, confidence: 0.8, origin: "computed", observedAt: null, factIds: [] } },
      });
      // a human decision, so the decisions travel through the input
      await syncConflictTasks(tx, [unknown!.placeId], 2, s.places.map((p) => p.placeId));
      const [task] = await tx.select().from(reviewTasks).where(eq(reviewTasks.subjectId, unknown!.placeId));
      await decideReviewTask(tx, { taskId: task!.id, decision: { action: "berth" }, decidedBy: "admin@test.invalid" });
      const spots = [
        spot({ name: "Elsewhere Bight", lon: 25.5 }),
        spot({ name: "Zzyzx Cove" }),
        spot({ name: "Vrrmpf Haven", lon: 21.1 }),
        spot({ name: "Vrrmpf Far", lon: 21.4 }),
        spot({ name: "Zzyzx Edge", lon: 20.9998, lat: 35.1 }),
      ];

      const input = await loadGateInput(tx, s.key, cfg);
      expect(input.decisions).toEqual([[unknown!.placeId, "berth"]]);
      expect(input.tiles.worked).toEqual([tileIdFor(21.0, 35.2)]);
      expect(input.tiles.all).toHaveLength(2);
      expect(input.places.map((p) => p.placeId).sort()).toEqual(s.places.map((p) => p.placeId).sort());
      const roundTripped = JSON.parse(JSON.stringify(input)) as GateInput;
      expect(roundTripped).toEqual(input);
      const measured = await measureGate(tx, { subdivisionKey: s.key, spots }, cfg);
      expect(evaluateGateInput(roundTripped, spots)).toEqual(measured);
      expect(measured.unbacked).toHaveLength(1);
    }));

  it("evaluateGateInput uses the config in the input, not getConfig", () =>
    withRollback(async (tx) => {
      const s = await setup(tx, [{ name: "Zzyzx Cove", lon: 21.0, domains: 2 }]);
      const spots = [spot({ name: "Zzyzx Cove" })];
      const input = await loadGateInput(tx, s.key, cfg);
      expect(input.config).toEqual(gateConfigOf(cfg));
      const withMin = (minConfirmed: number): GateInput => ({
        ...input,
        config: { ...input.config, research: { ...input.config.research, gate: { ...input.config.research.gate, minConfirmed } } },
      });
      expect(cfg.research.gate.minConfirmed).toBeGreaterThan(1);
      const passed = evaluateGateInput(withMin(1), spots);
      expect(passed.passedAt).toBe(cfg.research.gate.thresholds[0]);
      expect(passed.minConfirmed).toBe(1);
      const tooFew = evaluateGateInput(withMin(999), spots);
      expect(tooFew.passedAt).toBeNull();
      expect(tooFew.tooFewConfirmed).toBe(1);
    }));
});
