import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import type { Db } from "@/lib/db/client";
import { geomFromGeoJson } from "@/lib/db/geometry";
import { areaEvidence, areaMembers, geoNames, geoObjects, tileGeoObjects, tiles } from "@/lib/db/schema";
import { areaDetail } from "@/lib/domain/areas/view";
import { tileBbox, tileIdFor } from "@/lib/domain/tiles";
import { withRollback } from "@/test/db";
import { insertTestSubdivision } from "@/test/text";

// Open sea outside the pilot box 23.0-23.75 E x 37.0-38.0 N, at a spot no other test uses.
const LON = 28.37;
const LAT = 31.37;
const square = (lon: number, lat: number, size: number): GeoJSON.Polygon => ({
  type: "Polygon",
  coordinates: [[[lon, lat], [lon + size, lat], [lon + size, lat + size], [lon, lat + size], [lon, lat]]],
});

async function insertObject(tx: Db, type: "area" | "harbour" | "bay", name: string, extra: { configKey?: string; tags?: Record<string, unknown>; validTo?: string } = {}) {
  const [row] = await tx
    .insert(geoObjects)
    .values({ type, origin: type === "area" ? "import" : "manual", geom: sql`${geomFromGeoJson(square(LON, LAT, 0.05))}`, publicId: type === "area" ? `ar_${name.slice(0, 6)}${Math.random().toString(36).slice(2, 8)}` : undefined, ...extra })
    .returning({ id: geoObjects.id });
  await tx.insert(geoNames).values({ geoObjectId: row!.id, name, nameNormalized: name.toLowerCase(), language: "de", script: "latin", origin: "manual", isPreferred: true });
  return row!.id;
}

describe("areaDetail", () => {
  it("areaDetail returns resolved and unresolved members, related with ids, evidence", () =>
    withRollback(async (tx) => {
      const sub = await insertTestSubdivision(tx, "XT-AREAVIEW", [LON - 0.5, LAT - 0.5, LON + 0.5, LAT + 0.5], { country: "XT" });
      const other = await insertObject(tx, "area", "Nachbarrevier", { configKey: "xt-neighbour" });
      const id = await insertObject(tx, "area", "Testrevier", {
        configKey: "xt-test",
        tags: {
          boundary: "Von A nach B",
          notes: "Nur im Sommer",
          polygonOrigin: "hull",
          importCountry: "XT",
          unresolvedMembers: [{ name: "Geisterhafen", type: "harbour", role: "member" }],
          related: [{ key: "xt-neighbour", relation: "overlaps" }, { key: "xt-missing", relation: "within" }],
        },
      });
      await tx.insert(geoNames).values({ geoObjectId: id, name: "Test Area", nameNormalized: "test area", language: "en", script: "latin", origin: "import", isPreferred: false });
      await tx.insert(geoNames).values({ geoObjectId: id, name: "Altname", nameNormalized: "altname", language: "de", script: "latin", origin: "import", validTo: "2020-01-01" });
      const harbour = await insertObject(tx, "harbour", "Testhafen");
      await tx.insert(areaMembers).values({ areaId: id, geoObjectId: harbour, role: "member", name: "Test Harbour" });
      await tx.insert(areaEvidence).values({ areaId: id, url: "https://example.invalid/a", publisher: "Seglerblatt", language: "de", quote: "Ein wörtliches Zitat.", fileGeneratedAt: "2026-10-20" });
      const tileId = tileIdFor(LON, LAT);
      const [w, s] = tileBbox(tileId);
      await tx.insert(tiles).values({ id: tileId, bbox: sql`${geomFromGeoJson(square(w, s, 0.25))}`, subdivisionId: sub.id, hasCoast: true });
      await tx.insert(tileGeoObjects).values({ tileId, geoObjectId: id });

      const detail = await areaDetail(tx, id);
      expect(detail).toEqual({
        id,
        publicId: expect.stringMatching(/^ar_/),
        key: "xt-test",
        names: [
          { name: "Testrevier", language: "de", isPreferred: true },
          { name: "Test Area", language: "en", isPreferred: false },
        ],
        members: [{ id: harbour, name: "Testhafen", type: "harbour", role: "member" }],
        unresolvedMembers: [{ name: "Geisterhafen", type: "harbour", role: "member" }],
        boundary: "Von A nach B",
        related: [
          { key: "xt-neighbour", relation: "overlaps", id: other, name: "Nachbarrevier" },
          { key: "xt-missing", relation: "within", id: null, name: null },
        ],
        evidence: [{ url: "https://example.invalid/a", publisher: "Seglerblatt", language: "de", quote: "Ein wörtliches Zitat." }],
        notes: "Nur im Sommer",
        polygonOrigin: "hull",
        subdivisions: [{ key: "XT-AREAVIEW", name: "XT-AREAVIEW" }],
        importedFrom: "XT",
      });
    }));

  it("ended area has no detail", () =>
    withRollback(async (tx) => {
      const id = await insertObject(tx, "area", "Altrevier", { configKey: "xt-old", validTo: "2020-01-01" });
      expect(await areaDetail(tx, id)).toBeNull();
      expect(await areaDetail(tx, "00000000-0000-0000-0000-000000000000")).toBeNull();
    }));
});
