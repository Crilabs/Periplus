import { inArray } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import { places } from "@/lib/db/schema";
import { latestProfiles } from "@/lib/domain/timeline";
import { lonLatOf, loadComparisonSubjects, type ComparisonSubject } from "./comparison-values";

/*
 * The comparison subjects as the old, profile-based quality measurements (metrics, regression) read them: the
 * attributes, position, anchor and version of the newest profile. Only the old measurements use this; the Navily page
 * and the gate read berth states (`loadComparisonSubjects`). Removed with them (plan N6 Task 4).
 */
export async function loadProfileSubjects(db: Db, subdivisionKey: string): Promise<ComparisonSubject[]> {
  const subjects = await loadComparisonSubjects(db, subdivisionKey);
  if (subjects.length === 0) return [];
  const objects = await db
    .select({ id: places.id, geoObjectId: places.geoObjectId })
    .from(places)
    .where(inArray(places.id, subjects.map((s) => s.placeId)));
  const objectOf = new Map(objects.map((o) => [o.id, o.geoObjectId]));
  const profiles = await latestProfiles(db, objects.map((o) => o.geoObjectId));
  return subjects.map((s) => {
    const profile = profiles.get(objectOf.get(s.placeId)!);
    const attributes = profile?.attributes ?? {};
    return {
      ...s,
      position: lonLatOf(attributes["place.position"]) ?? s.position,
      anchorPosition: lonLatOf(attributes["anchor_position"]),
      attributes,
      profileVersion: profile?.version ?? null,
    };
  });
}
