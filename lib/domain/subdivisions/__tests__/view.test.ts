import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { areaMembers, geoObjects, subdivisions } from "@/lib/db/schema";
import { addNames } from "@/lib/domain/gazetteer/names";
import { beginStage, createRun } from "@/lib/domain/runs";
import { countrySummaryText, subdivisionDetail, subdivisionStageHistory, subdivisionStatus, subdivisionTree } from "@/lib/domain/subdivisions/view";
import { tileIdFor } from "@/lib/domain/tiles";
import { withRollback } from "@/test/db";
import { insertNamedObject, insertTestSubdivision, insertTestTile } from "@/test/text";

describe("subdivisionStatus", () => {
  it("status mapping for each of the six states", () => {
    const base = { excluded: false, builtAt: null, latestBuild: null, activeRun: false, partial: false };
    expect(subdivisionStatus(base)).toBe("nicht begonnen");
    expect(subdivisionStatus({ ...base, latestBuild: { status: "queued" }, activeRun: true })).toBe("läuft");
    expect(subdivisionStatus({ ...base, builtAt: new Date(), latestBuild: { status: "running" }, activeRun: true })).toBe("läuft");
    // any queued or running run with the subdivision as scope (a stage run, a research run), not only a build (B11)
    expect(subdivisionStatus({ ...base, activeRun: true })).toBe("läuft");
    expect(subdivisionStatus({ ...base, builtAt: new Date(), latestBuild: { status: "finished" } })).toBe("aufgebaut");
    expect(subdivisionStatus({ ...base, latestBuild: { status: "failed" } })).toBe("fehlgeschlagen");
    // a failed rebuild of a built subdivision shows the failure
    expect(subdivisionStatus({ ...base, builtAt: new Date(), latestBuild: { status: "failed" } })).toBe("fehlgeschlagen");
    // single stages of the build finished, but no build as a whole (B11)
    expect(subdivisionStatus({ ...base, partial: true })).toBe("teilweise");
    expect(subdivisionStatus({ ...base, partial: true, activeRun: true })).toBe("läuft");
    expect(subdivisionStatus({ ...base, partial: true, latestBuild: { status: "failed" } })).toBe("fehlgeschlagen");
    expect(subdivisionStatus({ ...base, partial: true, builtAt: new Date(), latestBuild: { status: "finished" } })).toBe("aufgebaut");
    expect(subdivisionStatus({ ...base, excluded: true, latestBuild: { status: "running" }, activeRun: true, partial: true })).toBe("ausgeschlossen");
  });

  it("summarises a country in German", () => {
    expect(countrySummaryText({ total: 14, built: 3, partial: 0, running: 1, failed: 0, excluded: 1 })).toBe("3 von 13 aufgebaut, 1 läuft, 1 ausgeschlossen");
    expect(countrySummaryText({ total: 13, built: 0, partial: 2, running: 0, failed: 1, excluded: 0 })).toBe("0 von 13 aufgebaut, 2 teilweise, 1 fehlgeschlagen");
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
      expect(xq.summary).toEqual({ total: 3, built: 1, partial: 0, running: 1, failed: 0, excluded: 1 });
      expect(xq.expanded).toBe(true);
      expect(tree.find((c) => c.country === "XW")).toMatchObject({ whole: true, expanded: false, subdivisions: [{ key: "XW" }] });
    }));

  // B11: single stages of the build that ran as their own runs count; a country with a begun subdivision opens
  it("a finished build stage of a stage run makes the subdivision teilweise and expands its country", () =>
    withRollback(async (tx) => {
      await insertTestSubdivision(tx, "XP-A", [40.0, 31.0, 40.5, 31.25], { country: "XP" });
      await insertTestSubdivision(tx, "XP-B", [40.5, 31.0, 41.0, 31.25], { country: "XP" });
      await insertTestSubdivision(tx, "XN-A", [41.0, 31.0, 41.5, 31.25], { country: "XN" });
      const run = await createRun(tx, { kind: "stage", scope: { type: "subdivision", id: "XP-A" }, stages: ["gazetteer.osm"], params: {}, triggeredBy: "test" });
      // a stage without jobs finishes at once, and with it the run
      await beginStage(tx, run.id, "gazetteer.osm", 0);
      // a finished stage that is no build stage (research) does not make a subdivision teilweise
      const research = await createRun(tx, { kind: "stage", scope: { type: "subdivision", id: "XP-B" }, stages: ["research.search"], params: {}, triggeredBy: "test" });
      await beginStage(tx, research.id, "research.search", 0);

      const tree = await subdivisionTree(tx);
      const xp = tree.find((c) => c.country === "XP")!;
      expect(xp.subdivisions.map((s) => [s.key, s.status])).toEqual([
        ["XP-A", "teilweise"],
        ["XP-B", "nicht begonnen"],
      ]);
      expect(xp.summary).toEqual({ total: 2, built: 0, partial: 1, running: 0, failed: 0, excluded: 0 });
      expect(xp.expanded).toBe(true);
      expect(tree.find((c) => c.country === "XN")).toMatchObject({ expanded: false, subdivisions: [{ key: "XN-A", status: "nicht begonnen" }] });

      const history = await subdivisionStageHistory(tx, "XP-A");
      expect(history).toEqual([{ stage: "gazetteer.osm", finishedAt: expect.any(String), runId: run.id, runStatus: "finished" }]);
      expect(new Date(history[0]!.finishedAt!).getTime()).toBeGreaterThan(Date.now() - 60_000);
      expect(await subdivisionStageHistory(tx, "XN-A")).toEqual([]);
    }));

  it("a running stage run makes the subdivision läuft; the stage history names the youngest run per stage", () =>
    withRollback(async (tx) => {
      await insertTestSubdivision(tx, "XR-A", [40.0, 32.0, 40.5, 32.25], { country: "XR" });
      const first = await createRun(tx, { kind: "stage", scope: { type: "subdivision", id: "XR-A" }, stages: ["gazetteer.osm"], params: {}, triggeredBy: "test" });
      await beginStage(tx, first.id, "gazetteer.osm", 0);
      await tx.execute(sql`update runs set created_at = now() - interval '1 hour', finished_at = now() - interval '1 hour' where id = ${first.id}`);
      // a second run: its first stage finished, its second still running, so the run has not ended
      const second = await createRun(tx, { kind: "stage", scope: { type: "subdivision", id: "XR-A" }, stages: ["gazetteer.osm", "seed.tile"], params: {}, triggeredBy: "test" });
      await beginStage(tx, second.id, "gazetteer.osm", 0);
      await beginStage(tx, second.id, "seed.tile", 2);

      const tree = await subdivisionTree(tx);
      const xr = tree.find((c) => c.country === "XR")!;
      expect(xr.subdivisions[0]).toMatchObject({ key: "XR-A", status: "läuft" });
      expect(xr.summary).toMatchObject({ running: 1, partial: 0 });
      expect(xr.expanded).toBe(true);
      expect((await subdivisionDetail(tx, "XR-A"))!.status).toBe("läuft");

      // per stage the youngest run that finished it; seed.tile is still running and so not listed
      expect(await subdivisionStageHistory(tx, "XR-A")).toEqual([{ stage: "gazetteer.osm", finishedAt: null, runId: second.id, runStatus: "running" }]);
    }));
});

describe("subdivisionDetail", () => {
  it("lists scope tiles with their label, the linked sailing areas and the runs", () =>
    withRollback(async (tx) => {
      const sub = await insertTestSubdivision(tx, "XQ-D", [40.0, 30.0, 40.25, 30.25], { country: "XQ" });
      const tile = await insertTestTile(tx, tileIdFor(40.1, 30.1), null, sub.id);
      await insertNamedObject(tx, { type: "area", names: [{ name: "Testrevier", language: "de" }], lon: 40.1, lat: 30.1, tiles: [tile] });
      await insertNamedObject(tx, { type: "area", names: [{ name: "Ended", language: "de" }], lon: 40.1, lat: 30.1, tiles: [tile], configKey: "xq-ended" }).then((id) =>
        tx.execute(sql`update geo_objects set valid_from = current_date - 5, valid_to = current_date - 1 where id = ${id}`));
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

describe("subdivisionDetail areas", () => {
  it("detail lists area key and member count", () =>
    withRollback(async (tx) => {
      const sub = await insertTestSubdivision(tx, "XQ-M", [41.0, 30.0, 41.25, 30.25], { country: "XQ" });
      const tile = await insertTestTile(tx, tileIdFor(41.1, 30.1), null, sub.id);
      const areaId = await insertNamedObject(tx, { type: "area", names: [{ name: "Mitgliedrevier", language: "de" }], lon: 41.1, lat: 30.1, configKey: "xq-members", tiles: [tile] });
      const m1 = await insertNamedObject(tx, { type: "harbour", names: [{ name: "Hafen Eins" }], lon: 41.11, lat: 30.1 });
      const m2 = await insertNamedObject(tx, { type: "harbour", names: [{ name: "Hafen Zwei" }], lon: 41.12, lat: 30.1 });
      await tx.insert(areaMembers).values([
        { areaId, geoObjectId: m1, role: "member", name: "Hafen Eins" },
        { areaId, geoObjectId: m2, role: "member", name: "Hafen Zwei" },
      ]);
      const detail = (await subdivisionDetail(tx, "XQ-M"))!;
      expect(detail.areas).toMatchObject([{ id: areaId, key: "xq-members", members: 2, name: "Mitgliedrevier" }]);
    }));
});
