import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { geomFromGeoJson } from "@/lib/db/geometry";
import { imageryTiles, placeImages, placeRenders, reviewTasks } from "@/lib/db/schema";
import type { Db } from "@/lib/db/client";
import { createReviewTask } from "@/lib/domain/review";
import { withRollback } from "@/test/db";
import { insertTestGeoObject, insertTestRun } from "@/test/text";

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

// Synthetic geometry outside the pilot box (23.0-23.75 E x 37.0-38.0 N), rolled back.
const bbox = geomFromGeoJson({
  type: "Polygon",
  coordinates: [[[21.0, 35.0], [21.1, 35.0], [21.1, 35.1], [21.0, 35.1], [21.0, 35.0]]],
});

async function insertTile(tx: Db, patch: Partial<typeof imageryTiles.$inferInsert> = {}) {
  const [row] = await tx
    .insert(imageryTiles)
    .values({
      source: "ktimatologio",
      tileKey: "t1",
      bbox,
      resolutionM: 0.5,
      license: "test",
      attribution: "test",
      fileKey: "imagery/t1.jpg",
      bytes: 10,
      ...patch,
    })
    .returning();
  return row!;
}

async function insertRender(tx: Db, geoObjectId: string) {
  const runId = await insertTestRun(tx);
  const [row] = await tx
    .insert(placeRenders)
    .values({
      geoObjectId,
      camera: { azimuth: 90 },
      zoom: "z2",
      imageryTileIds: [],
      demTileIds: [],
      photoKey: "renders/p.png",
      maskKey: "renders/m.png",
      rendererVersion: "1",
      generationKey: "g1",
      runId,
    })
    .returning();
  return row!;
}

async function insertImage(tx: Db, geoObjectId: string, renderId: string, patch: Partial<typeof placeImages.$inferInsert> = {}) {
  const [row] = await tx
    .insert(placeImages)
    .values({
      geoObjectId,
      kind: "ai_illustration",
      renderId,
      light: "midday",
      model: "m",
      promptVersion: "1",
      waterIou: 0.9,
      fileKey: "images/i.jpg",
      alt: "KI-Illustration: Bucht",
      width: 1536,
      height: 1024,
      generationKey: "g1",
      ...patch,
    })
    .returning();
  return row!;
}

describe("images schema", () => {
  it("place_renders is append-only", async () => {
    await withRollback(async (tx) => {
      const render = await insertRender(tx, await insertTestGeoObject(tx));
      const msg = await rejectionMessage(tx, (d) => d.update(placeRenders).set({ zoom: "z3" }).where(eq(placeRenders.id, render.id)));
      expect(msg).toContain("is append-only");
      const del = await rejectionMessage(tx, (d) => d.delete(placeRenders).where(eq(placeRenders.id, render.id)));
      expect(del).toContain("is append-only");
    });
  });

  it("imagery_tiles and place_images refuse delete", async () => {
    await withRollback(async (tx) => {
      const geo = await insertTestGeoObject(tx);
      const tile = await insertTile(tx);
      const image = await insertImage(tx, geo, (await insertRender(tx, geo)).id);
      expect(await rejectionMessage(tx, (d) => d.delete(imageryTiles).where(eq(imageryTiles.id, tile.id)))).toContain("rows are never deleted");
      expect(await rejectionMessage(tx, (d) => d.delete(placeImages).where(eq(placeImages.id, image.id)))).toContain("rows are never deleted");
      expect(await rejectionMessage(tx, (d) => d.execute(sql`truncate imagery_tiles`))).toBeTruthy();
    });
  });

  it("records history of ending a tile and an image", async () => {
    await withRollback(async (tx) => {
      const geo = await insertTestGeoObject(tx);
      const tile = await insertTile(tx);
      const image = await insertImage(tx, geo, (await insertRender(tx, geo)).id);
      await tx.update(imageryTiles).set({ validTo: sql`current_date` }).where(eq(imageryTiles.id, tile.id));
      await tx.update(placeImages).set({ validTo: sql`current_date` }).where(eq(placeImages.id, image.id));
      const t = await tx.execute(sql`select count(*)::int as n from imagery_tiles_history where row_id = ${tile.id}`);
      const i = await tx.execute(sql`select count(*)::int as n from place_images_history where row_id = ${image.id}`);
      expect(t.rows[0]).toEqual({ n: 1 });
      expect(i.rows[0]).toEqual({ n: 1 });
    });
  });

  it("one current tile per source and key", async () => {
    await withRollback(async (tx) => {
      const first = await insertTile(tx);
      expect(await rejectionMessage(tx, (d) => insertTile(d))).toContain("imagery_tiles_source_key_valid_unique");
      await tx.update(imageryTiles).set({ validTo: sql`current_date` }).where(eq(imageryTiles.id, first.id));
      await insertTile(tx);
    });
  });

  it("one current image per object and kind", async () => {
    await withRollback(async (tx) => {
      const geo = await insertTestGeoObject(tx);
      const render = await insertRender(tx, geo);
      const first = await insertImage(tx, geo, render.id);
      expect(await rejectionMessage(tx, (d) => insertImage(d, geo, render.id))).toContain("place_images_current_unique");
      await tx.update(placeImages).set({ validTo: sql`current_date` }).where(eq(placeImages.id, first.id));
      await insertImage(tx, geo, render.id);
    });
  });

  it("review kind place_image exists", async () => {
    await withRollback(async (tx) => {
      const { id, created } = await createReviewTask(tx, {
        kind: "place_image",
        subjectType: "place_image",
        subjectId: "x",
        context: {},
      });
      expect(created).toBe(true);
      const [row] = await tx.select({ kind: reviewTasks.kind }).from(reviewTasks).where(eq(reviewTasks.id, id));
      expect(row?.kind).toBe("place_image");
    });
  });
});
