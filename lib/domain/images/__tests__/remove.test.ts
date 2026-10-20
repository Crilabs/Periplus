import { and, eq, isNull } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { placeImages } from "@/lib/db/schema";
import { endPlaceImage, PlaceImageNotRemovable } from "@/lib/domain/images/remove";
import { newId } from "@/lib/domain/ids";
import { sql } from "drizzle-orm";
import { withRollback } from "@/test/db";
import { insertImageSubdivision, insertSpot } from "@/test/images";

async function image(tx: Parameters<typeof endPlaceImage>[0], geoObjectId: string, slot = "title") {
  const id = newId();
  await tx.execute(sql`
    insert into place_images (id, geo_object_id, kind, slot, file_key, width, height, alt, generation_key, camera_position, camera_height_m, view_bearing_deg, camera_tilt_deg, camera_fov_deg)
    values (${id}, ${geoObjectId}, 'ai_illustration', ${slot}, ${`images/places/${geoObjectId}/${id}.jpg`}, 10, 10, 'KI-Illustration: x', ${`g-${id}`}, ST_SetSRID(ST_MakePoint(19.37, 36.6), 4326), 260, 0, 30, 50)`);
  return id;
}

describe("endPlaceImage", () => {
  it("ends the row via valid_to, keeps it, and refuses a second removal", () =>
    withRollback(async (tx) => {
      const sd = await insertImageSubdivision(tx);
      const spot = await insertSpot(tx, sd.id);
      const id = await image(tx, spot.objectId);
      const other = await image(tx, spot.objectId, "view-2");
      await endPlaceImage(tx, { placeId: spot.placeId, imageId: id, now: new Date("2026-10-21T10:00:00Z") });
      const [row] = await tx.select({ validTo: placeImages.validTo }).from(placeImages).where(eq(placeImages.id, id));
      expect(row!.validTo).toBe("2026-10-21");
      const current = await tx.select({ id: placeImages.id }).from(placeImages).where(and(eq(placeImages.geoObjectId, spot.objectId), isNull(placeImages.validTo)));
      expect(current.map((r) => r.id)).toEqual([other]);
      await expect(endPlaceImage(tx, { placeId: spot.placeId, imageId: id })).rejects.toBeInstanceOf(PlaceImageNotRemovable);
    }));

  it("refuses an image of another place", () =>
    withRollback(async (tx) => {
      const sd = await insertImageSubdivision(tx);
      const a = await insertSpot(tx, sd.id);
      const b = await insertSpot(tx, sd.id, { lon: 19.5 });
      const id = await image(tx, b.objectId);
      await expect(endPlaceImage(tx, { placeId: a.placeId, imageId: id })).rejects.toBeInstanceOf(PlaceImageNotRemovable);
    }));
});
