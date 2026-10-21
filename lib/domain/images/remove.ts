import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import { placeImages, places } from "@/lib/db/schema";

/** „Bild entfernen“ was refused: the image is not a current image of the place (unknown, of another place, or already ended). */
export class PlaceImageNotRemovable extends Error {
  constructor(readonly imageId: string) {
    super(`place image ${imageId} is not a current image of the place`);
  }
}

/**
 * „Bild entfernen“: ends the place's current image `imageId` (`valid_to` = today; the row stays, place_images is stable)
 * so it drops out of the next package. Only a current row of that place (any kind); an unknown, a
 * foreign or an already ended row (the page was stale) throws `PlaceImageNotRemovable`.
 */
export async function endPlaceImage(db: Db, input: { placeId: string; imageId: string; now?: Date }): Promise<void> {
  const today = (input.now ?? new Date()).toISOString().slice(0, 10);
  const [place] = await db.select({ geoObjectId: places.geoObjectId }).from(places).where(eq(places.id, input.placeId));
  if (!place) throw new PlaceImageNotRemovable(input.imageId);
  const ended = await db
    .update(placeImages)
    .set({ validTo: today })
    .where(
      and(
        eq(placeImages.id, input.imageId),
        eq(placeImages.geoObjectId, place.geoObjectId),
        isNull(placeImages.validTo),
      ),
    )
    .returning({ id: placeImages.id });
  if (ended.length === 0) throw new PlaceImageNotRemovable(input.imageId);
}
