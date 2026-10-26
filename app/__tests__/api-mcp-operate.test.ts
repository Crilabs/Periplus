import { eq, sql } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import { describe, expect, it, vi } from "vitest";
import type { Db } from "@/lib/db/client";
import { geomFromGeoJson } from "@/lib/db/geometry";
import { landPolygons, places, queueControls, reviewDecisions, reviewTasks, runs, users } from "@/lib/db/schema";
import { recordExternalCall } from "@/lib/domain/costs";
import { createReviewTask } from "@/lib/domain/review";
import { createRun } from "@/lib/domain/runs";
import { insertPlace } from "@/test/consolidation";
import { createMcpToken } from "@/lib/domain/mcp-tokens";
import { STAGES_OF, type StartKind } from "@/lib/domain/mcp/estimate";
import { newId } from "@/lib/domain/ids";
import { tileIdFor } from "@/lib/domain/tiles";
import { RUN_SCOPE_LABELS } from "@/lib/pipeline/run-scope-labels";
import { testDb, withRollback } from "@/test/db";
import { insertTestRaster } from "@/test/geometry/raster";
import { IMAGE_LAT, IMAGE_LON, insertSpot } from "@/test/images";
import { insertNamedObject, insertTestSubdivision, insertTestTile } from "@/test/text";

/*
 * The start tools of `/api/mcp` (plan 2026-10-26-periplus-mcp-steuern, Task 5): without `confirm` nothing is written and
 * the answer carries scope, estimate and budgets; with `confirm` the same starter as the admin page runs, triggered by
 * `mcp:<email>`. pg-boss is a recording fake; the research gate is closed for every subdivision but `GATE_KEY`.
 */

const GATE_KEY = "XT-GATE5";
/** `images.pipeline.maxGenerationsPerRun` in these tests. */
const IMAGE_CAP = 1;

let db: Db = testDb();
const inserted: Array<{ queue: string; data: Record<string, unknown> }> = [];
const boss = {
  insert: async (queue: string, jobs: Array<{ id?: string; data: Record<string, unknown> }>) => {
    inserted.push(...jobs.map((j) => ({ queue, data: j.data })));
    return jobs.map((j) => j.id ?? newId());
  },
  findJobs: async () => [],
  cancel: async () => ({}),
} as unknown as PgBoss;

vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  connection: async () => {},
}));
vi.mock("@/lib/db/client", async (importActual) => ({
  ...(await importActual<typeof import("@/lib/db/client")>()),
  getDb: () => db,
}));
vi.mock("@/lib/jobs/boss", () => ({ getBoss: async () => boss }));
const retried: Array<{ queue: string; jobId: string }> = [];
vi.mock("@/lib/domain/jobs-view", async (importActual) => ({
  ...(await importActual<typeof import("@/lib/domain/jobs-view")>()),
  retryFailedJob: async (_db: unknown, _boss: unknown, queue: string, jobId: string) => void retried.push({ queue, jobId }),
}));
vi.mock("@/lib/config", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/config")>();
  return {
    ...actual,
    getConfig: () => {
      const cfg = actual.getConfig();
      return {
        ...cfg,
        research: { ...cfg.research, gate: { ...cfg.research.gate, subdivision: GATE_KEY, released: false } },
        images: { ...cfg.images, pipeline: { ...cfg.images.pipeline, maxGenerationsPerRun: IMAGE_CAP } },
      };
    },
  };
});

const route = await import("../api/mcp/route");

const HEADERS = { "content-type": "application/json", accept: "application/json, text/event-stream" };

const rpc = (token: string, method: string, params: object = {}) =>
  route.POST(
    new Request("http://localhost/api/mcp", {
      method: "POST",
      headers: { ...HEADERS, authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    }),
  );

async function tokenFor(tx: Db): Promise<{ email: string; token: string }> {
  const email = `${newId()}@test.invalid`;
  const [user] = await tx.insert(users).values({ email, passwordHash: "x" }).returning({ id: users.id });
  const { token } = await createMcpToken(tx, { userId: user!.id, name: "test", validityDays: 30 });
  return { email, token };
}

const callTool = async (token: string, name: string, args: object = {}) => {
  const res = await rpc(token, "tools/call", { name, arguments: args });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { result: { content: Array<{ text: string }>; isError?: boolean } };
  return { isError: body.result.isError ?? false, text: body.result.content[0]!.text };
};

const runCount = async (tx: Db) => Number((await tx.execute<{ n: string }>(sql`select count(*)::text as n from runs`)).rows[0]!.n);

/** A subdivision with one tile and `names.length` candidate places on it. */
async function seedCandidates(tx: Db, key: string, names: string[] = ["Vathi", "Kalo"]): Promise<{ tileId: string; placeIds: string[] }> {
  const sub = await insertTestSubdivision(tx, key, [21.0, 35.0, 21.5, 35.5], { country: "GR" });
  const tileId = await insertTestTile(tx, tileIdFor(21.1, 35.2), null, sub.id);
  const placeIds: string[] = [];
  for (const [i, name] of names.entries()) {
    const position = { type: "Point" as const, coordinates: [21.1 + i / 100, 35.2] };
    const objectId = await insertNamedObject(tx, { type: "bay", names: [{ name, language: "en" }], lon: position.coordinates[0]!, lat: 35.2, subdivisionId: sub.id });
    const [place] = await tx.insert(places).values({ geoObjectId: objectId, kind: "anchorage", status: "candidate", position: geomFromGeoJson(position) }).returning({ id: places.id });
    placeIds.push(place!.id);
  }
  return { tileId, placeIds };
}

describe("/api/mcp start tools", () => {
  /**
   * Every start tool with the kind of run it starts; each is given a fresh `GATE_KEY` subdivision with one tile and two
   * candidates (geometry also bathymetry on that tile and land beside it, its starter refuses a tile without).
   */
  const START_TOOLS: Array<[string, StartKind, (key: string) => object, ((tx: Db, tileId: string) => Promise<unknown>)?]> = [
    ["subdivisions_rebuild", "subdivisions", () => ({})],
    ["subdivision_build", "build", (key) => ({ subdivision: key })],
    ["gazetteer_start", "gazetteer", (key) => ({ subdivision: key })],
    ["datasets_start", "datasets", (key) => ({ subdivision: key })],
    ["seed_start", "seed", (key) => ({ subdivision: key })],
    ["geometry_start", "geometry", (key) => ({ subdivision: key }), async (tx, tileId) => {
      await insertTestRaster(tx, { tileId });
      await tx.insert(landPolygons).values({ geom: sql`ST_MakeEnvelope(21.10, 35.20, 21.11, 35.21, 4326)`, datasetVersion: "test" });
    }],
    ["research_start", "research", (key) => ({ subdivision: key })],
    ["images_start", "images", (key) => ({ subdivision: key })],
    ["delivery_start", "delivery", (key) => ({ subdivision: key })],
  ];

  it.each(START_TOOLS)("%s: without confirm nothing is written; with confirm one run of its stages, by mcp:<email>, with its size", (tool, kind, args, prepare) =>
    withRollback(async (tx) => {
      db = tx;
      inserted.length = 0;
      const { email, token } = await tokenFor(tx);
      const { tileId } = await seedCandidates(tx, GATE_KEY);
      await prepare?.(tx, tileId);
      const before = await runCount(tx);

      const preview = await callTool(token, tool, args(GATE_KEY));
      expect(preview.isError).toBe(false);
      expect(JSON.parse(preview.text)).toMatchObject({ gestartet: false, umfang: expect.any(Object), schaetzung: { text: expect.any(String) }, budgets: expect.any(Array) });
      expect(await runCount(tx)).toBe(before);
      expect(inserted).toHaveLength(0);

      const started = await callTool(token, tool, { ...args(GATE_KEY), confirm: true });
      expect(started.isError ? started.text : "").toBe("");
      const body = JSON.parse(started.text);
      expect(body).toMatchObject({ gestartet: true, runId: expect.any(String) });
      expect(await runCount(tx)).toBe(before + 1);
      const [run] = await tx.select().from(runs).where(eq(runs.id, body.runId));
      expect(run!.triggeredBy).toBe(`mcp:${email}`);
      expect(run!.stages).toEqual([...STAGES_OF[kind]]);
      expect((run!.params as { scopeSize?: unknown }).scopeSize).toEqual(body.umfang);
    }),
  );

  it("research_start without confirm writes nothing and answers scope, estimate and budgets", () =>
    withRollback(async (tx) => {
      db = tx;
      inserted.length = 0;
      const { token } = await tokenFor(tx);
      await seedCandidates(tx, GATE_KEY);
      const before = await runCount(tx);

      const res = await callTool(token, "research_start", { subdivision: GATE_KEY });
      expect(res.isError).toBe(false);
      const body = JSON.parse(res.text);
      expect(body).toMatchObject({
        gestartet: false,
        umfang: { unit: "places", count: 2 },
        schaetzung: { text: expect.any(String) },
        budgets: expect.any(Array),
        hinweis: "Mit confirm: true starten.",
      });
      expect(Object.keys(body.schaetzung).sort()).toEqual(["basisLauf", "dienste", "eur", "text"]);
      expect(body.schaetzung.dienste).toEqual([]);
      expect(await runCount(tx)).toBe(before);
      expect(inserted).toHaveLength(0);
    }));

  it("research_start with confirm starts one run triggered by mcp:<email> and records its scope size", () =>
    withRollback(async (tx) => {
      db = tx;
      inserted.length = 0;
      const { email, token } = await tokenFor(tx);
      await seedCandidates(tx, GATE_KEY);
      const before = await runCount(tx);

      const res = await callTool(token, "research_start", { subdivision: GATE_KEY, confirm: true });
      expect(res.isError).toBe(false);
      const body = JSON.parse(res.text);
      expect(body).toMatchObject({ gestartet: true, runId: expect.any(String), pfad: `/runs/${body.runId}`, umfang: { unit: "places", count: 2 } });
      expect(await runCount(tx)).toBe(before + 1);
      const [run] = await tx.select().from(runs).where(eq(runs.id, body.runId));
      expect(run).toMatchObject({ triggeredBy: `mcp:${email}`, scopeType: "subdivision", scopeId: GATE_KEY });
      expect(run!.params).toMatchObject({ subdivisionKey: GATE_KEY, scopeSize: { unit: "places", count: 2 } });
      expect(inserted.map((j) => j.queue)).toEqual(["research.search", "research.search"]);
    }));

  it("the preview names the paid services of the basis run with their cost", () =>
    withRollback(async (tx) => {
      db = tx;
      const { token } = await tokenFor(tx);
      await seedCandidates(tx, GATE_KEY);
      const [basis] = await tx
        .insert(runs)
        .values({ kind: "stage", scopeType: "system", scopeId: "places", stages: [...STAGES_OF.research], params: { scopeSize: { unit: "places", count: 4 } }, triggeredBy: "t", status: "finished", finishedAt: new Date("2099-01-01T00:00:00Z") })
        .returning({ id: runs.id });
      await recordExternalCall(tx, { service: "serper", operation: "search", units: 1, unit: "call", costEur: 0.4, runId: basis!.id });
      await recordExternalCall(tx, { service: "anthropic", operation: "m", units: 1, unit: "call", costEur: 1.6, runId: basis!.id });
      const body = JSON.parse((await callTool(token, "research_start", { subdivision: GATE_KEY })).text);
      expect(body.schaetzung).toMatchObject({
        basisLauf: basis!.id,
        eur: 1,
        dienste: [
          { dienst: "anthropic", eur: 1.6 },
          { dienst: "serper", eur: 0.4 },
        ],
      });
    }));

  it("research_start outside the gate subdivision is refused with the admin page's German text", () =>
    withRollback(async (tx) => {
      db = tx;
      const { token } = await tokenFor(tx);
      await seedCandidates(tx, "XT-OTHER5");
      const before = await runCount(tx);
      const res = await callTool(token, "research_start", { subdivision: "XT-OTHER5", confirm: true });
      expect(res).toEqual({ isError: true, text: RUN_SCOPE_LABELS.research_gate_closed });
      expect(res.text).toMatch(/^Recherche erst nach bestandenem Navily-Test/);
      expect(await runCount(tx)).toBe(before);
    }));

  it("research_start for a tile: its places become a places run; a tile without places is a tool error", () =>
    withRollback(async (tx) => {
      db = tx;
      const { token } = await tokenFor(tx);
      const { tileId, placeIds } = await seedCandidates(tx, GATE_KEY);
      const empty = await insertTestTile(tx, tileIdFor(21.4, 35.4), null, null);

      for (const confirm of [false, true]) {
        expect(await callTool(token, "research_start", { tileId: empty, confirm })).toEqual({ isError: true, text: "Kachel hat keine Plätze" });
      }

      const preview = JSON.parse((await callTool(token, "research_start", { tileId })).text);
      expect(preview).toMatchObject({ gestartet: false, umfang: { unit: "places", count: 2 } });
      const started = JSON.parse((await callTool(token, "research_start", { tileId, confirm: true })).text);
      expect(started.gestartet).toBe(true);
      const [run] = await tx.select().from(runs).where(eq(runs.id, started.runId));
      expect(run).toMatchObject({ scopeType: "system", scopeId: "places" });
      expect((run!.params as { placeIds: string[] }).placeIds.sort()).toEqual([...placeIds].sort());
    }));

  it("geometry_start without confirm reports no external costs and writes nothing", () =>
    withRollback(async (tx) => {
      db = tx;
      const { token } = await tokenFor(tx);
      await seedCandidates(tx, GATE_KEY);
      const before = await runCount(tx);
      const body = JSON.parse((await callTool(token, "geometry_start", { subdivision: GATE_KEY })).text);
      expect(body).toMatchObject({ gestartet: false, umfang: { unit: "tiles", count: 1 }, schaetzung: { eur: 0, text: "ohne externe Kosten", basisLauf: null, dienste: [] } });
      expect(await runCount(tx)).toBe(before);
    }));

  it("images_start without confirm: the run's images capped at maxGenerationsPerRun, the whole backlog apart", () =>
    withRollback(async (tx) => {
      db = tx;
      const { token } = await tokenFor(tx);
      const key = `XT-${newId().slice(0, 8)}`;
      const sd = { key, ...(await insertTestSubdivision(tx, key, [IMAGE_LON - 0.3, IMAGE_LAT - 0.3, IMAGE_LON + 0.3, IMAGE_LAT + 0.3], { country: "GR" })) };
      await insertSpot(tx, sd.id, { kind: "marina" });
      await insertSpot(tx, sd.id, { lon: IMAGE_LON + 0.05, kind: "port" });
      const body = JSON.parse((await callTool(token, "images_start", { subdivision: sd.key })).text);
      expect(body).toMatchObject({ gestartet: false, umfang: { unit: "places", count: IMAGE_CAP }, rueckstand: 2 });
      const delivery = JSON.parse((await callTool(token, "delivery_start", { subdivision: sd.key })).text);
      expect(delivery).not.toHaveProperty("rueckstand");
    }));

  it("not exactly one scope field, an unknown subdivision or tile: tool errors", () =>
    withRollback(async (tx) => {
      db = tx;
      const { token } = await tokenFor(tx);
      const { tileId } = await seedCandidates(tx, GATE_KEY);
      const before = await runCount(tx);
      expect((await callTool(token, "research_start", { subdivision: GATE_KEY, tileId, confirm: true })).isError).toBe(true);
      expect((await callTool(token, "seed_start", { confirm: true })).isError).toBe(true);
      expect(await callTool(token, "gazetteer_start", { subdivision: "XT-none" })).toEqual({ isError: true, text: "Landesteil XT-none unbekannt" });
      expect(await callTool(token, "geometry_start", { tileId: "q025:1:1" })).toEqual({ isError: true, text: "Kachel q025:1:1 unbekannt" });
      expect(await runCount(tx)).toBe(before);
    }));

  it("a wrong subdivision key in the write tools: German tool errors for unknown, a retired area key and excluded", () =>
    withRollback(async (tx) => {
      db = tx;
      const { token } = await tokenFor(tx);
      const excluded = `XT-${newId().slice(0, 8)}`;
      await insertTestSubdivision(tx, excluded, [21.0, 35.0, 21.5, 35.5], { country: "GR", status: "excluded" });
      const retired = "Revier-Schlüssel saronic ist kein Laufumfang mehr; Landesteil angeben (z. B. GR-I)";
      const before = await runCount(tx);
      const calls: Array<[string, (key: string) => object]> = [
        ["gazetteer_start", (key) => ({ subdivision: key, confirm: true })],
        ["images_start", (key) => ({ subdivision: key })],
        ["seed_start", (key) => ({ subdivision: key, confirm: true })],
        ["research_start", (key) => ({ subdivision: key })],
        ["gate_sync_conflicts", (key) => ({ subdivision: key, threshold: 3, placeIds: [] })],
      ];
      for (const [tool, args] of calls) {
        expect(await callTool(token, tool, args("XT-none"))).toEqual({ isError: true, text: "Landesteil XT-none unbekannt" });
        expect(await callTool(token, tool, args("saronic"))).toEqual({ isError: true, text: retired });
        expect(await callTool(token, tool, args(excluded))).toEqual({ isError: true, text: `Landesteil ${excluded} ist ausgeschlossen` });
      }
      expect(await runCount(tx)).toBe(before);
    }));

  it("subdivision_build twice: the second answers with the running build", () =>
    withRollback(async (tx) => {
      db = tx;
      const { token } = await tokenFor(tx);
      await seedCandidates(tx, GATE_KEY);
      const first = JSON.parse((await callTool(token, "subdivision_build", { subdivision: GATE_KEY, confirm: true })).text);
      expect(first).toMatchObject({ gestartet: true, umfang: { unit: "tiles", count: 1 } });
      const second = JSON.parse((await callTool(token, "subdivision_build", { subdivision: GATE_KEY, confirm: true })).text);
      expect(second).toEqual({ gestartet: false, laeuftSchon: first.runId, pfad: `/runs/${first.runId}` });
    }));

  it("tools/list marks the start tools as writing", () =>
    withRollback(async (tx) => {
      db = tx;
      const { token } = await tokenFor(tx);
      const res = await rpc(token, "tools/list");
      const body = (await res.json()) as { result: { tools: Array<{ name: string; annotations?: Record<string, boolean> }> } };
      const starts = ["subdivisions_rebuild", "subdivision_build", "gazetteer_start", "seed_start", "datasets_start", "geometry_start", "research_start", "images_start", "delivery_start"];
      for (const name of starts) {
        expect(body.result.tools.find((t) => t.name === name)?.annotations).toEqual({ readOnlyHint: false, destructiveHint: true, openWorldHint: false });
      }
    }));

  it("run_end ends a running run as mcp:<email>", () =>
    withRollback(async (tx) => {
      db = tx;
      const { token, email } = await tokenFor(tx);
      const { id } = await createRun(tx, { kind: "system", scope: { type: "system", id: "test" }, stages: ["seed"], triggeredBy: "test" });
      const res = await callTool(token, "run_end", { runId: id });
      expect(res.isError).toBe(false);
      expect(JSON.parse(res.text)).toEqual({ beendet: true, aufgeraeumt: true });
      const [run] = await tx.select().from(runs).where(eq(runs.id, id));
      expect(run).toMatchObject({ endedBy: `mcp:${email}`, endedAt: expect.any(Date) });
      expect(JSON.parse((await callTool(token, "run_end", { runId: id })).text)).toEqual({ beendet: false, aufgeraeumt: false });
    }));

  it("queue_pause writes the pause as mcp:<email>, queue_resume removes it; an unknown queue is refused", () =>
    withRollback(async (tx) => {
      db = tx;
      const { token, email } = await tokenFor(tx);
      await callTool(token, "queue_pause", { queue: "seed.tile" });
      const [row] = await tx.select().from(queueControls).where(eq(queueControls.queue, "seed.tile"));
      expect(row).toMatchObject({ pausedUntil: null, reason: "manual", updatedBy: `mcp:${email}` });
      await callTool(token, "queue_resume", { queue: "seed.tile" });
      expect(await tx.select().from(queueControls).where(eq(queueControls.queue, "seed.tile"))).toHaveLength(0);
      expect((await callTool(token, "queue_pause", { queue: "no.such" })).isError).toBe(true);
    }));

  it("job_retry retries the job and decides its open failed_job task with retry as mcp:<email>", () =>
    withRollback(async (tx) => {
      db = tx;
      retried.length = 0;
      const { token, email } = await tokenFor(tx);
      const jobId = newId();
      const { id: taskId } = await createReviewTask(tx, { kind: "failed_job", subjectType: "job", subjectId: jobId, context: { queue: "seed.tile" } });
      const res = await callTool(token, "job_retry", { queue: "seed.tile", jobId });
      expect(res.isError).toBe(false);
      expect(retried).toEqual([{ queue: "seed.tile", jobId }]);
      const [task] = await tx.select().from(reviewTasks).where(eq(reviewTasks.id, taskId));
      expect(task!.status).toBe("decided");
      const [decision] = await tx.select().from(reviewDecisions).where(eq(reviewDecisions.taskId, taskId));
      expect(decision).toMatchObject({ decision: { action: "retry" }, decidedBy: `mcp:${email}` });
    }));

  it("gate_sync_conflicts: foreign ids, an unknown subdivision or a threshold outside the config are refused; own ids create tasks once", () =>
    withRollback(async (tx) => {
      db = tx;
      const { token } = await tokenFor(tx);
      const key = `XT-${newId().slice(0, 8)}`;
      const { placeIds } = await seedCandidates(tx, key);
      const foreign = (await insertPlace(tx, { name: "Zzyzx Cove" })).placeId;
      const conflicts = () => tx.select().from(reviewTasks).where(eq(reviewTasks.kind, "research_conflict"));
      const before = (await conflicts()).length;

      const refused = await callTool(token, "gate_sync_conflicts", { subdivision: key, threshold: 3, placeIds: [placeIds[0], foreign] });
      expect(refused).toEqual({ isError: true, text: `1 Platz-IDs gehören nicht zu ${key}` });
      expect(refused.text).not.toContain(foreign);
      expect((await callTool(token, "gate_sync_conflicts", { subdivision: key, threshold: 7, placeIds: [placeIds[0]] })).isError).toBe(true);
      expect(await callTool(token, "gate_sync_conflicts", { subdivision: "XT-none", threshold: 3, placeIds: [] })).toEqual({ isError: true, text: "Landesteil XT-none unbekannt" });
      expect((await conflicts()).length).toBe(before);

      const first = JSON.parse((await callTool(token, "gate_sync_conflicts", { subdivision: key, threshold: 3, placeIds })).text);
      expect(first).toEqual({ angelegt: 2, offen: 2 });
      const second = JSON.parse((await callTool(token, "gate_sync_conflicts", { subdivision: key, threshold: 3, placeIds })).text);
      expect(second).toEqual({ angelegt: 0, offen: 2 });
      expect((await conflicts()).length).toBe(before + 2);
    }));

  it("gate_sync_conflicts takes the whole conflict list, up to 5000 ids, in one call", () =>
    withRollback(async (tx) => {
      db = tx;
      const { token } = await tokenFor(tx);
      const key = `XT-${newId().slice(0, 8)}`;
      await seedCandidates(tx, key);
      const ids = (n: number) => Array.from({ length: n }, () => newId());
      expect(await callTool(token, "gate_sync_conflicts", { subdivision: key, threshold: 3, placeIds: ids(5000) })).toEqual({ isError: true, text: `5000 Platz-IDs gehören nicht zu ${key}` });
      const tooMany = await callTool(token, "gate_sync_conflicts", { subdivision: key, threshold: 3, placeIds: ids(5001) });
      expect(tooMany.isError).toBe(true);
      expect(tooMany.text).not.toContain("gehören nicht");
    }));

  it("tools/list marks the control tools as writing", () =>
    withRollback(async (tx) => {
      db = tx;
      const { token } = await tokenFor(tx);
      const res = await rpc(token, "tools/list");
      const body = (await res.json()) as { result: { tools: Array<{ name: string; annotations?: Record<string, boolean> }> } };
      for (const name of ["run_end", "job_retry", "queue_pause", "queue_resume", "gate_sync_conflicts"]) {
        expect(body.result.tools.find((t) => t.name === name)?.annotations).toEqual({ readOnlyHint: false, destructiveHint: true, openWorldHint: false });
      }
    }));
});
