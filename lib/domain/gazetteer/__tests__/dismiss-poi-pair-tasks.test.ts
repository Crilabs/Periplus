import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { reviewTasks } from "@/lib/db/schema";
import { openPairTask } from "@/lib/domain/gazetteer/merge";
import { upsertGeoObject } from "@/lib/domain/gazetteer/store";
import { withRollback } from "@/test/db";
import { pairTasksOf } from "@/test/gazetteer";

// Synthetic points outside the pilot box 23.0-23.75 E x 37.0-38.0 N.
describe("migration 0063_dismiss_poi_pair_tasks", () => {
  it("dismisses an open pair task between two POIs and leaves a bay pair task open", () =>
    withRollback(async (db) => {
      const make = async (type: "poi" | "bay", n: number) => {
        const r = await upsertGeoObject(db, {
          type,
          ...(type === "poi" ? { category: "culture" as const } : {}),
          origin: "osm",
          osmId: `node/${9_160_000_000 + n}`,
          geometry: { type: "Point", coordinates: [41 + n / 1000, 11] },
          names: [{ name: `Name ${n}`, language: "en", origin: "osm" }],
        });
        if ("skipped" in r) throw new Error(r.skipped);
        return r.id;
      };
      const [p1, p2, b1, b2] = [await make("poi", 1), await make("poi", 2), await make("bay", 3), await make("bay", 4)];
      const ctx = { similarity: 0.8, distanceM: 100, source: "wikidata" as const };
      await openPairTask(db, p1!, p2!, ctx);
      await openPairTask(db, b1!, b2!, ctx);

      await db.execute(sql.raw(readFileSync(join(process.cwd(), "drizzle/0063_dismiss_poi_pair_tasks.sql"), "utf8")));

      const status = async (a: string, b: string) => {
        const [t] = await pairTasksOf(db, [a, b]);
        const [row] = await db.select().from(reviewTasks).where(sql`${reviewTasks.id} = ${t!.id}`);
        return row!;
      };
      const poi = await status(p1!, p2!);
      expect(poi.status).toBe("dismissed");
      expect(poi.context).toMatchObject({ dismissedReason: "superseded" });
      expect((await status(b1!, b2!)).status).toBe("open");
    }));
});
