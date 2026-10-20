import { readFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import type { Db } from "@/lib/db/client";
import { withRollback } from "@/test/db";

/**
 * The run-book check and repair before migration 0048 (gesamt-review W3-M-1), run as written in docs/runbook.md
 * against a scene of temporary tables: `pg_temp` comes first in the search path, so the unqualified `geo_objects` and
 * `places` of the run-book SQL and of the migration resolve to them. The shared tables are never touched or locked.
 */
const runbook = readFileSync("docs/runbook.md", "utf8");
const block = (marker: string) => {
  const m = new RegExp(`-- ${marker}\\n([\\s\\S]*?)\\nSQL\\n`).exec(runbook);
  if (!m) throw new Error(`run-book block ${marker} not found`);
  return m[1]!;
};
const migration0048 = readFileSync("drizzle/0048_public_id_prefix_checks.sql", "utf8").split("--> statement-breakpoint");

async function scene(tx: Db): Promise<Record<string, string>> {
  await tx.execute(sql`create temp table geo_objects (like public.geo_objects including defaults) on commit drop`);
  await tx.execute(sql`create temp table places (like public.places including defaults) on commit drop`);
  const rows: Array<[string, string, string | null]> = [
    ["poiToIsland", "island", "hl_01JABCDEFGHJKMNPQRSTVWXYZ0"],
    ["poiToCape", "cape", "hl_01JABCDEFGHJKMNPQRSTVWXYZ1"],
    ["areaWrong", "area", "rg_01JABCDEFGHJKMNPQRSTVWXYZ2"],
    ["island", "island", "rg_01JABCDEFGHJKMNPQRSTVWXYZ3"],
    ["poi", "poi", "hl_01JABCDEFGHJKMNPQRSTVWXYZ4"],
    ["cape", "cape", null],
  ];
  const ids: Record<string, string> = {};
  for (const [label, type, publicId] of rows) {
    const { rows: r } = await tx.execute<{ id: string }>(sql`
      insert into geo_objects (id, type, origin, geom, public_id)
      values (gen_random_uuid(), ${type}::geo_object_type, 'osm', ST_SetSRID(ST_MakePoint(0, 0), 4326), ${publicId})
      returning id`);
    ids[label] = r[0]!.id;
  }
  const { rows: p } = await tx.execute<{ id: string }>(sql`
    insert into places (id, geo_object_id, kind, position, public_id)
    values (gen_random_uuid(), ${ids.island}, 'anchorage', ST_SetSRID(ST_MakePoint(0, 0), 4326), 'xx_01JABCDEFGHJKMNPQRSTVWXYZ5'),
           (gen_random_uuid(), ${ids.island}, 'anchorage', ST_SetSRID(ST_MakePoint(0, 0), 4326), 'sp_01JABCDEFGHJKMNPQRSTVWXYZ6')
    returning id`);
  ids.badPlace = p[0]!.id;
  return ids;
}

async function check(tx: Db) {
  const { rows } = await tx.execute<{ tbl: string; id: string }>(sql.raw(block("0048-check")));
  return rows.map((r) => `${r.tbl}:${r.id}`).sort();
}

describe("run-book check and repair before migration 0048 (W3-M-1)", () => {
  it("lists exactly the rows 0048 refuses, and after the repair the migration applies", () =>
    withRollback(async (tx) => {
      const ids = await scene(tx);
      expect(await check(tx)).toEqual(
        [`geo_objects:${ids.poiToIsland}`, `geo_objects:${ids.poiToCape}`, `geo_objects:${ids.areaWrong}`, `places:${ids.badPlace}`].sort(),
      );
      // the scene reproduces the failure: 0048 refuses it
      await expect(tx.transaction(async (sp) => sp.execute(sql.raw(migration0048[0]!)))).rejects.toThrow();

      await tx.execute(sql.raw(block("0048-repair")));
      expect(await check(tx)).toEqual([`places:${ids.badPlace}`]);
      const { rows } = await tx.execute<{ id: string; public_id: string | null }>(sql`select id, public_id from geo_objects`);
      const byId = new Map(rows.map((r) => [r.id, r.public_id]));
      expect([ids.poiToIsland, ids.poiToCape, ids.areaWrong].map((id) => byId.get(id))).toEqual([null, null, null]);
      expect(byId.get(ids.island)).toBe("rg_01JABCDEFGHJKMNPQRSTVWXYZ3");
      expect(byId.get(ids.poi)).toBe("hl_01JABCDEFGHJKMNPQRSTVWXYZ4");

      // a place is never repaired by the run book; without it both statements of 0048 apply
      await tx.execute(sql`delete from places where id = ${ids.badPlace}`);
      for (const statement of migration0048) await tx.execute(sql.raw(statement));
      expect(await check(tx)).toEqual([]);
    }));
});
