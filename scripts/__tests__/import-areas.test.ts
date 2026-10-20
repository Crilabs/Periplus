import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { withRollback } from "@/test/db";
import { insertScene, sceneConfig, sceneFile, SCENE_COUNTRY } from "@/test/fixtures/areas/scene";
import { formatReport, parseArgs, runImport } from "../import-areas";

const cfg = sceneConfig();
const today = "2026-10-21";

function writeScene(): string {
  const file = path.join(mkdtempSync(path.join(tmpdir(), "areas-")), `${SCENE_COUNTRY}.json`);
  writeFileSync(file, JSON.stringify(sceneFile()));
  return file;
}

const areaCount = async (db: Parameters<typeof runImport>[0]) =>
  (await db.execute<{ n: number }>(sql`select count(*)::int as n from geo_objects where type = 'area' and config_key in (${sql.join(sceneFile().areas.map((a) => sql`${a.key}`), sql`, `)})`)).rows[0]!.n;

describe("parseArgs", () => {
  it("reads --file and --dry-run, defaults to all files and a real run", () => {
    expect(parseArgs(["--file", "x.json", "--dry-run"])).toEqual({ file: "x.json", dryRun: true });
    expect(parseArgs([])).toEqual({ file: null, dryRun: false });
    expect(() => parseArgs(["--file"])).toThrow(/usage/);
    expect(() => parseArgs(["--bogus"])).toThrow(/usage/);
  });
});

describe("import-areas script", () => {
  it("--dry-run leaves no rows and returns the report", () =>
    withRollback(async (tx) => {
      await insertScene(tx);
      const reports = await runImport(tx, { file: writeScene(), dryRun: true }, cfg, today);
      expect(reports).toHaveLength(1);
      expect(reports[0]!.created.length).toBeGreaterThan(0);
      expect(formatReport(reports[0]!)[0]).toContain(`${SCENE_COUNTRY}: created ${reports[0]!.created.length}`);
      expect(await areaCount(tx)).toBe(0);
    }));

  it("a real run writes the areas", () =>
    withRollback(async (tx) => {
      await insertScene(tx);
      const reports = await runImport(tx, { file: writeScene(), dryRun: false }, cfg, today);
      expect(await areaCount(tx)).toBe(reports[0]!.created.length);
    }));
});
