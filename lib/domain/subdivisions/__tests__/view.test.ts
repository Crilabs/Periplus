import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { geoObjects, subdivisions } from "@/lib/db/schema";
import { addNames } from "@/lib/domain/gazetteer/names";
import { createRun } from "@/lib/domain/runs";
import { countrySummaryText, subdivisionDetail, subdivisionStatus, subdivisionTree } from "@/lib/domain/subdivisions/view";
import { tileIdFor } from "@/lib/domain/tiles";
import { withRollback } from "@/test/db";
import { insertNamedObject, insertTestSubdivision, insertTestTile } from "@/test/text";

describe("subdivisionStatus", () => {
  it("status mapping for each of the five states", () => {
    const base = { excluded: false, builtAt: null, latestBuild: null };
    expect(subdivisionStatus(base)).toBe("nicht begonnen");
    expect(subdivisionStatus({ ...base, latestBuild: { status: "queued" } })).toBe("läuft");
    expect(subdivisionStatus({ ...base, builtAt: new Date(), latestBuild: { status: "running" } })).toBe("läuft");
    expect(subdivisionStatus({ ...base, builtAt: new Date(), latestBuild: { status: "finished" } })).toBe("aufgebaut");
    expect(subdivisionStatus({ ...base, latestBuild: { status: "failed" } })).toBe("fehlgeschlagen");
    // a failed rebuild of a built subdivision shows the failure
    expect(subdivisionStatus({ ...base, builtAt: new Date(), latestBuild: { status: "failed" } })).toBe("fehlgeschlagen");
    expect(subdivisionStatus({ ...base, excluded: true, latestBuild: { status: "running" } })).toBe("ausgeschlossen");
  });

  it("summarises a country in German", () => {
    expect(countrySummaryText({ total: 14, built: 3, running: 1, failed: 0, excluded: 1 })).toBe("3 von 13 aufgebaut, 1 läuft, 1 ausgeschlossen");
  });
});

describe("subdivisionTree", () => {
  it("tree groups by country and marks whole countries", () =>
    withRollback(async (tx) => {
      const a = await insertTestSubdivision(tx, "XQ-B", [40.0, 30.0, 40.5, 30.25], { country: "XQ" });
      const b = await insertTestSubdivision(tx, "XQ-A", [40.5, 30.0, 41.0, 30.25], { country: "XQ" });
      await addNames(tx, a.geoObjectId, [{ name: "Beta", language: "de", origin: "manual" }]);
      await addNames(tx, b.geoObjectId, [{ name: "Alpha", language: "de", origin: "manual" }]);
      // a small state that is one subdivision as a whole: its object is the country
      const whole = await insertTestSubdivision(tx, "XW", [41.0, 30.0, 41.5, 30.25], { country: "XW" });
      await tx.update(geoObjects).set({ type: "country" }).where(eq(geoObjects.id, whole.geoObjectId));
      await insertTestSubdivision(tx, "XQ-C", [41.5, 30.0, 42.0, 30.25], { country: "XQ", status: "excluded" });
      await tx.update(subdivisions).set({ builtAt: sql`now()` }).where(eq(subdivisions.id, b.id));
      await insertTestTile(tx, tileIdFor(40.1, 30.1), null, a.id);
      await tx.execute(sql`update tiles set last_run_at = now() where id = ${tileIdFor(40.1, 30.1)}`);
      await insertTestTile(tx, tileIdFor(40.3, 30.1), null, a.id);
      await createRun(tx, { kind: "full", scope: { type: "subdivision", id: "XQ-B" }, stages: [], params: {}, triggeredBy: "test" });

      const tree = await subdivisionTree(tx);
      const xq = tree.find((c) => c.country === "XQ")!;
      expect(xq.whole).toBe(false);
      expect(xq.subdivisions.map((s) => [s.key, s.name, s.status])).toEqual([
        ["XQ-A", "Alpha", "aufgebaut"],
        ["XQ-B", "Beta", "läuft"],
        ["XQ-C", "XQ-C", "ausgeschlossen"],
      ]);
      expect(xq.subdivisions[1]).toMatchObject({ coastTiles: 2, processedTiles: 1, costEur: 0, queued: false, lastRunAt: expect.any(String) });
      expect(xq.summary).toEqual({ total: 3, built: 1, running: 1, failed: 0, excluded: 1 });
      expect(tree.find((c) => c.country === "XW")).toMatchObject({ whole: true, subdivisions: [{ key: "XW" }] });
    }));
});

describe("subdivisionDetail", () => {
  it("lists scope tiles with their label, the linked sailing areas and the runs", () =>
    withRollback(async (tx) => {
      const sub = await insertTestSubdivision(tx, "XQ-D", [40.0, 30.0, 40.25, 30.25], { country: "XQ" });
      const tile = await insertTestTile(tx, tileIdFor(40.1, 30.1), null, sub.id);
      await insertNamedObject(tx, { type: "area", names: [{ name: "Testrevier", language: "de" }], lon: 40.1, lat: 30.1, tiles: [tile] });
      await createRun(tx, { kind: "stage", scope: { type: "subdivision", id: "XQ-D" }, stages: ["tiles.ensure"], params: {}, triggeredBy: "test" });
      const detail = (await subdivisionDetail(tx, "XQ-D"))!;
      expect(detail.tiles).toEqual([{ id: tile, lastRunAt: null, label: true }]);
      expect(detail.areas.map((a) => a.name)).toEqual(["Testrevier"]);
      expect(detail.runs).toHaveLength(1);
      // XQ has no detailed aerial source, so no „Titelbilder erzeugen“; a Greek Landesteil has the cadastre
      expect(detail.coreImagery).toBe(false);
      await insertTestSubdivision(tx, "XQ-G", [40.25, 30.0, 40.5, 30.25], { country: "GR" });
      expect((await subdivisionDetail(tx, "XQ-G"))!.coreImagery).toBe(true);
      expect(await subdivisionDetail(tx, "XQ-NONE")).toBeNull();
    }));
});
