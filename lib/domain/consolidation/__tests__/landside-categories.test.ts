import { sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { getConsolidationConfig, loadConfig } from "@/lib/config";
import { loadContext, loadDerivedInputs, loadInputs } from "@/lib/domain/consolidation/inputs";
import { loadHighlightCandidates } from "@/lib/domain/highlights/candidates";
import { insertPlace } from "@/test/consolidation";
import { testDb, withRollback } from "@/test/db";
import { insertNamedObject } from "@/test/text";

/*
 * Landside POIs (bakery, transport, landing; plan N4a) feed the berth state only: they are never highlight candidates,
 * highlight inputs or importance inputs. Around 21.8° E / 35.8° N, assertions name the test's own POIs.
 */

const config = loadConfig("config");
const cfg = getConsolidationConfig();
const opts = { cfg, schemaVersion: "v2", appConfig: config, today: "" };
beforeAll(async () => {
  const { rows } = await testDb().execute<{ today: string }>(sql`select current_date::text as today`);
  opts.today = rows[0]!.today;
});

const LON = 21.8;
const LAT = 35.8;
const LON_PER_M = 1 / (111_320 * Math.cos((LAT * Math.PI) / 180));

describe("landside POI categories", () => {
  it.each(["bakery", "transport", "landing"] as const)("a %s POI is no highlight candidate, no highlight input and has no importance input", (category) =>
    withRollback(async (tx) => {
      const place = await insertPlace(tx, { lon: LON, lat: LAT });
      const taverna = await insertNamedObject(tx, { type: "poi", category: "food", names: [{ name: "Taverna Test" }], lon: LON + 300 * LON_PER_M, lat: LAT });
      const baseline = (await loadInputs(tx, place.objectId, opts)).ignored.unknownAttribute;
      const landside = await insertNamedObject(tx, { type: "poi", category, names: [{ name: "Landside Test" }], lon: LON + 310 * LON_PER_M, lat: LAT });

      const { candidates } = await loadHighlightCandidates(tx, place.objectId, cfg, opts.today);
      expect(candidates.map((c) => c.geoObjectId).filter((id) => [taverna, landside].includes(id))).toEqual([taverna]);

      const { inputs, ignored } = await loadInputs(tx, place.objectId, opts);
      // not even loaded as an input the schema then drops
      expect(ignored.unknownAttribute).toBe(baseline);
      expect(inputs.filter((i) => i.poiId === taverna || i.poiId === landside).map((i) => i.poiId)).toEqual([taverna]);

      const ctx = await loadContext(tx, landside, cfg, opts.today);
      expect(ctx).not.toBeNull();
      expect((await loadDerivedInputs(tx, landside, ctx!, opts)).importance).toBeNull();
      const tctx = await loadContext(tx, taverna, cfg, opts.today);
      expect((await loadDerivedInputs(tx, taverna, tctx!, opts)).importance).not.toBeNull();
    }));
});
