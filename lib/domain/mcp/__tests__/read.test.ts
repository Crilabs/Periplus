import { describe, expect, it } from "vitest";
import { findPlaces, overview, readOnlySql, SQL_ROW_LIMIT, SqlRejected } from "@/lib/domain/mcp/read";
import { insertPlace } from "@/test/consolidation";
import { withRollback } from "@/test/db";
import { testReaderDb } from "@/test/reader";

describe("readOnlySql", () => {
  it("answers a select with columns and rows", async () => {
    const res = await readOnlySql(testReaderDb(), "select 1 as one, 'a' as letter");
    expect(res).toEqual({ columns: ["one", "letter"], rows: [[1, "a"]], rowCount: 1, truncated: false });
  });

  it("reads the domain tables", async () => {
    const res = await readOnlySql(testReaderDb(), "select count(*)::int as n from places");
    expect(res.columns).toEqual(["n"]);
  });

  it("never reads users, login attempts, API keys, MCP tokens or rate limits", async () => {
    for (const table of ["users", "login_attempts", "api_clients", "mcp_tokens", "rate_limits"]) {
      await expect(readOnlySql(testReaderDb(), `select * from ${table} limit 1`)).rejects.toThrow(/permission denied/);
    }
  });

  it("never writes: insert, update, delete, DDL and set role are refused", async () => {
    await expect(readOnlySql(testReaderDb(), "insert into queue_controls (queue) values ('x')")).rejects.toBeInstanceOf(SqlRejected);
    await expect(readOnlySql(testReaderDb(), "delete from places")).rejects.toBeInstanceOf(SqlRejected);
    await expect(readOnlySql(testReaderDb(), "create table mcp_probe (id int)")).rejects.toBeInstanceOf(SqlRejected);
    await expect(readOnlySql(testReaderDb(), "select 1; delete from places")).rejects.toBeInstanceOf(SqlRejected);
  });

  it("runs as the reader itself and cannot become another role, not even within one statement", async () => {
    expect((await readOnlySql(testReaderDb(), "select current_user as u, session_user as s")).rows[0]).toEqual(["periplus_mcp_reader", "periplus_mcp_reader"]);
    await expect(readOnlySql(testReaderDb(), "set role periplus")).rejects.toBeInstanceOf(SqlRejected);
    await expect(
      readOnlySql(testReaderDb(), "select set_config('role', (select rolname from pg_roles where rolsuper limit 1), true), (select count(*) from users)"),
    ).rejects.toBeInstanceOf(SqlRejected);
  });

  it("caps the returned rows", async () => {
    const res = await readOnlySql(testReaderDb(), `select g from generate_series(1, ${SQL_ROW_LIMIT + 5}) g`);
    expect(res.rows).toHaveLength(SQL_ROW_LIMIT);
    expect(res).toMatchObject({ rowCount: SQL_ROW_LIMIT + 5, truncated: true });
  });

  it("an empty query is refused", async () => {
    await expect(readOnlySql(testReaderDb(), "  ;")).rejects.toBeInstanceOf(SqlRejected);
  });
});

describe("overview", () => {
  it("returns subdivisions, runs, open review tasks, failed jobs and costs", () =>
    withRollback(async (tx) => {
      const o = await overview(tx);
      expect(o).toMatchObject({ subdivisions: expect.any(Array), runs: expect.any(Array), openReviewTasks: expect.any(Object), failedJobsLast24h: expect.any(Number) });
      expect(o.costEur).toEqual({ today: expect.any(Number), last7Days: expect.any(Number) });
    }));
});

describe("findPlaces", () => {
  it("finds a place by id, public id and name; an empty term finds nothing", () =>
    withRollback(async (tx) => {
      const { placeId, objectId } = await insertPlace(tx, { name: "Ormos Vathy", lon: 23.5, lat: 37.7, status: "confirmed" });
      const byId = await findPlaces(tx, placeId);
      expect(byId).toEqual([expect.objectContaining({ placeId, geoObjectId: objectId, status: "confirmed", name: "Ormos Vathy" })]);
      expect((await findPlaces(tx, "vathy")).map((p) => p.placeId)).toContain(placeId);
      expect(await findPlaces(tx, "  ")).toEqual([]);
    }));
});
