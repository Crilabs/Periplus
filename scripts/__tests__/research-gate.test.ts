import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { getConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { geoObjects, reviewTasks } from "@/lib/db/schema";
import type { NavilySpot } from "@/lib/domain/quality/navily-sample";
import { loadNavilySpots } from "@/lib/domain/quality/navily-sample";
import { newId } from "@/lib/domain/ids";
import { decideReviewTask } from "@/lib/domain/review-decisions";
import { tileIdFor } from "@/lib/domain/tiles";
import { insertPlace } from "@/test/consolidation";
import { withRollback } from "@/test/db";
import { signalPage } from "@/test/research-signals";
import { insertTestSubdivision, insertTestTile } from "@/test/text";
import { parseArgs, runGate, type GateArgs } from "../research-gate";

/* The gate CLI against real Postgres with synthetic spots in a temp dir; the invented names must never reach the report. */

const cfg = getConfig();
const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

const spot = (over: Partial<NavilySpot>): NavilySpot => ({ lat: 35.2, lon: 21.0, prot: null, seabeds: null, name: null, kind: "mooring", type: null, water: null, shop: null, ...over });
const INVENTED = /Zzyzx|Qwoxx|Vrrmpf|\b35\.2\d*|\b21\.\d+|\b25\.\d+/;

async function setup(tx: Db) {
  const key = `XT-${newId()}`;
  const sub = await insertTestSubdivision(tx, key, [20.9, 35.0, 21.5, 35.5]);
  await insertTestTile(tx, tileIdFor(21.0, 35.2), null, sub.id);
  const place = async (name: string, lon: number) => {
    const p = await insertPlace(tx, { name, lon, lat: 35.2, status: "candidate" });
    await tx.update(geoObjects).set({ subdivisionId: sub.id }).where(eq(geoObjects.id, p.objectId));
    for (const d of ["a", "b"]) await signalPage(tx, cfg, p, { domain: `${d}.example` });
    return p;
  };
  const known = await place("Zzyzx Cove", 21.0);
  const unknown = await place("Qwoxx Bay", 21.05);
  const dir = await mkdtemp(path.join(os.tmpdir(), "n3-gate-test-"));
  dirs.push(dir);
  const spotFile = path.join(dir, "spots.json");
  const { writeFile } = await import("node:fs/promises");
  await writeFile(
    spotFile,
    JSON.stringify([
      spot({ name: "Zzyzx Cove" }),
      spot({ name: "Vrrmpf Haven", lon: 21.1 }),
      spot({ name: "Elsewhere Bight", lon: 25.5 }), // outside the subdivision's tiles
    ]),
  );
  const args: GateArgs = { subdivision: key, navily: spotFile, outDir: path.join(dir, "lists"), report: path.join(dir, "report", "n3-tor.md"), syncConflicts: false };
  return { key, known, unknown, args, dir, spots: await loadNavilySpots(spotFile) };
}

describe("research-gate parseArgs", () => {
  it("reads subdivision, path, directories and the sync switch; defaults outside the repo and to the committed report", () => {
    const a = parseArgs(["--subdivision", "GR-I", "--navily", "/tmp/s.json", "--out-dir", "/tmp/o", "--sync-conflicts"], {});
    expect(a).toMatchObject({ subdivision: "GR-I", navily: "/tmp/s.json", outDir: "/tmp/o", syncConflicts: true, report: path.join("docs", "pilot", "neuausrichtung", "n3-tor.md") });
    const d = parseArgs(["--subdivision", "GR-I"], { NAVILY_SPOTS_PATH: "/tmp/env.json" });
    expect(d).toMatchObject({ navily: "/tmp/env.json", syncConflicts: false });
    expect(d.outDir.startsWith(os.tmpdir())).toBe(true);
  });

  it("aborts without subdivision or file, on unknown or doubled flags", () => {
    expect(() => parseArgs(["--navily", "/x"], {})).toThrow(/usage/);
    expect(() => parseArgs(["--subdivision", "a"], {})).toThrow(/NAVILY_SPOTS_PATH/);
    expect(() => parseArgs(["--subdivision", "a", "--bogus", "b"], { NAVILY_SPOTS_PATH: "/x" })).toThrow(/usage/);
    expect(() => parseArgs(["--subdivision", "a", "--sync-conflicts", "--sync-conflicts"], { NAVILY_SPOTS_PATH: "/x" })).toThrow(/usage/);
  });
});

describe("runGate", () => {
  it("writes a report of counts only and the lists to the out dir; syncs the conflict tasks; passes once the human decided", () =>
    withRollback(async (tx) => {
      const s = await setup(tx);
      const now = new Date("2026-10-23T12:00:00Z");
      const lines = await runGate(tx, { ...s.args, syncConflicts: true }, s.spots, cfg, { now, repoRoot: process.cwd() });
      expect(lines.join("\n")).toMatch(/Tor nicht bestanden/);
      expect(lines.join("\n")).toMatch(/1 created, 1 open/);
      expect(lines.join("\n")).toContain("spots in " + s.args.subdivision + ": 2");

      const report = await readFile(s.args.report, "utf8");
      expect(report).toMatch(/\| 2 \| 2 \| 1 \| 0 \| 1 \| 0 \| 0 \| 50 % \|/);
      expect(report).toMatch(/kein Kandidat in der Nähe \| 1 \|/);
      for (const text of [report, lines.join("\n")]) {
        expect(text).not.toMatch(INVENTED);
        expect(text).not.toContain(s.known.placeId);
        expect(text).not.toContain(s.unknown.placeId);
      }
      const files = (await readdir(s.args.outDir)).sort();
      expect(files).toEqual(["n3-tor-n2.csv", "n3-tor-n3.csv", "n3-tor-n4.csv", "n3-tor-n5.csv"]);
      const csv = await readFile(path.join(s.args.outDir, "n3-tor-n2.csv"), "utf8");
      expect(csv).toContain(`conflict,${s.unknown.placeId},`);
      expect(csv).toMatch(/^miss,,no_candidate,,1$/m);
      expect(csv).not.toMatch(/Zzyzx|Qwoxx|Vrrmpf/);

      const [task] = await tx.select().from(reviewTasks).where(eq(reviewTasks.subjectId, s.unknown.placeId));
      await decideReviewTask(tx, { taskId: task!.id, decision: { action: "berth" }, decidedBy: "admin@test.invalid" });
      const again = await runGate(tx, { ...s.args, syncConflicts: true }, s.spots, cfg, { now, repoRoot: process.cwd() });
      expect(again.join("\n")).toContain("Tor bestanden bei N=2");
      expect(again.join("\n")).toMatch(/0 created, 0 open/);
      expect(await readFile(s.args.report, "utf8")).toMatch(/\| 2 \| 2 \| 2 \| 0 \| 0 \| 1 \| 0 \| 100 % \|/);
    }));

  it("refuses an out dir inside the repository", () =>
    withRollback(async (tx) => {
      const s = await setup(tx);
      await expect(runGate(tx, { ...s.args, outDir: path.join(process.cwd(), "tmp-lists") }, s.spots, cfg, { now: new Date(), repoRoot: process.cwd() })).rejects.toThrow(/outside the repository/);
    }));
});
