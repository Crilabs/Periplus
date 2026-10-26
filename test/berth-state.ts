import type { Db } from "@/lib/db/client";
import { berthStates } from "@/lib/db/schema";
import type { BerthStateNearby } from "@/lib/db/schema/research-state";

/**
 * A berth state of the place with the given core values (value only; confidence 0.8, origin `computed`, no facts)
 * and nearby objects. Replaces an existing row of the place.
 */
export async function insertBerthState(
  db: Db,
  placeId: string,
  core: Record<string, unknown> = {},
  nearby: BerthStateNearby[] = [],
): Promise<void> {
  const values = {
    placeId,
    core: Object.fromEntries(Object.entries(core).map(([k, value]) => [k, { value, confidence: 0.8, origin: "computed" as const, observedAt: null, factIds: [] }])),
    gaps: [],
    facts: [],
    landing: [],
    nearby,
  };
  await db.insert(berthStates).values(values).onConflictDoUpdate({ target: berthStates.placeId, set: values });
}
