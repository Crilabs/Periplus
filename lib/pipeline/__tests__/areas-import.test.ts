import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { areaImportHandler, areaImportStage } from "@/lib/jobs/handlers/areas";
import type { JobContext } from "@/lib/jobs/worker";
import { AREA_IMPORT_STAGE, runAreaImport } from "@/lib/pipeline/areas-import";
import { withRollback } from "@/test/db";
import { insertScene, sceneConfig, sceneFile, SCENE_COUNTRY } from "@/test/fixtures/areas/scene";

describe("areas.import stage", () => {
  it("is one job named import on the areas.import queue", async () => {
    expect(areaImportStage).toMatchObject({ name: AREA_IMPORT_STAGE, queue: "areas.import" });
    expect(await areaImportStage.plan({} as never, {} as never)).toEqual([{ key: "import" }]);
  });

  it("imports the scene file and returns the report; a second run changes nothing", () =>
    withRollback(async (tx) => {
      await insertScene(tx);
      const dir = mkdtempSync(path.join(tmpdir(), "areas-"));
      writeFileSync(path.join(dir, `${SCENE_COUNTRY}.json`), JSON.stringify(sceneFile()));
      const first = await runAreaImport(tx, sceneConfig(), dir);
      expect(first).toHaveLength(1);
      expect(first[0]).toMatchObject({ country: SCENE_COUNTRY });
      expect(first[0]!.created.length).toBe(sceneFile().areas.length - first[0]!.waiting.length);
      const second = await runAreaImport(tx, sceneConfig(), dir);
      expect(second[0]!.created).toEqual([]);
      expect(second[0]!.updated).toEqual([]);
    }));

  it("the handler logs the report of the shipped files", () =>
    withRollback(async (tx) => {
      const logged: unknown[] = [];
      const ctx = { db: tx, log: { info: (o: unknown) => logged.push(o) } } as unknown as JobContext;
      await areaImportHandler({ key: "import", runId: "r", stage: AREA_IMPORT_STAGE }, ctx);
      expect(logged[0]).toMatchObject({ reports: expect.any(Array) });
    }));
});
