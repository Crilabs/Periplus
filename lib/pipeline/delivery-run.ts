import { and, eq, isNotNull } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import type { Db } from "@/lib/db/client";
import { geoObjects } from "@/lib/db/schema";
import { validAt } from "@/lib/domain/timeline";
import { DELIVERY_STAGE } from "@/lib/pipeline/delivery";
import { startRun } from "@/lib/pipeline/runs";
import { RunScopeNotReady } from "@/lib/pipeline/tile-scope";

// Kept apart from ./delivery: the job handler imports that module, and this one reaches the stage registry through
// ./runs, which would close an import cycle through the handler (ruling M6-P17).

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Starts the run "Paket bauen" for one area (scope `area` with the area's key, as other area runs), stage
 * `delivery.build`. Checked before the run exists: the id is a valid area geo object with a public id; anything else
 * throws `RunScopeNotReady` (`area_without_geo_object`).
 */
export async function startDeliveryRun(
  db: Db,
  boss: PgBoss,
  input: { areaGeoObjectId: string; triggeredBy: string },
): Promise<{ id: string }> {
  const [area] = UUID.test(input.areaGeoObjectId)
    ? await db
        .select({ configKey: geoObjects.configKey, publicId: geoObjects.publicId })
        .from(geoObjects)
        .where(and(eq(geoObjects.id, input.areaGeoObjectId), eq(geoObjects.type, "area"), isNotNull(geoObjects.publicId), validAt(geoObjects)))
    : [];
  if (!area) {
    throw new RunScopeNotReady("area_without_geo_object", `${input.areaGeoObjectId} is no valid area with a public id`);
  }
  const areaKey = area.configKey ?? area.publicId!;
  return startRun(db, boss, {
    kind: "stage",
    scope: { type: "area", id: areaKey },
    stages: [DELIVERY_STAGE],
    params: { areaId: input.areaGeoObjectId, areaKey },
    triggeredBy: input.triggeredBy,
  });
}
