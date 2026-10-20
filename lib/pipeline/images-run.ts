import { sql } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import type { Db } from "@/lib/db/client";
import { requireSubdivision } from "@/lib/domain/subdivisions/store";
import type { ImageView } from "@/lib/pipeline/images/generate";
import type { ImageRunScope } from "@/lib/pipeline/images/stage";
import { IMAGES_STAGE } from "@/lib/pipeline/images/stage-name";
import { startRun } from "@/lib/pipeline/runs";
import { RunScopeNotReady } from "@/lib/pipeline/tile-scope";

// Kept apart from ./images: the job handler imports those modules, and this one reaches the stage registry through
// ./runs, which would close an import cycle through the handler (pattern of delivery-run.ts).

export { nextViewSlot } from "@/lib/pipeline/images/stage";

/**
 * Starts an image run (kind `stage`, only stage `images.place`): the title images of a subdivision's spots (scope
 * `subdivision`; an unknown or excluded key is refused by `requireSubdivision`), or one view of one place (scope
 * `place` with its current place id; an additional view takes the slot from `nextViewSlot`). A geo object without a
 * current place throws `RunScopeNotReady` (`place_not_computable`). The plan skips images whose generation key is done.
 */
export async function startImageRun(
  db: Db,
  boss: PgBoss,
  input: { subdivisionKey: string } | { geoObjectId: string; view: ImageView },
  triggeredBy: string,
): Promise<{ id: string }> {
  let scope: { type: "subdivision" | "place"; id: string };
  let images: ImageRunScope;
  if ("subdivisionKey" in input) {
    await requireSubdivision(db, input.subdivisionKey);
    scope = { type: "subdivision", id: input.subdivisionKey };
    images = { subdivisionKey: input.subdivisionKey };
  } else {
    const { rows } = await db.execute<{ id: string }>(sql`
      select id from places
      where geo_object_id = ${input.geoObjectId} and valid_to is null and merged_into_id is null
      order by created_at desc limit 1`);
    if (!rows[0]) throw new RunScopeNotReady("place_not_computable", `geo object ${input.geoObjectId} has no current place`);
    scope = { type: "place", id: rows[0].id };
    images = { geoObjectId: input.geoObjectId, view: input.view };
  }
  return startRun(db, boss, { kind: "stage", scope, stages: [IMAGES_STAGE], params: { images }, triggeredBy });
}
