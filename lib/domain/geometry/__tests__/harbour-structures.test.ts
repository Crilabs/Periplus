import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { withRollback } from "@/test/db";
import { replaceHarbourStructures } from "../harbour-structures";

describe("replaceHarbourStructures", () => {
  it("an invalid closed way (a bow tie) is stored as a valid geometry", () =>
    withRollback(async (tx) => {
      const bowTie = [[19.37, 36.61], [19.372, 36.612], [19.372, 36.61], [19.37, 36.612], [19.37, 36.61]];
      await replaceHarbourStructures(tx, {
        box: [19.36, 36.6, 19.38, 36.62],
        datasetVersion: "test",
        structures: [{ osmId: "way/9001", manMade: "breakwater", geometry: { type: "Polygon", coordinates: [bowTie] } }],
      });
      const { rows } = await tx.execute<{ valid: boolean }>(sql`select ST_IsValid(geom) as valid from harbour_structures where osm_id = 'way/9001'`);
      expect(rows).toEqual([{ valid: true }]);
      // the hull of the harbour focus buffers it on the geography: must not throw
      await tx.execute(sql`select ST_Buffer(geom::geography, 25) from harbour_structures where osm_id = 'way/9001'`);
    }));
});
