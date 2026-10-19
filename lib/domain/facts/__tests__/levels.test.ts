import { describe, expect, it } from "vitest";
import { geomFromGeoJson } from "@/lib/db/geometry";
import { places } from "@/lib/db/schema";
import type { Db } from "@/lib/db/client";
import { withRollback } from "@/test/db";
import { insertTestGeoObject } from "@/test/text";
import { levelFor } from "../levels";

// Synthetic data at 21.0° E / 35.2° N, outside the pilot box; everything rolled back.
const POINT = { type: "Point" as const, coordinates: [21.0, 35.2] };

async function insertPlace(tx: Db, geoObjectId: string, status: "confirmed" | "candidate" | "rejected") {
  await tx.insert(places).values({ geoObjectId, kind: "anchorage", status, position: geomFromGeoJson(POINT) });
}

describe("levelFor", () => {
  it("a bay with a confirmed place is level place, a settlement without place none, an islet island", async () => {
    await withRollback(async (tx) => {
      const bay = await insertTestGeoObject(tx, { type: "bay" });
      await insertPlace(tx, bay, "confirmed");
      expect(await levelFor(tx, bay)).toBe("place");

      expect(await levelFor(tx, await insertTestGeoObject(tx, { type: "settlement" }))).toBeNull();
      expect(await levelFor(tx, await insertTestGeoObject(tx, { type: "islet" }))).toBe("island");
    });
  });

  it("a settlement with a candidate place is level place, with a rejected one none", async () => {
    await withRollback(async (tx) => {
      const candidate = await insertTestGeoObject(tx, { type: "settlement" });
      await insertPlace(tx, candidate, "candidate");
      expect(await levelFor(tx, candidate)).toBe("place");

      const rejected = await insertTestGeoObject(tx, { type: "settlement" });
      await insertPlace(tx, rejected, "rejected");
      expect(await levelFor(tx, rejected)).toBeNull();
    });
  });

  it("maps the other types without a place", async () => {
    await withRollback(async (tx) => {
      const cases = [
        ["sea", "area"],
        ["area", "area"],
        ["gulf", "area"],
        ["island", "island"],
        ["archipelago", "island"],
        ["coast_section", "island"],
        ["cape", "cape_strait"],
        ["strait", "cape_strait"],
        ["channel", "cape_strait"],
        ["poi", "poi"],
        ["bay", "place"],
        ["harbour", "place"],
      ] as const;
      for (const [type, level] of cases) {
        expect(await levelFor(tx, await insertTestGeoObject(tx, { type })), type).toBe(level);
      }
      expect(await levelFor(tx, "0199f0a4-1b2c-7d3e-8f40-123456789abc")).toBeNull();
    });
  });
});
