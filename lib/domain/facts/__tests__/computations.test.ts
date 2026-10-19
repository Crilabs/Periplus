import { eq, inArray } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import type { Db } from "@/lib/db/client";
import { geomFromGeoJson } from "@/lib/db/geometry";
import { computations, facts, geoObjects } from "@/lib/db/schema";
import { withRollback } from "@/test/db";
import { recordComputation, latestComputations } from "../computations";

/** Synthetic bay outside the pilot box (21.0° E / 35.2° N). */
async function insertBay(tx: Db): Promise<string> {
  const [o] = await tx
    .insert(geoObjects)
    .values({ type: "bay", origin: "osm", geom: geomFromGeoJson({ type: "Point", coordinates: [21.0, 35.2] }) })
    .returning({ id: geoObjects.id });
  return o!.id;
}

const base = (geoObjectId: string) => ({
  geoObjectId,
  kind: "shelter" as const,
  inputs: { origin: { lon: 21.0, lat: 35.2 }, landVersion: "2026-10-01", fetch: [1200, 50000] },
  outputs: { rays: [1, 2, 3] },
  rulesVersion: "geometry-1",
  facts: [
    { attribute: "shelter.N", value: 0.8, confidence: 0.5 },
    { attribute: "swell_protection", value: 0.3, confidence: 0.4 },
  ],
  observedAt: "2026-10-19",
});

async function rowsOf(tx: Db, geoObjectId: string) {
  const comps = await tx.select().from(computations).where(eq(computations.geoObjectId, geoObjectId));
  const fs = comps.length
    ? await tx.select().from(facts).where(inArray(facts.computationId, comps.map((c) => c.id)))
    : [];
  return { comps, facts: fs };
}

describe("recordComputation", () => {
  it("first call writes the computation and its facts with fact_schema_version v1", async () => {
    await withRollback(async (tx) => {
      const id = await insertBay(tx);
      const r = await recordComputation(tx, base(id));
      expect(r.created).toBe(true);
      const { comps, facts: fs } = await rowsOf(tx, id);
      expect(comps).toHaveLength(1);
      expect(comps[0]).toMatchObject({ id: r.id, kind: "shelter", rulesVersion: "geometry-1", outputs: { rays: [1, 2, 3] } });
      expect(comps[0]!.inputsHash).toMatch(/^[0-9a-f]{64}$/);
      expect(fs.map((f) => [f.attribute, f.value, f.confidence, f.factSchemaVersion, f.geoObjectId, f.observedAt]).sort()).toEqual([
        ["shelter.N", 0.8, 0.5, "v1", id, "2026-10-19"],
        ["swell_protection", 0.3, 0.4, "v1", id, "2026-10-19"],
      ]);
      expect(fs.every((f) => f.computationId === r.id && f.mentionId === null && f.reviewDecisionId === null)).toBe(true);
    });
  });

  it("same inputs with reordered keys → created false, no new rows", async () => {
    await withRollback(async (tx) => {
      const id = await insertBay(tx);
      const first = await recordComputation(tx, base(id));
      const again = await recordComputation(tx, {
        ...base(id),
        inputs: { fetch: [1200, 50000], landVersion: "2026-10-01", origin: { lat: 35.2, lon: 21.0 } },
      });
      expect(again).toEqual({ id: first.id, created: false });
      const { comps, facts: fs } = await rowsOf(tx, id);
      expect(comps).toHaveLength(1);
      expect(fs).toHaveLength(2);
    });
  });

  it("changed inputs or rulesVersion → new row; A → B → A yields three rows", async () => {
    await withRollback(async (tx) => {
      const id = await insertBay(tx);
      const a = await recordComputation(tx, base(id));
      const b = await recordComputation(tx, { ...base(id), inputs: { ...base(id).inputs, landVersion: "2026-11-01" } });
      const a2 = await recordComputation(tx, base(id));
      expect([a.created, b.created, a2.created]).toEqual([true, true, true]);
      expect(new Set([a.id, b.id, a2.id]).size).toBe(3);
      const r = await recordComputation(tx, { ...base(id), rulesVersion: "geometry-2" });
      expect(r.created).toBe(true);
      const { comps, facts: fs } = await rowsOf(tx, id);
      expect(comps).toHaveLength(4);
      expect(fs).toHaveLength(8);
      const latest = await latestComputations(tx, id);
      expect(latest.get("shelter")?.id).toBe(r.id);
    });
  });

  it("the hash is per kind: same inputs under another kind is a new row", async () => {
    await withRollback(async (tx) => {
      const id = await insertBay(tx);
      await recordComputation(tx, base(id));
      const other = await recordComputation(tx, { ...base(id), kind: "fetch", facts: [{ attribute: "fetch.N", value: 1200, confidence: 0.5 }] });
      expect(other.created).toBe(true);
      expect((await rowsOf(tx, id)).comps).toHaveLength(2);
    });
  });

  it("outputs are not part of the hash", async () => {
    await withRollback(async (tx) => {
      const id = await insertBay(tx);
      const first = await recordComputation(tx, base(id));
      const again = await recordComputation(tx, { ...base(id), outputs: { rays: [9, 9] } });
      expect(again).toEqual({ id: first.id, created: false });
      const { comps } = await rowsOf(tx, id);
      expect(comps).toHaveLength(1);
      expect(comps[0]!.outputs).toEqual({ rays: [1, 2, 3] });
    });
  });

  it("an invalid fact value writes nothing", async () => {
    await withRollback(async (tx) => {
      const id = await insertBay(tx);
      await expect(
        recordComputation(tx, { ...base(id), facts: [...base(id).facts, { attribute: "shelter.S", value: 1.5, confidence: 0.5 }] }),
      ).rejects.toThrow(/shelter\.S/);
      await expect(
        recordComputation(tx, { ...base(id), facts: [{ attribute: "restriction", value: [], confidence: 0.5 }] }),
      ).rejects.toThrow(/restriction/);
      const { comps } = await rowsOf(tx, id);
      expect(comps).toHaveLength(0);
    });
  });
});

describe("latestComputations", () => {
  it("returns the newest computation per kind with its facts", async () => {
    await withRollback(async (tx) => {
      const id = await insertBay(tx);
      expect((await latestComputations(tx, id)).size).toBe(0);
      await recordComputation(tx, base(id));
      const newer = await recordComputation(tx, {
        ...base(id),
        inputs: { changed: true },
        facts: [{ attribute: "shelter.N", value: 0.2, confidence: 0.5 }],
      });
      const fetch = await recordComputation(tx, {
        ...base(id),
        kind: "fetch",
        outputs: undefined,
        facts: [{ attribute: "fetch.N", value: 1200, confidence: 0.6 }],
      });
      const latest = await latestComputations(tx, id);
      expect([...latest.keys()].sort()).toEqual(["fetch", "shelter"]);
      const shelter = latest.get("shelter")!;
      expect(shelter).toMatchObject({ id: newer.id, kind: "shelter", inputs: { changed: true }, rulesVersion: "geometry-1" });
      expect(shelter.createdAt).toBeInstanceOf(Date);
      expect(shelter.facts).toEqual([
        { id: expect.any(String), attribute: "shelter.N", value: 0.2, confidence: 0.5, observedAt: "2026-10-19" },
      ]);
      expect(latest.get("fetch")).toMatchObject({ id: fetch.id, outputs: {} });
    });
  });
});
