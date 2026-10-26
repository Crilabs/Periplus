import { eq, sql } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import { describe, expect, it, vi } from "vitest";
import type { Db } from "@/lib/db/client";
import { geomFromGeoJson } from "@/lib/db/geometry";
import { places, runs, users } from "@/lib/db/schema";
import { createMcpToken } from "@/lib/domain/mcp-tokens";
import { newId } from "@/lib/domain/ids";
import { tileIdFor } from "@/lib/domain/tiles";
import { RUN_SCOPE_LABELS } from "@/lib/pipeline/run-scope-labels";
import { testDb, withRollback } from "@/test/db";
import { insertNamedObject, insertTestSubdivision, insertTestTile } from "@/test/text";

/*
 * The start tools of `/api/mcp` (plan 2026-10-26-periplus-mcp-steuern, Task 5): without `confirm` nothing is written and
 * the answer carries scope, estimate and budgets; with `confirm` the same starter as the admin page runs, triggered by
 * `mcp:<email>`. pg-boss is a recording fake; the research gate is closed for every subdivision but `GATE_KEY`.
 */

const GATE_KEY = "XT-GATE5";

let db: Db = testDb();
const inserted: Array<{ queue: string; data: Record<string, unknown> }> = [];
const boss = {
  insert: async (queue: string, jobs: Array<{ id?: string; data: Record<string, unknown> }>) => {
    inserted.push(...jobs.map((j) => ({ queue, data: j.data })));
    return jobs.map((j) => j.id ?? newId());
  },
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
vi.mock("@/lib/config", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/config")>();
  return {
    ...actual,
    getConfig: () => {
      const cfg = actual.getConfig();
      return { ...cfg, research: { ...cfg.research, gate: { ...cfg.research.gate, subdivision: GATE_KEY, released: false } } };
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
      expect(Object.keys(body.schaetzung).sort()).toEqual(["basisLauf", "eur", "text"]);
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
      expect(body).toMatchObject({ gestartet: false, umfang: { unit: "tiles", count: 1 }, schaetzung: { eur: 0, text: "ohne externe Kosten", basisLauf: null } });
      expect(await runCount(tx)).toBe(before);
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
});
