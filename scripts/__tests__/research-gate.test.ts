import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { getConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { berthStates, geoObjects, reviewTasks } from "@/lib/db/schema";
import type { NavilySpot } from "@/lib/domain/quality/navily-sample";
import { loadNavilySpots } from "@/lib/domain/quality/navily-sample";
import { newId } from "@/lib/domain/ids";
import { decideReviewTask } from "@/lib/domain/review-decisions";
import { tileIdFor } from "@/lib/domain/tiles";
import { insertPlace } from "@/test/consolidation";
import { withRollback } from "@/test/db";
import { signalPage } from "@/test/research-signals";
import { insertTestSubdivision, insertTestTile } from "@/test/text";
import { isInsideRepo, parseArgs, runGate, type GateArgs } from "../research-gate";

/* The gate CLI against real Postgres with synthetic spots in a temp dir; the invented names must never reach the report. */

const realCfg = getConfig();
/** The test setups confirm a handful of places; the minimum sample is lowered to 1 except in the test of the minimum itself. */
const cfg = { ...realCfg, research: { ...realCfg.research, gate: { ...realCfg.research.gate, minConfirmed: 1 } } };
const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

const spot = (over: Partial<NavilySpot>): NavilySpot => ({ lat: 35.2, lon: 21.0, prot: null, seabeds: null, name: null, kind: "mooring", type: null, water: null, shop: null, ...over });
const INVENTED = /Zzyzx|Qwoxx|Vrrmpf|\b35\.2\d*|\b21\.\d+|\b25\.\d+/;

type SetupOpts = { wrongKind?: boolean; knownDomains?: number; signals?: boolean; knownLat?: number; edge?: boolean; unbacked?: boolean; unseeded?: boolean; shelter?: number; prot?: string[]; noStateRow?: boolean; extraSpots?: NavilySpot[] };

async function setup(tx: Db, o: SetupOpts = {}) {
  const key = `XT-${newId()}`;
  const sub = await insertTestSubdivision(tx, key, [20.9, 35.0, 21.5, 35.5]);
  await insertTestTile(tx, tileIdFor(21.0, 35.2), null, sub.id);
  const place = async (name: string, lon: number, domains: number, lat = 35.2, status: "candidate" | "confirmed" = "candidate") => {
    const p = await insertPlace(tx, { name, lon, lat, status });
    await tx.update(geoObjects).set({ subdivisionId: sub.id }).where(eq(geoObjects.id, p.objectId));
    for (const d of ["a", "b", "c", "d"].slice(0, o.signals === false ? 0 : domains)) await signalPage(tx, cfg, p, { domain: `${d}.example` });
    return p;
  };
  // a tile of the subdivision without any place (not worked on): its spots neither count nor are listed as misses
  if (o.unseeded) await insertTestTile(tx, tileIdFor(21.4, 35.2), null, sub.id);
  const known = await place("Zzyzx Cove", 21.0, o.knownDomains ?? 2, o.knownLat);
  const unknown = await place("Qwoxx Bay", 21.05, 2);
  if (o.shelter !== undefined) {
    await tx.insert(berthStates).values({
      placeId: known.placeId, gaps: [], facts: [], landing: [], nearby: [],
      core: { "shelter.N": { value: o.shelter, confidence: 0.8, origin: "computed", observedAt: null, factIds: [] } },
    });
  }
  const wrong = o.wrongKind ? await place("Wrxxy Pier", 21.15, 2) : null;
  // just inside the tile's west edge (lon 21.0); its spot lies about 90 m west, outside the subdivision's tiles
  const edge = o.edge ? await place("Zzyzx Edge", 21.0008, 2, 35.1) : null;
  // delivered as confirmed, but without any evidence: not backed by the rule
  const unbacked = o.unbacked ? await place("Qwoxx Shelf", 21.2, 0, 35.1, "confirmed") : null;
  const dir = await mkdtemp(path.join(os.tmpdir(), "n3-gate-test-"));
  dirs.push(dir);
  const spotFile = path.join(dir, "spots.json");
  await writeFile(
    spotFile,
    JSON.stringify([
      spot({ name: "Elsewhere Bight", lon: 25.5 }), // outside the subdivision's tiles, first: filtered and file indexes differ
      spot({ name: "Zzyzx Cove", prot: o.prot ?? null }),
      spot({ name: "Vrrmpf Haven", lon: 21.1 }),
      ...(wrong ? [spot({ name: "Wrxxy Pier", lon: 21.15, kind: "port" })] : []),
      ...(o.extraSpots ?? []),
      ...(o.unseeded ? [spot({ name: "Vrrmpf Far", lon: 21.4 })] : []),
      ...(edge ? [spot({ name: "Zzyzx Edge", lon: 20.9998, lat: 35.1 })] : []),
    ]),
  );
  const args: GateArgs = { subdivision: key, navily: spotFile, outDir: path.join(dir, "lists"), report: path.join(dir, "report", "n3-tor.md"), syncConflicts: false };
  return { key, known, unknown, wrong, edge, unbacked, args, dir, spots: await loadNavilySpots(spotFile) };
}

describe("research-gate parseArgs", () => {
  it("reads subdivision, path, directories and the sync switch; defaults outside the repo and to the committed report", () => {
    const root = path.join(path.sep, "some", "repo");
    const a = parseArgs(["--subdivision", "GR-I", "--navily", "/tmp/s.json", "--out-dir", "/tmp/o", "--sync-conflicts"], {}, root);
    expect(a).toMatchObject({ subdivision: "GR-I", navily: "/tmp/s.json", outDir: "/tmp/o", syncConflicts: true, report: path.join(root, "docs", "pilot", "neuausrichtung", "n3-tor.md") });
    const d = parseArgs(["--subdivision", "GR-I"], { NAVILY_SPOTS_PATH: "/tmp/env.json" }, root);
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
      expect(lines.join("\n")).not.toMatch(INVENTED);

      const report = await readFile(s.args.report, "utf8");
      expect(report).toMatch(/\| 2 \| 2 \| 1 \| 0 \| 0 \| 0 \| 1 \| 0 \| 0 \| 50 % \|/);
      expect(report).toMatch(/kein Kandidat in der Nähe \| 1 \|/);
      expect(report).not.toContain("noch nicht verglichen");
      expect(report).toContain("Geliefert bestätigt, aber von der Regel (N=2) nicht gedeckt: 0");
      for (const text of [report, lines.join("\n")]) {
        expect(text).not.toMatch(INVENTED);
        expect(text).not.toContain(s.known.placeId);
        expect(text).not.toContain(s.unknown.placeId);
      }
      const files = (await readdir(s.args.outDir)).sort();
      expect(files).toEqual(["n3-tor-n2.csv", "n3-tor-n3.csv", "n3-tor-n4.csv", "n3-tor-n5.csv"]);
      const csv = await readFile(path.join(s.args.outDir, "n3-tor-n2.csv"), "utf8");
      expect(csv).toContain(`conflict,${s.unknown.placeId},`);
      expect(csv).toMatch(/^miss,,no_candidate,,2$/m); // the file index, not the index among the spots of the subdivision
      expect(csv).not.toMatch(/Zzyzx|Qwoxx|Vrrmpf/);

      const [task] = await tx.select().from(reviewTasks).where(eq(reviewTasks.subjectId, s.unknown.placeId));
      await decideReviewTask(tx, { taskId: task!.id, decision: { action: "berth" }, decidedBy: "admin@test.invalid" });
      const again = await runGate(tx, { ...s.args, syncConflicts: true }, s.spots, cfg, { now, repoRoot: process.cwd() });
      expect(again.join("\n")).toContain("Tor bestanden bei N=2");
      expect(again.join("\n")).toMatch(/0 created, 0 open/);
      expect(await readFile(s.args.report, "utf8")).toMatch(/\| 2 \| 2 \| 2 \| 0 \| 0 \| 0 \| 0 \| 1 \| 0 \| 100 % \|/);
    }));

  it("a shelter claim the reference does not list breaks the gate; the report counts, the lists name the kind, no value leaks", () =>
    withRollback(async (tx) => {
      const s = await setup(tx, { shelter: 0.9, prot: ["S"] });
      const lines = await runGate(tx, s.args, s.spots, cfg, { now: new Date("2026-10-25T12:00:00Z"), repoRoot: process.cwd() });
      expect(lines.join("\n")).toMatch(/Tor nicht bestanden/);
      const report = await readFile(s.args.report, "utf8");
      expect(report).toContain("| Schwelle N | bestätigt | korrekt | falsche Art | Position abweichend | Schutz falsch |");
      expect(report).toMatch(/\| 2 \| 2 \| 0 \| 0 \| 0 \| 1 \| 1 \| 0 \| 0 \| 0 % \|/);
      expect(report).toMatch(/\| Schutz N \| 0 \| 1 \| 0 \| 0 \| 0 \|/); // a deviation counted; the table counts every matched place, the error place too
      expect(report).not.toMatch(INVENTED);
      expect(await readFile(path.join(s.args.outDir, "n3-tor-n2.csv"), "utf8")).toContain(`error,${s.known.placeId},shelter,`);
    }));

  it("the core table counts places without a state row as no state and lists every compared attribute", () =>
    withRollback(async (tx) => {
      const s = await setup(tx, { prot: ["S"] });
      await runGate(tx, s.args, s.spots, cfg, { now: new Date("2026-10-25T12:00:00Z"), repoRoot: process.cwd() });
      const report = await readFile(s.args.report, "utf8");
      expect(report).toContain("## Kernwerte gegen die Referenz (N=");
      expect(report).toMatch(/\| Schutz N \| 0 \| 0 \| 0 \| 0 \| 1 \|/);
      for (const label of ["Grund", "Bojen", "Wasser", "Versorgung", "Schutz SW"]) expect(report).toContain(`| ${label} |`);
      for (const label of ["Existenz", "Position |", "Tiefe", "Taverne"]) expect(report).not.toContain(`| ${label}`);
      expect(report).not.toMatch(INVENTED);
    }));

  it("a spot of another kind is an error in the report, the outcome and the lists", () =>
    withRollback(async (tx) => {
      const s = await setup(tx, { wrongKind: true });
      const now = new Date("2026-10-23T12:00:00Z");
      const lines = await runGate(tx, s.args, s.spots, cfg, { now, repoRoot: process.cwd() });
      expect(lines.join("\n")).toMatch(/Tor nicht bestanden/);
      const report = await readFile(s.args.report, "utf8");
      expect(report).toMatch(/\| 2 \| 3 \| 1 \| 1 \| 0 \| 0 \| 1 \| 0 \| 0 \| 33\.3 % \|/);
      expect(report).not.toMatch(INVENTED);
      const csv = await readFile(path.join(s.args.outDir, "n3-tor-n2.csv"), "utf8");
      expect(csv).toMatch(new RegExp(`^error,${s.wrong!.placeId},wrong_kind,\\d+,3$`, "m"));
      // a human "berth" decision on the open conflict does not clear the wrong kind
      const [task] = await runGate(tx, { ...s.args, syncConflicts: true }, s.spots, cfg, { now, repoRoot: process.cwd() }).then(() => tx.select().from(reviewTasks).where(eq(reviewTasks.subjectId, s.unknown.placeId)));
      await decideReviewTask(tx, { taskId: task!.id, decision: { action: "berth" }, decidedBy: "admin@test.invalid" });
      const again = await runGate(tx, s.args, s.spots, cfg, { now, repoRoot: process.cwd() });
      expect(again.join("\n")).toMatch(/Tor nicht bestanden: bei keiner Schwelle sind alle bestätigten Plätze korrekt$/m);
    }));

  it("a place delivered as confirmed that the rule does not back blocks the gate; report, outcome and CLI count it", () =>
    withRollback(async (tx) => {
      const s = await setup(tx, { knownDomains: 3, unbacked: true });
      const lines = (await runGate(tx, s.args, s.spots, cfg, { now: new Date(), repoRoot: process.cwd() })).join("\n");
      expect(lines).toContain("confirmed without rule backing (N=2): 1");
      expect(lines).toContain("Tor nicht bestanden: 1 bestätigt gelieferte Plätze sind von der Regel (N=2) nicht gedeckt");
      expect(lines).not.toContain("Tor bestanden");
      const report = await readFile(s.args.report, "utf8");
      expect(report).toContain("Geliefert bestätigt, aber von der Regel (N=2) nicht gedeckt: 1");
      expect(report).not.toContain("Tor bestanden");
      expect(report).not.toContain(s.unbacked!.placeId);
    }));

  it("a tile without places is not worked on: its spots are not counted nor listed; the report names built tiles and the count line", () =>
    withRollback(async (tx) => {
      const s = await setup(tx, { unseeded: true });
      const lines = (await runGate(tx, s.args, s.spots, cfg, { now: new Date(), repoRoot: process.cwd() })).join("\n");
      expect(lines).toContain("spots in " + s.args.subdivision + ": 2");
      expect(lines).toContain("Bearbeitete Kacheln: 1 von 2");
      const report = await readFile(s.args.report, "utf8");
      expect(report).toContain("Bearbeitete Kacheln: 1 von 2");
      expect(report).toMatch(/kein Kandidat in der Nähe \| 1 \|/);
      const csv = await readFile(path.join(s.args.outDir, "n3-tor-n2.csv"), "utf8");
      expect(csv.match(/^miss,/gm)).toHaveLength(1);
    }));

  it("a perfect gate below gate.minConfirmed confirmed places is not passed", () =>
    withRollback(async (tx) => {
      const s = await setup(tx, { knownDomains: 3 });
      const { unknown } = s;
      const [task] = await runGate(tx, { ...s.args, syncConflicts: true }, s.spots, cfg, { now: new Date(), repoRoot: process.cwd() }).then(() => tx.select().from(reviewTasks).where(eq(reviewTasks.subjectId, unknown.placeId)));
      await decideReviewTask(tx, { taskId: task!.id, decision: { action: "berth" }, decidedBy: "admin@test.invalid" });
      expect((await runGate(tx, s.args, s.spots, cfg, { now: new Date(), repoRoot: process.cwd() })).join("\n")).toContain("Tor bestanden bei N=2");
      const lines = (await runGate(tx, s.args, s.spots, realCfg, { now: new Date(), repoRoot: process.cwd() })).join("\n");
      expect(lines).toContain(`Tor nicht bestanden: zu wenige bestätigte Plätze (2 von mindestens ${realCfg.research.gate.minConfirmed})`);
      expect(lines).not.toContain("Tor bestanden");
      expect(await readFile(s.args.report, "utf8")).not.toContain("Tor bestanden");
    }));

  it("the gate needs gate.minCoverage: a perfect gate at 40 % coverage is not passed, at 50 % it is; excluded spots stay out of the count", () =>
    withRollback(async (tx) => {
      const decideUnknown = async (s: Awaited<ReturnType<typeof setup>>) => {
        const [task] = await runGate(tx, { ...s.args, syncConflicts: true }, s.spots, cfg, { now: new Date(), repoRoot: process.cwd() }).then(() => tx.select().from(reviewTasks).where(eq(reviewTasks.subjectId, s.unknown.placeId)));
        await decideReviewTask(tx, { taskId: task!.id, decision: { action: "berth" }, decidedBy: "admin@test.invalid" });
      };
      const far = (name: string, i: number, type: string | null = null) => spot({ name, lon: 21.0 + 0.002 * (i + 1), lat: 35.2005, type });
      // spots in the tile: Zzyzx Cove (covered), Vrrmpf Haven, plus three more: 1 of 5 = 20 %, a dry-berthing and a prohibited spot do not count
      const low = await setup(tx, { extraSpots: [far("Aaa Bight", 0), far("Bbb Bight", 1), far("Ccc Bight", 2), far("Ddd Dry", 3, "dry-berthing"), far("Eee Ban", 4, "prohibited")] });
      await decideUnknown(low);
      const lines = (await runGate(tx, low.args, low.spots, cfg, { now: new Date(), repoRoot: process.cwd() })).join("\n");
      expect(lines).toContain("(mindestens 50 %)");
      expect(lines).toMatch(/Tor nicht bestanden: Abdeckung 20 % \(mindestens 50 %\)/);
      expect(lines).toContain("spots in " + low.args.subdivision + ": 5");
      const report = await readFile(low.args.report, "utf8");
      expect(report).toMatch(/\| 100 % \| 0 \| 20 % \|/);
      expect(report).not.toContain("Tor bestanden");
      expect(report).not.toMatch(INVENTED);
      // lowering the minimum to the reached coverage passes the same data
      const ok = { ...cfg, research: { ...cfg.research, gate: { ...cfg.research.gate, minCoverage: 0.2 } } };
      expect((await runGate(tx, low.args, low.spots, ok, { now: new Date(), repoRoot: process.cwd() })).join("\n")).toContain("Tor bestanden bei N=2");
    }));

  it("a place on a prohibited spot is a gate error in the report and the lists", () =>
    withRollback(async (tx) => {
      const s = await setup(tx, { extraSpots: [spot({ name: "Qwoxx Bay", lon: 21.05, type: "prohibited" })] });
      const lines = (await runGate(tx, s.args, s.spots, cfg, { now: new Date(), repoRoot: process.cwd() })).join("\n");
      expect(lines).toContain("Tor nicht bestanden");
      const csv = await readFile(path.join(s.args.outDir, "n3-tor-n2.csv"), "utf8");
      expect(csv).toContain(`error,${s.unknown.placeId},prohibited,`);
      expect(csv).not.toMatch(/Zzyzx|Qwoxx|Vrrmpf/);
      expect(await readFile(s.args.report, "utf8")).not.toMatch(INVENTED);
    }));

  it("a place near the edge finds its spot just outside the tiles; that spot is not counted", () =>
    withRollback(async (tx) => {
      const s = await setup(tx, { edge: true });
      const lines = await runGate(tx, s.args, s.spots, cfg, { now: new Date(), repoRoot: process.cwd() });
      expect(lines.join("\n")).toContain("spots in " + s.args.subdivision + ": 2");
      // confirmed 3 (known, unknown, edge): the edge place is correct, only the unknown one is a conflict
      expect(await readFile(s.args.report, "utf8")).toMatch(/\| 2 \| 3 \| 2 \| 0 \| 0 \| 0 \| 1 \| 0 \| 0 \| 66\.7 % \|/);
      const csv = await readFile(path.join(s.args.outDir, "n3-tor-n2.csv"), "utf8");
      expect(csv).not.toContain(s.edge!.placeId);
    }));

  it("a confirmed place too far from its spot is a position error in the report and the lists", () =>
    withRollback(async (tx) => {
      const s = await setup(tx, { knownLat: 35.2 + 300 / 111_195 });
      await runGate(tx, s.args, s.spots, cfg, { now: new Date(), repoRoot: process.cwd() });
      expect(await readFile(s.args.report, "utf8")).toMatch(/\| 2 \| 2 \| 0 \| 0 \| 1 \| 0 \| 1 \| 0 \| 0 \| 0 % \|/);
      const csv = await readFile(path.join(s.args.outDir, "n3-tor-n2.csv"), "utf8");
      expect(csv).toMatch(new RegExp(`^error,${s.known.placeId},position,3\\d\\d,1$`, "m"));
    }));

  it("says so when no threshold confirms anything", () =>
    withRollback(async (tx) => {
      const s = await setup(tx, { signals: false });
      const lines = await runGate(tx, s.args, s.spots, cfg, { now: new Date(), repoRoot: process.cwd() });
      expect(lines.join("\n")).toContain("Tor nicht bestanden: bei keiner Schwelle ist ein Platz bestätigt");
      expect(await readFile(s.args.report, "utf8")).toMatch(/\| 2 \| 0 \| 0 \| 0 \| 0 \| 0 \| 0 \| 0 \| 0 \| n\/a \|/);
    }));

  it("passing at N=3 notes the open conflicts at the lower threshold", () =>
    withRollback(async (tx) => {
      const s = await setup(tx, { knownDomains: 3 });
      const lines = await runGate(tx, s.args, s.spots, cfg, { now: new Date(), repoRoot: process.cwd() });
      expect(lines.join("\n")).toContain("Tor bestanden bei N=3");
      expect(await readFile(s.args.report, "utf8")).toContain("Bei kleineren Schwellen (N=2) gibt es noch offene Konflikte");
    }));

  it("refuses an out dir inside the repository", () =>
    withRollback(async (tx) => {
      const s = await setup(tx);
      const root = process.cwd();
      const link = path.join(s.dir, "link");
      await symlink(root, link);
      for (const outDir of [path.join(root, "tmp-lists"), path.join(root, "..lists"), path.join(link, "lists"), root, path.join(root, "x", "..", "y")]) {
        await expect(runGate(tx, { ...s.args, outDir }, s.spots, cfg, { now: new Date(), repoRoot: root }), outDir).rejects.toThrow(/outside the repository/);
      }
    }));

  it("isInsideRepo: names starting with dots are inside, siblings and the parent are not, a case variant is inside on macOS", async () => {
    const root = path.join(os.tmpdir(), "n3-root-x");
    await mkdir(root, { recursive: true });
    dirs.push(root);
    expect(await isInsideRepo(path.join(root, "..lists"), root)).toBe(true);
    expect(await isInsideRepo(path.join(root, "a", "b"), root)).toBe(true);
    expect(await isInsideRepo(`${root}-sibling`, root)).toBe(false);
    expect(await isInsideRepo(path.dirname(root), root)).toBe(false);
    if (process.platform === "darwin") expect(await isInsideRepo(path.join(root.toUpperCase(), "z"), root)).toBe(true);
  });
});
