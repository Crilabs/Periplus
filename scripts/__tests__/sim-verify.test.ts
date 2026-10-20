import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import type { Db } from "@/lib/db/client";
import type { Archive } from "@/lib/adapters/s3";
import { changeEvents, deliveredObjects, deliveries, documents, externalCalls } from "@/lib/db/schema";
import { serializeFile, sha256Hex } from "@/lib/domain/delivery/serialize";
import { createRun } from "@/lib/domain/runs";
import { newId, newPublicId } from "@/lib/domain/ids";
import type { RevisitScenario } from "@/lib/domain/revisit/scenario";
import { scenarioMismatch } from "@/lib/domain/revisit/preflight";
import { parseArgs as parseRevisitArgs, waitForRun } from "@/scripts/sim/revisit";
import { simVerify } from "@/lib/domain/revisit/sim-verify";
import { parseArgs, renderReport } from "@/scripts/sim/verify";
import { withRollback } from "@/test/db";
import { insertQualitySubdivision } from "@/test/quality";
import { memoryArchive } from "@/test/s3";
import { insertNamedObject, insertTestSource } from "@/test/text";

/*
 * The CLIs of the simulated revisit (plan Task 13): argument parsing, and `simVerify` against a simulation clone
 * stood in for by a `sim_meta` table created inside the rolled-back transaction.
 */

describe("sim:verify parseArgs", () => {
  it("needs subdivision and scenario; the key of --base-url comes from PERIPLUS_API_KEY, never from argv (final review A M-4)", () => {
    expect(parseArgs(["--subdivision", "GR-I", "--scenario", "data/sim/s.json"])).toEqual({ subdivision: "GR-I", scenario: "data/sim/s.json" });
    expect(parseArgs(["--subdivision", "a", "--scenario", "s", "--base-url", "http://localhost:3001", "--spot", "sp_1", "--out", "r.json"], { PERIPLUS_API_KEY: "pk_x" })).toEqual({
      subdivision: "a",
      scenario: "s",
      baseUrl: "http://localhost:3001",
      key: "pk_x",
      spot: "sp_1",
      out: "r.json",
    });
    expect(() => parseArgs(["--subdivision", "a", "--scenario", "s", "--base-url", "http://localhost:3001", "--key", "pk_x"], { PERIPLUS_API_KEY: "pk_x" })).toThrow(
      "--key gibt es nicht: den Schlüssel über PERIPLUS_API_KEY übergeben",
    );
    expect(() => parseArgs(["--subdivision", "a", "--scenario", "s", "--base-url", "http://localhost:3001"], {})).toThrow("--base-url braucht den API-Schlüssel der Simulation in PERIPLUS_API_KEY");
    expect(() => parseArgs(["--subdivision", "a"])).toThrow(/usage/);
    expect(() => parseArgs(["--subdivision", "a", "--scenario", "s", "--spot", "sp_1"])).toThrow(/usage/);
    expect(() => parseArgs(["--subdivision", "a", "--subdivision", "b", "--scenario", "s"])).toThrow(/usage/);
    expect(() => parseArgs(["--subdivision", "a", "--scenario", "s", "--verbose", "x"])).toThrow(/usage/);
  });
});

describe("sim:revisit parseArgs", () => {
  it("needs subdivision and scenario, takes a positive page cap", () => {
    expect(parseRevisitArgs(["--subdivision", "GR-I", "--scenario", "data/sim/s.json"])).toEqual({ subdivision: "GR-I", scenario: "data/sim/s.json" });
    expect(parseRevisitArgs(["--subdivision", "a", "--scenario", "s", "--max-pages", "20"])).toEqual({ subdivision: "a", scenario: "s", maxPages: 20 });
    expect(() => parseRevisitArgs(["--subdivision", "a", "--scenario", "s", "--max-pages", "0"])).toThrow(/usage/);
    expect(() => parseRevisitArgs(["--scenario", "s"])).toThrow(/usage/);
    expect(() => parseRevisitArgs(["--subdivision", "a", "--scenario", "s", "--scenario", "t"])).toThrow(/usage/);
  });
});

describe("sim:revisit scenario and polling", () => {
  const sim = { scenarioPath: "data/sim/s.json", writePrefix: "sim/x/", database: "periplus_sim" };

  it("takes only the scenario of PERIPLUS_SIMULATION of its own call and says so (ruling M7-G-R4)", () => {
    expect(scenarioMismatch("data/sim/s.json", sim)).toBeNull();
    expect(scenarioMismatch("./data/sim/../sim/s.json", sim)).toBeNull();
    expect(scenarioMismatch("data/sim/t.json", sim)).toBe(
      "--scenario data/sim/t.json ist nicht das Szenario aus PERIPLUS_SIMULATION dieses Aufrufs (data/sim/s.json); Sim-Worker und sim:revisit aus derselben Env-Datei starten",
    );
  });

  it("stops polling a stuck run at the timeout, and on finished, failed or a missing run", async () => {
    let clock = 0;
    const lines: string[] = [];
    const opts = { pollMs: 5, timeoutMs: 20, sleep: async (ms: number) => void (clock += ms), now: () => clock };
    const stuck = await waitForRun(async () => ({ status: "running", running: { stage: "fetch.url", done: 1, total: 3 } }), (l) => lines.push(l), opts);
    expect(stuck).toBe("timeout");
    expect(lines).toEqual(Array(4).fill("  running – fetch.url 1/3"));
    const states = ["queued", "running", "finished"];
    expect(await waitForRun(async () => ({ status: states.shift()! }), () => {}, { ...opts, timeoutMs: 1_000 })).toBe("finished");
    expect(await waitForRun(async () => ({ status: "failed" }), () => {}, opts)).toBe("failed");
    expect(await waitForRun(async () => null, () => {}, opts)).toBe("missing");
  });
});

/** A place with a public id in a synthetic subdivision, a `sim_meta` row cloned at `fromSeq` = the newest event now. */
async function simClone(tx: Db) {
  const sub = await insertQualitySubdivision(tx, [{ lon: 21.01, lat: 35.2 }]);
  // TODO(plan 14a task 10): the deliveries are per subdivision then; until then an area object with the key carries them
  const areaId = await insertNamedObject(tx, { type: "area", names: [{ name: "Test area" }], lon: 21.2, lat: 35.2, configKey: sub.subdivisionKey });
  const { geoObjectId } = await sub.addPlace();
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
  return { ...sub, areaId, geoObjectId, publicId, fromSeq, scenario };
}

describe("simVerify", () => {
  it("is refused without a simulation clone", () =>
    withRollback(async (tx) => {
      await expect(simVerify(tx, memoryArchive(), { subdivision: "a", scenario: "unused" }, { scenario: { name: "x", entries: [] } as unknown as RevisitScenario })).rejects.toThrow(
        /keine Sim-Datenbank/,
      );
    }));

  it("passes on exactly the expected events and reports 1 of 1 with 0 extra", () =>
    withRollback(async (tx) => {
      const c = await simClone(tx);
      await tx.insert(changeEvents).values({ geoObjectId: c.geoObjectId, attribute: "mooring.buoys", type: "uncertain", severity: "notable", profileVersion: 1 });
      const report = await simVerify(tx, memoryArchive(), { subdivision: c.subdivisionKey, scenario: "unused" }, { scenario: c.scenario });
      expect(report).toMatchObject({ subdivision: c.subdivisionKey, scenario: "sim-test", fromSeq: c.fromSeq, asOf: null, passes: true });
      expect(report.verification).toMatchObject({ expected: 1, correct: 1, unexpected: [] });
      expect(report.costs).toEqual({ totalEur: 0, byService: {} });
      await tx.insert(externalCalls).values([
        { service: "anthropic", operation: "messages", units: "1000", unit: "token", costEur: "0.25", at: new Date("2999-01-02T00:00:00Z") },
        { service: "anthropic", operation: "messages", units: "1000", unit: "token", costEur: "0.5", at: new Date("2999-01-02T00:00:00Z") },
        { service: "crawl", operation: "robots", units: "1", unit: "request", costEur: "0", at: new Date("2999-01-02T00:00:00Z") },
      ]);
      expect((await simVerify(tx, memoryArchive(), { subdivision: c.subdivisionKey, scenario: "unused" }, { scenario: c.scenario })).costs).toEqual({
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
      const report = await simVerify(tx, memoryArchive(), { subdivision: c.subdivisionKey, scenario: "unused" }, { scenario: c.scenario });
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
        { subdivision: c.subdivisionKey, scenario: "unused", baseUrl: "http://localhost:3001", key: "pk_secret" },
        { scenario: c.scenario, fetch: (async (u: string) => (calls.push(String(u)), new Response("{}"))) as unknown as typeof fetch },
      );
      expect(report.verification.passes).toBe(true);
      expect(report.asOf).toEqual({ ok: false, reason: "Kein Revisit-Lauf für den Landesteil" });
      expect(report.passes).toBe(false);
      expect(calls).toEqual([]);
      expect(JSON.stringify(report) + renderReport(report).join("\n")).not.toContain("pk_secret");
      expect(renderReport(report)).toContain("asOf: FEHLER – Kein Revisit-Lauf für den Landesteil");
    }));
});

/** A valid package of the (delivery) area built at `generatedAt` whose spots.json holds `spots` (stored in `archive`). */
async function packageAt(tx: Db, archive: Archive, areaId: string, dataVersion: number, generatedAt: string, spots: unknown[]): Promise<string> {
  const prefix = `deliveries/${areaId}/${dataVersion}/`;
  const bytes = serializeFile({ spots });
  await archive.put(`${prefix}spots.json`, bytes, "application/json");
  const [row] = await tx
    .insert(deliveries)
    .values({
      areaId,
      dataVersion,
      schemaVersion: "1.0",
      generatedAt: new Date(generatedAt),
      status: "valid",
      storagePrefix: prefix,
      fileHashes: { "spots.json": { sha256: sha256Hex(bytes), bytes: bytes.byteLength } },
      objectCounts: {},
      validationReport: {},
      changeSnapshot: sql`pg_current_snapshot()`,
      changeXmin: sql`pg_snapshot_xmin(pg_current_snapshot())`,
    })
    .returning({ id: deliveries.id });
  return row!.id;
}

/** Spot version `version` of `publicId`, delivered from `validFrom` by package `deliveryId`. */
async function spotVersion(tx: Db, areaId: string, publicId: string, version: number, validFrom: string, deliveryId: string) {
  await tx.insert(deliveredObjects).values({ areaId, objectType: "spot", publicId, profileVersion: version, contentHash: `hash-${version}`, validFrom, firstDeliveryId: deliveryId });
}

/**
 * The clone of `simClone` with packages around a finished revisit run on 2026-06-01 (ruling M7-P18 path): v1 before
 * it (2026-05-01), then TWO packages after it, v2 on 2026-06-08 and v3 on 2026-06-20; the spot changes in each.
 */
async function framedClone(tx: Db, o: { secondVersionFrom?: string; unchanged?: boolean } = {}) {
  const c = await simClone(tx);
  await tx.execute(sql`update geo_objects set public_id = ${newPublicId("ar")} where id = ${c.areaId}`);
  // cloned between the first package and the revisit (the costs are not looked at here)
  await tx.execute(sql`update sim_meta set cloned_at = '2026-05-15T00:00:00Z'`);
  await tx.insert(changeEvents).values({ geoObjectId: c.geoObjectId, attribute: "mooring.buoys", type: "uncertain", severity: "notable", profileVersion: 2 });
  const archive = memoryArchive();
  const spot = (v: number) => ({ id: c.publicId, profileVersion: v, name: `Stand ${v}` });
  const p1 = await packageAt(tx, archive, c.areaId, 1, "2026-05-01T08:00:00Z", [spot(1)]);
  await spotVersion(tx, c.areaId, c.publicId, 1, "2026-05-01", p1);
  const { id: runId } = await createRun(tx, { kind: "revisit", scope: { type: "subdivision", id: c.subdivisionKey }, stages: [], params: {}, triggeredBy: "sim:revisit" });
  await tx.execute(sql`update runs set created_at = '2026-06-01T07:00:00Z', status = 'finished' where id = ${runId}`);
  const p2 = await packageAt(tx, archive, c.areaId, 2, "2026-06-08T08:00:00Z", o.unchanged ? [] : [spot(2)]);
  const p3 = await packageAt(tx, archive, c.areaId, 3, "2026-06-20T08:00:00Z", o.unchanged ? [] : [spot(3)]);
  if (!o.unchanged) {
    await spotVersion(tx, c.areaId, c.publicId, 2, o.secondVersionFrom ?? "2026-06-08", p2);
    await spotVersion(tx, c.areaId, c.publicId, 3, "2026-06-20", p3);
  }
  return { ...c, archive, runId, spot };
}

/**
 * A fetch stub answering `body` for an asOf request and `current` (default: the clone's newest state, v3) for the
 * request without asOf, recording the URLs asked for.
 */
function apiStub(body: unknown, current: unknown = { dataVersion: 3, spot: undefined as unknown }) {
  const calls: string[] = [];
  const fetch = (async (u: string) => {
    calls.push(String(u));
    return new Response(JSON.stringify(String(u).includes("asOf=") ? body : current), { status: 200 });
  }) as unknown as typeof globalThis.fetch;
  return { calls, fetch };
}

describe("simVerify asOf (ruling M7-P18, M7-G-R3)", () => {
  const withApi = (subdivisionKey: string) => ({ subdivision: subdivisionKey, scenario: "unused", baseUrl: "http://localhost:3001", key: "pk_secret" });

  it("picks the changed spot, asks for the day before the FIRST package after the revisit and expects the old spot", () =>
    withRollback(async (tx) => {
      const c = await framedClone(tx);
      const api = apiStub({ schemaVersion: "1.0", subdivision: "ar_x", dataVersion: 1, spot: c.spot(1) }, { dataVersion: 3, spot: c.spot(3) });
      const report = await simVerify(tx, c.archive, withApi(c.subdivisionKey), { scenario: c.scenario, fetch: api.fetch });
      // first the newest state (only the simulation web has it), then the state before the revisit
      expect(api.calls).toEqual([`http://localhost:3001/api/v1/spots/${c.publicId}`, `http://localhost:3001/api/v1/spots/${c.publicId}?asOf=2026-06-07`]);
      expect(report.asOf).toEqual({
        ok: true,
        asOf: "2026-06-07",
        spot: c.publicId,
        before: { dataVersion: 1 },
        after: { dataVersion: 3 },
        check: { ok: true, status: 200, dataVersion: 1 },
      });
      expect(report.passes).toBe(true);
      expect(JSON.stringify(report) + renderReport(report).join("\n")).not.toContain("pk_secret");

      // the right data version with another spot is not the old value
      const wrong = apiStub({ dataVersion: 1, spot: c.spot(2) }, { dataVersion: 3, spot: c.spot(3) });
      const failed = await simVerify(tx, c.archive, withApi(c.subdivisionKey), { scenario: c.scenario, fetch: wrong.fetch });
      expect(failed.asOf).toMatchObject({ ok: false, check: { ok: false, reason: "Spot weicht vom Stand vor dem Revisit ab" } });
      expect(failed.passes).toBe(false);
    }));

  it("refuses a spot not delivered before the revisit and one the revisit did not change", () =>
    withRollback(async (tx) => {
      const c = await framedClone(tx, { unchanged: true });
      const api = apiStub({});
      const unchanged = await simVerify(tx, c.archive, withApi(c.subdivisionKey), { scenario: c.scenario, fetch: api.fetch });
      expect(unchanged.asOf).toEqual({ ok: false, reason: `Spot ${c.publicId} hat sich im Revisit nicht geändert` });
      const later = newPublicId("sp");
      const notThen = await simVerify(tx, c.archive, { ...withApi(c.subdivisionKey), spot: later }, { scenario: c.scenario, fetch: api.fetch });
      expect(notThen.asOf).toEqual({ ok: false, reason: `Spot ${later} war am 2026-06-07 nicht geliefert` });
      expect(api.calls).toEqual([]);
    }));

  it("refuses when asOf yields a state after the revisit instead of passing on it", () =>
    withRollback(async (tx) => {
      // v2 claims validity from before the first post-revisit package: asOf would return it
      const c = await framedClone(tx, { secondVersionFrom: "2026-06-02" });
      const api = apiStub({ dataVersion: 2, spot: c.spot(2) });
      const report = await simVerify(tx, c.archive, withApi(c.subdivisionKey), { scenario: c.scenario, fetch: api.fetch });
      expect(report.asOf).toEqual({ ok: false, reason: `asOf 2026-06-07 liefert für ${c.publicId} einen Stand nach dem Revisit` });
      expect(api.calls).toEqual([]);
      expect(report.passes).toBe(false);
    }));

  it("refuses a web that does not serve the simulation's newest state, before asking for asOf (final review A M-4)", () =>
    withRollback(async (tx) => {
      const c = await framedClone(tx);
      // the development web knows only the package before the revisit: it answers v1 for the current state too
      const dev = apiStub({ dataVersion: 1, spot: c.spot(1) }, { dataVersion: 1, spot: c.spot(1) });
      const report = await simVerify(tx, c.archive, withApi(c.subdivisionKey), { scenario: c.scenario, fetch: dev.fetch });
      expect(report.asOf).toEqual({
        ok: false,
        reason:
          "http://localhost:3001 ist nicht das Simulations-Web (Datenversion 1 statt 3 (Stand der Simulation nach dem Revisit)) – das Web aus dem eigenen Worktree mit .env.sim starten",
      });
      expect(dev.calls).toEqual([`http://localhost:3001/api/v1/spots/${c.publicId}`]);
      expect(report.passes).toBe(false);
    }));

  it("refuses a base URL that is not the local simulation web before any request (final review A M-4)", () =>
    withRollback(async (tx) => {
      const c = await framedClone(tx);
      const api = apiStub({});
      for (const baseUrl of ["https://periplus.example.org", "http://10.0.0.5:3001", "ftp://localhost"]) {
        await expect(simVerify(tx, c.archive, { ...withApi(c.subdivisionKey), baseUrl }, { scenario: c.scenario, fetch: api.fetch })).rejects.toThrow(
          "--base-url nur gegen das lokale Simulations-Web (localhost",
        );
      }
      expect(api.calls).toEqual([]);
      for (const baseUrl of ["http://127.0.0.1:3001", "http://[::1]:3001"]) {
        await simVerify(tx, c.archive, { ...withApi(c.subdivisionKey), baseUrl }, { scenario: c.scenario, fetch: api.fetch });
      }
      expect(api.calls).toHaveLength(2);
    }));

  it("is refused while a revisit run of the subdivision is still queued or running", () =>
    withRollback(async (tx) => {
      const c = await framedClone(tx);
      await tx.execute(sql`update runs set status = 'running' where id = ${c.runId}`);
      await expect(simVerify(tx, c.archive, { subdivision: c.subdivisionKey, scenario: "unused" }, { scenario: c.scenario })).rejects.toThrow(
        `Revisit-Lauf ${c.runId} läuft noch – erst abwarten (/runs)`,
      );
    }));
});
