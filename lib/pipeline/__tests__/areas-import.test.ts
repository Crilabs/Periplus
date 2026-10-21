import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { areaImportHandlerFor, areaImportStage } from "@/lib/jobs/handlers/areas";
import type { JobContext } from "@/lib/jobs/worker";
import { AREA_IMPORT_STAGE, runAreaImport } from "@/lib/pipeline/areas-import";
import { withRollback } from "@/test/db";
import { insertScene, sceneConfig, sceneFile, SCENE_COUNTRY } from "@/test/fixtures/areas/scene";

/** A fixture dir with the scene file and, unless `brokenOther` is false, a broken file of another country. */
function fixtureDir(brokenOther = true): string {
  const dir = mkdtempSync(path.join(tmpdir(), "areas-"));
  writeFileSync(path.join(dir, `${SCENE_COUNTRY}.json`), JSON.stringify(sceneFile()));
  if (brokenOther) writeFileSync(path.join(dir, "XY.json"), "{ not json");
  return dir;
}

describe("areas.import stage", () => {
  it("plans one job for the build subdivision's country, one job for all files without a subdivision", () =>
    withRollback(async (tx) => {
      await insertScene(tx);
      expect(areaImportStage).toMatchObject({ name: AREA_IMPORT_STAGE, queue: "areas.import" });
      expect(await areaImportStage.plan(tx, { id: "r", params: { subdivisionKey: "ZT-A" } })).toEqual([
        { key: SCENE_COUNTRY, country: SCENE_COUNTRY },
      ]);
      expect(await areaImportStage.plan(tx, { id: "r", params: {} })).toEqual([{ key: "import" }]);
    }));

  it("imports the scene file and returns the report; a second run changes nothing", () =>
    withRollback(async (tx) => {
      await insertScene(tx);
      const dir = fixtureDir(false);
      const first = await runAreaImport(tx, sceneConfig(), { dir });
      expect(first).toHaveLength(1);
      expect(first[0]).toMatchObject({ country: SCENE_COUNTRY });
      expect(first[0]!.created.length).toBe(sceneFile().areas.length - first[0]!.waiting.length);
      const second = await runAreaImport(tx, sceneConfig(), { dir });
      expect(second[0]!.created).toEqual([]);
      expect(second[0]!.updated).toEqual([]);
    }));

  it("a build imports only its country's file: a broken file of another country does not fail it", () =>
    withRollback(async (tx) => {
      await insertScene(tx);
      const dir = fixtureDir();
      const reports = await runAreaImport(tx, sceneConfig(), { dir, country: SCENE_COUNTRY });
      expect(reports.map((r) => r.country)).toEqual([SCENE_COUNTRY]);
      expect(await runAreaImport(tx, sceneConfig(), { dir, country: "QQ" })).toEqual([]);
      await expect(runAreaImport(tx, sceneConfig(), { dir })).rejects.toThrow(/XY\.json/);
    }));

  it("the handler imports the job's country and logs the report", () =>
    withRollback(async (tx) => {
      await insertScene(tx);
      const logged: unknown[] = [];
      const ctx = { db: tx, log: { info: (o: unknown) => logged.push(o) } } as unknown as JobContext;
      await areaImportHandlerFor(fixtureDir(), sceneConfig())(
        { key: SCENE_COUNTRY, country: SCENE_COUNTRY, runId: "r", stage: AREA_IMPORT_STAGE },
        ctx,
      );
      expect(logged[0]).toMatchObject({ reports: [{ country: SCENE_COUNTRY }] });
    }));
});
