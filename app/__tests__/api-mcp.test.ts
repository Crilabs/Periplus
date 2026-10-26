import { afterEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@/lib/db/client";
import { users } from "@/lib/db/schema";
import { createApiClient } from "@/lib/domain/api-clients";
import { createMcpToken, revokeMcpToken } from "@/lib/domain/mcp-tokens";
import { newId } from "@/lib/domain/ids";
import { syncConflictTasks } from "@/lib/domain/research/gate-conflicts";
import { insertPlace } from "@/test/consolidation";
import { insertTestSubdivision, insertTestTile } from "@/test/text";
import { tileIdFor } from "@/lib/domain/tiles";
import { decideAccess } from "@/lib/security/access";
import { testDb, withRollback } from "@/test/db";
import { testReaderDb } from "@/test/reader";

/*
 * `/api/mcp` (plan 2026-10-26-periplus-mcp), called directly with the test transaction as database: the protocol
 * (initialize, tools/list, tools/call), the token checks, the browser guard, the methods and the rate limit.
 */

let db: Db = testDb();

vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  connection: async () => {},
}));
vi.mock("@/lib/db/client", async (importActual) => ({
  ...(await importActual<typeof import("@/lib/db/client")>()),
  getDb: () => db,
}));
vi.mock("@/lib/db/reader", async (importActual) => ({
  ...(await importActual<typeof import("@/lib/db/reader")>()),
  getReaderDb: () => testReaderDb(),
}));

const route = await import("../api/mcp/route");
const { setMcpLimiter } = await import("@/lib/mcp/handler");

afterEach(() => setMcpLimiter(null));

const HEADERS = { "content-type": "application/json", accept: "application/json, text/event-stream" };

const rpc = (token: string | null, method: string, params: object = {}, extra: Record<string, string> = {}) =>
  route.POST(
    new Request("http://localhost/api/mcp", {
      method: "POST",
      headers: { ...HEADERS, ...(token ? { authorization: `Bearer ${token}` } : {}), ...extra },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    }),
  );

const INIT = { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } };

async function tokenFor(tx: Db): Promise<{ userId: string; id: string; token: string }> {
  const [user] = await tx.insert(users).values({ email: `${newId()}@test.invalid`, passwordHash: "x" }).returning({ id: users.id });
  const created = await createMcpToken(tx, { userId: user!.id, name: "test", validityDays: 30 });
  return { userId: user!.id, ...created };
}

const callTool = async (token: string, name: string, args: object = {}) => {
  const res = await rpc(token, "tools/call", { name, arguments: args });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { result: { content: Array<{ text: string }>; isError?: boolean } };
  return { isError: body.result.isError ?? false, text: body.result.content[0]!.text };
};

describe("/api/mcp", () => {
  it("initialize answers with the server's instructions and no-store", () =>
    withRollback(async (tx) => {
      db = tx;
      const { token } = await tokenFor(tx);
      const res = await rpc(token, "initialize", INIT);
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("no-store");
      const body = (await res.json()) as { result: { serverInfo: { name: string }; instructions: string } };
      expect(body.result.serverInfo.name).toBe("periplus");
      expect(body.result.instructions).toContain("nicht_vertrauenswuerdig");
    }));

  it("lists the read tools, each read only", () =>
    withRollback(async (tx) => {
      db = tx;
      const { token } = await tokenFor(tx);
      const res = await rpc(token, "tools/list");
      const body = (await res.json()) as { result: { tools: Array<{ name: string; annotations?: { readOnlyHint?: boolean } }> } };
      expect(body.result.tools.map((t) => t.name).sort()).toEqual(["checks", "costs", "deliveries", "gate_input", "overview", "place", "review_tasks", "runs", "sql", "version", "worker"]);
      expect(body.result.tools.every((t) => t.annotations?.readOnlyHint === true)).toBe(true);
    }));

  it("tools answer: overview, an unknown place as tool error, sql through the reader role", () =>
    withRollback(async (tx) => {
      db = tx;
      const { token } = await tokenFor(tx);
      const overview = await callTool(token, "overview");
      expect(overview.isError).toBe(false);
      expect(JSON.parse(overview.text)).toMatchObject({ subdivisions: expect.any(Array), costEur: expect.any(Object) });

      expect(await callTool(token, "place", { ref: `no such place ${newId()}` })).toEqual({ isError: true, text: "Kein Platz gefunden" });

      const version = await callTool(token, "version");
      expect(version.isError).toBe(false);
      expect(JSON.parse(version.text)).toMatchObject({ gitSha: null, configHash: expect.stringMatching(/^[0-9a-f]{16}$/), gateConfigHash: expect.stringMatching(/^[0-9a-f]{16}$/) });

      const sqlOk = JSON.parse((await callTool(token, "sql", { query: "select current_user as u" })).text);
      expect(sqlOk.nicht_vertrauenswuerdig.rows).toEqual([["periplus_mcp_reader"]]);
      const denied = await callTool(token, "sql", { query: "select * from users" });
      expect(denied.isError).toBe(true);
      expect(denied.text).toMatch(/permission denied/);
    }));

  it("the test run tools: gate_input, checks, review_tasks, worker", () =>
    withRollback(async (tx) => {
      db = tx;
      const { token } = await tokenFor(tx);
      const key = `XT-${newId().slice(0, 8)}`;
      const sub = await insertTestSubdivision(tx, key, [20.9, 35.0, 21.5, 35.5]);
      await insertTestTile(tx, tileIdFor(21.0, 35.2), null, sub.id);

      const gate = await callTool(token, "gate_input", { subdivision: key });
      expect(gate.isError).toBe(false);
      const gateBody = JSON.parse(gate.text);
      expect(gateBody.version).toMatchObject({ gitSha: null, gateConfigHash: expect.stringMatching(/^[0-9a-f]{16}$/) });
      expect(gateBody.input.nicht_vertrauenswuerdig.tiles.all).toEqual(expect.any(Array));
      expect(gate.text).not.toContain('"spots"');
      expect(await callTool(token, "gate_input", { subdivision: "XT-none" })).toEqual({ isError: true, text: "Landesteil XT-none unbekannt" });
      expect(await callTool(token, "checks", { subdivision: "XT-none" })).toEqual({ isError: true, text: "Landesteil XT-none unbekannt" });

      const checks = JSON.parse((await callTool(token, "checks", { subdivision: key })).text);
      expect(checks).toHaveProperty("gazetteer");
      expect(checks).toHaveProperty("geometry");

      const place = await insertPlace(tx, { name: "Zzyzx Cove", lon: 21.0, lat: 35.2, status: "candidate" });
      await syncConflictTasks(tx, [place.placeId], 2, [place.placeId]);
      const listed = JSON.parse((await callTool(token, "review_tasks", { kind: "research_conflict" })).text);
      expect(listed.counts.research_conflict).toBeGreaterThanOrEqual(1);
      const task = listed.tasks.nicht_vertrauenswuerdig.find((t: { subjectId: string }) => t.subjectId === place.placeId);
      expect(task).toBeTruthy();
      const detail = JSON.parse((await callTool(token, "review_tasks", { id: task.id })).text);
      expect(detail.adminPath).toBe(`/review/${task.id}`);
      expect(detail.detail.nicht_vertrauenswuerdig).toBeTruthy();
      expect((await callTool(token, "review_tasks", { id: newId() })).isError).toBe(true);

      const worker = JSON.parse((await callTool(token, "worker")).text);
      expect(worker.heartbeats).toEqual(expect.any(Array));
      expect(worker.queues).toBeTypeOf("object");
    }));

  it("no, a malformed, an unknown or a revoked token: one 401 with WWW-Authenticate; an API key is no MCP token", () =>
    withRollback(async (tx) => {
      db = tx;
      const { userId, id, token } = await tokenFor(tx);
      const { key } = await createApiClient(tx, { name: `mcp-${newId()}`, scopes: ["delivery:read"] });
      await revokeMcpToken(tx, userId, id);
      const bodies = new Set<string>();
      for (const t of [null, "garbage", `pmcp_${"A".repeat(43)}`, token, key]) {
        const res = await rpc(t, "initialize", INIT);
        expect(res.status).toBe(401);
        expect(res.headers.get("www-authenticate")).toBe('Bearer realm="periplus"');
        bodies.add(await res.text());
      }
      expect(bodies.size).toBe(1);
    }));

  it("a browser request (Origin header) is refused with 403", () =>
    withRollback(async (tx) => {
      db = tx;
      const { token } = await tokenFor(tx);
      expect((await rpc(token, "initialize", INIT, { origin: "https://evil.example" })).status).toBe(403);
    }));

  it("GET and DELETE answer 405 with Allow: POST", async () => {
    for (const res of [await route.GET(), await route.DELETE()]) {
      expect(res.status).toBe(405);
      expect(res.headers.get("allow")).toBe("POST");
    }
  });

  it("the rate limit answers 429 with Retry-After", () =>
    withRollback(async (tx) => {
      db = tx;
      const { token } = await tokenFor(tx);
      setMcpLimiter(async () => ({ ok: false, retryAfterMs: 2500 }));
      const res = await rpc(token, "initialize", INIT);
      expect(res.status).toBe(429);
      expect(res.headers.get("retry-after")).toBe("3");
    }));

  it("the access policy lets the MCP route through to its own checks, with or without a bearer", () => {
    expect(decideAccess({ pathname: "/api/mcp", session: null, hasBearer: false })).toEqual({ action: "allow" });
    expect(decideAccess({ pathname: "/api/mcp", session: null, hasBearer: true })).toEqual({ action: "allow" });
  });
});
