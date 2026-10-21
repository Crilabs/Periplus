import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { geomFromGeoJson } from "@/lib/db/geometry";
import type { Db } from "@/lib/db/client";
import { areaEvidence, areaMembers, geoNames, geoObjects } from "@/lib/db/schema";
import { withRollback } from "@/test/db";

/** drizzle wraps driver errors ("Failed query"); the Postgres message lives on `cause`. */
async function rejectionMessage(tx: Db, run: (tx: Db) => Promise<unknown>): Promise<string> {
  try {
    await tx.transaction(async (sp) => {
      await run(sp);
    });
  } catch (e) {
    const err = e as Error;
    return `${err.message} ${(err.cause as Error | undefined)?.message ?? ""}`;
  }
  throw new Error("expected promise to reject");
}

async function newArea(tx: Db, type: "area" | "harbour" = "area") {
  const [row] = await tx.insert(geoObjects).values({ type, origin: "import", geom: geomFromGeoJson({ type: "Point", coordinates: [23.5, 37.5] }) }).returning({ id: geoObjects.id });
  return row!.id;
}

async function newEvidence(tx: Db, areaId: string) {
  const [row] = await tx
    .insert(areaEvidence)
    .values({ areaId, url: "https://example.org/a", language: "de", quote: "Ein Zitat", fileGeneratedAt: "2026-10-20" })
    .returning({ id: areaEvidence.id });
  return row!.id;
}

describe("areas schema", () => {
  it("area_evidence rejects UPDATE of quote and DELETE", async () => {
    await withRollback(async (tx) => {
      const area = await newArea(tx);
      const id = await newEvidence(tx, area);
      const update = await rejectionMessage(tx, (sp) =>
        sp.update(areaEvidence).set({ quote: "anders" }).where(eq(areaEvidence.id, id)),
      );
      expect(update).toContain("area_evidence is append-only");
      const del = await rejectionMessage(tx, (sp) => sp.delete(areaEvidence).where(eq(areaEvidence.id, id)));
      expect(del).toContain("area_evidence is append-only");
    });
  });

  it("area_evidence allows moving area_id", async () => {
    await withRollback(async (tx) => {
      const a = await newArea(tx);
      const b = await newArea(tx);
      const id = await newEvidence(tx, a);
      await tx.update(areaEvidence).set({ areaId: b }).where(eq(areaEvidence.id, id));
      const [row] = await tx.select().from(areaEvidence).where(eq(areaEvidence.id, id));
      expect(row!.areaId).toBe(b);
    });
  });

  it("area_members delete allowed", async () => {
    await withRollback(async (tx) => {
      const area = await newArea(tx);
      const harbour = await newArea(tx, "harbour");
      await tx.insert(areaMembers).values({ areaId: area, geoObjectId: harbour, role: "member", name: "Chania" });
      await tx.delete(areaMembers).where(and(eq(areaMembers.areaId, area), eq(areaMembers.geoObjectId, harbour)));
      expect(await tx.select().from(areaMembers).where(eq(areaMembers.areaId, area))).toHaveLength(0);
    });
  });

  it("name origin import accepted", async () => {
    await withRollback(async (tx) => {
      const area = await newArea(tx);
      await tx.insert(geoNames).values({
        geoObjectId: area,
        name: "Kreta",
        nameNormalized: "kreta",
        language: "de",
        script: "latin",
        origin: "import",
      });
      const rows = await tx.select().from(geoNames).where(eq(geoNames.geoObjectId, area));
      expect(rows[0]!.origin).toBe("import");
    });
  });
});
