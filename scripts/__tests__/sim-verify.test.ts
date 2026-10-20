import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import type { Db } from "@/lib/db/client";
import { changeEvents, documents, externalCalls } from "@/lib/db/schema";
import { newId, newPublicId } from "@/lib/domain/ids";
import type { RevisitScenario } from "@/lib/domain/revisit/scenario";
import { parseArgs as parseRevisitArgs } from "@/scripts/sim/revisit";
import { parseArgs, renderReport, simVerify } from "@/scripts/sim/verify";
import { withRollback } from "@/test/db";
import { insertQualityArea } from "@/test/quality";
import { memoryArchive } from "@/test/s3";
import { insertTestSource } from "@/test/text";

/*
 * The CLIs of the simulated revisit (plan Task 13): argument parsing, and `simVerify` against a simulation clone
 * stood in for by a `sim_meta` table created inside the rolled-back transaction.
 */

describe("sim:verify parseArgs", () => {
  it("needs area and scenario; base url and key go together, spot only with them", () => {
    expect(parseArgs(["--area", "saronic", "--scenario", "data/sim/s.json"])).toEqual({ area: "saronic", scenario: "data/sim/s.json" });
    expect(parseArgs(["--area", "a", "--scenario", "s", "--base-url", "http://localhost:3001", "--key", "pk_x", "--spot", "sp_1", "--out", "r.json"])).toEqual({
      area: "a",
      scenario: "s",
      baseUrl: "http://localhost:3001",
      key: "pk_x",
      spot: "sp_1",
      out: "r.json",
    });
    expect(() => parseArgs(["--area", "a"])).toThrow(/usage/);
    expect(() => parseArgs(["--area", "a", "--scenario", "s", "--base-url", "http://x"])).toThrow(/usage/);
    expect(() => parseArgs(["--area", "a", "--scenario", "s", "--spot", "sp_1"])).toThrow(/usage/);
    expect(() => parseArgs(["--area", "a", "--area", "b", "--scenario", "s"])).toThrow(/usage/);
    expect(() => parseArgs(["--area", "a", "--scenario", "s", "--verbose", "x"])).toThrow(/usage/);
  });
});

describe("sim:revisit parseArgs", () => {
  it("needs area and scenario, takes a positive page cap", () => {
    expect(parseRevisitArgs(["--area", "saronic", "--scenario", "data/sim/s.json"])).toEqual({ area: "saronic", scenario: "data/sim/s.json" });
    expect(parseRevisitArgs(["--area", "a", "--scenario", "s", "--max-pages", "20"])).toEqual({ area: "a", scenario: "s", maxPages: 20 });
    expect(() => parseRevisitArgs(["--area", "a", "--scenario", "s", "--max-pages", "0"])).toThrow(/usage/);
    expect(() => parseRevisitArgs(["--scenario", "s"])).toThrow(/usage/);
    expect(() => parseRevisitArgs(["--area", "a", "--scenario", "s", "--scenario", "t"])).toThrow(/usage/);
  });
});

/** A place with a public id in a synthetic area, a `sim_meta` row cloned at `fromSeq` = the newest event now. */
async function simClone(tx: Db) {
  const area = await insertQualityArea(tx, [{ lon: 21.01, lat: 35.2 }]);
  const { geoObjectId } = await area.addPlace();
  const publicId = newPublicId("sp");
  await tx.execute(sql`update places set public_id = ${publicId} where geo_object_id = ${geoObjectId}`);
  const { rows } = await tx.execute<{ seq: string | null }>(sql`select max(seq)::text as seq from change_events`);
  const fromSeq = Number(rows[0]?.seq ?? 0);
  await tx.execute(sql`create table sim_meta (cloned_at timestamptz not null, source_db text not null, from_seq bigint not null)`);
  // cloned far in the future: the clone's costs are only the calls this test books (never counted DB-wide)
  await tx.execute(sql`insert into sim_meta values ('2999-01-01T00:00:00Z', 'periplus', ${fromSeq})`);
  const sourceId = await insertTestSource(tx);
  const url = `https://${newId()}.test.invalid/gone`;
  await tx.insert(documents).values({ sourceId, url, urlNormalized: url, docType: "pilot_guide", status: "gone" });
  const scenario: RevisitScenario = {
    name: "sim-test",
    entries: [{ id: "e1", url, edit: { op: "gone" }, expect: { document: "gone", events: [{ subject: publicId, attribute: "mooring.buoys", type: "uncertain", severity: "notable" }] } }],
  };
  return { ...area, geoObjectId, publicId, fromSeq, scenario };
}

describe("simVerify", () => {
  it("is refused without a simulation clone", () =>
    withRollback(async (tx) => {
      await expect(simVerify(tx, memoryArchive(), { area: "a", scenario: "unused" }, { scenario: { name: "x", entries: [] } as unknown as RevisitScenario })).rejects.toThrow(
        /keine Sim-Datenbank/,
      );
    }));

  it("passes on exactly the expected events and reports 1 of 1 with 0 extra", () =>
    withRollback(async (tx) => {
      const c = await simClone(tx);
      await tx.insert(changeEvents).values({ geoObjectId: c.geoObjectId, attribute: "mooring.buoys", type: "uncertain", severity: "notable", profileVersion: 1 });
      const report = await simVerify(tx, memoryArchive(), { area: c.areaKey, scenario: "unused" }, { scenario: c.scenario });
      expect(report).toMatchObject({ area: c.areaKey, scenario: "sim-test", fromSeq: c.fromSeq, asOf: null, passes: true });
      expect(report.verification).toMatchObject({ expected: 1, correct: 1, unexpected: [] });
      expect(report.costs).toEqual({ totalEur: 0, byService: {} });
      await tx.insert(externalCalls).values([
        { service: "anthropic", operation: "messages", units: "1000", unit: "token", costEur: "0.25", at: new Date("2999-01-02T00:00:00Z") },
        { service: "anthropic", operation: "messages", units: "1000", unit: "token", costEur: "0.5", at: new Date("2999-01-02T00:00:00Z") },
        { service: "crawl", operation: "robots", units: "1", unit: "request", costEur: "0", at: new Date("2999-01-02T00:00:00Z") },
      ]);
      expect((await simVerify(tx, memoryArchive(), { area: c.areaKey, scenario: "unused" }, { scenario: c.scenario })).costs).toEqual({
        totalEur: 0.75,
        byService: { anthropic: { calls: 2, eur: 0.75 }, crawl: { calls: 1, eur: 0 } },
      });
      const lines = renderReport(report);
      expect(lines).toContain("1 von 1 erwartet, 0 zusätzliche");
      expect(lines.at(-1)).toBe("Bestanden.");
    }));

  it("fails on an extra event and lists it", () =>
    withRollback(async (tx) => {
      const c = await simClone(tx);
      await tx.insert(changeEvents).values({ geoObjectId: c.geoObjectId, attribute: "mooring.buoys", type: "uncertain", severity: "notable", profileVersion: 1 });
      await tx.insert(changeEvents).values({ geoObjectId: c.geoObjectId, attribute: "services.water", type: "expired", severity: "notable", profileVersion: 1 });
      const report = await simVerify(tx, memoryArchive(), { area: c.areaKey, scenario: "unused" }, { scenario: c.scenario });
      expect(report.passes).toBe(false);
      const lines = renderReport(report);
      expect(lines).toContain("1 von 1 erwartet, 1 zusätzliche");
      expect(lines.some((l) => l.includes(`${c.publicId} services.water expired notable`))).toBe(true);
      expect(lines.at(-1)).toBe("Nicht bestanden.");
    }));

  it("with --base-url fails when no package frames the revisit, and never prints the key", () =>
    withRollback(async (tx) => {
      const c = await simClone(tx);
      await tx.insert(changeEvents).values({ geoObjectId: c.geoObjectId, attribute: "mooring.buoys", type: "uncertain", severity: "notable", profileVersion: 1 });
      const calls: string[] = [];
      const report = await simVerify(
        tx,
        memoryArchive(),
        { area: c.areaKey, scenario: "unused", baseUrl: "http://localhost:3001", key: "pk_secret" },
        { scenario: c.scenario, fetch: (async (u: string) => (calls.push(String(u)), new Response("{}"))) as unknown as typeof fetch },
      );
      expect(report.verification.passes).toBe(true);
      expect(report.asOf).toEqual({ ok: false, reason: "Kein Revisit-Lauf für das Revier" });
      expect(report.passes).toBe(false);
      expect(calls).toEqual([]);
      expect(JSON.stringify(report) + renderReport(report).join("\n")).not.toContain("pk_secret");
      expect(renderReport(report)).toContain("asOf: FEHLER – Kein Revisit-Lauf für das Revier");
    }));
});
