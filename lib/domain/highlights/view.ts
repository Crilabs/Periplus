import { sql } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import { HIGHLIGHT_CATEGORIES, type HighlightCategory } from "@/lib/db/schema";
import { POI_CATEGORY_LABELS } from "@/lib/domain/facts/labels";
import { displayNameSql } from "@/lib/domain/gazetteer/names";
import { latestProfile } from "@/lib/domain/timeline";
import type { HighlightLevel } from "./select";
import type { HighlightsValue } from "./selections";

/*
 * The highlights of a place for the admin page (spec 16): the newest profile's attribute `derived.highlights`
 * (ids in rank order, level) with the candidate data of its provenance (`derivedFrom`).
 */

export const HIGHLIGHT_LEVEL_LABELS: Record<HighlightLevel, string> = { none: "nur das", some: "einiges mehr", many: "sehr viel mehr" };

export type PlaceHighlights = {
  category: HighlightCategory;
  label: string;
  level: HighlightLevel;
  levelLabel: string;
  highlights: Array<{ geoObjectId: string; name: string | null; importance: number; distanceKm: number }>;
  /** Candidates in reach beyond the selected ones. */
  others: number;
};

type StoredCandidate = { geoObjectId: string; importance: number; distanceKm: number };

/** The categories of the place's highlights in label order; empty without a profile or the attribute. */
export async function placeHighlightsView(db: Db, placeGeoObjectId: string): Promise<PlaceHighlights[]> {
  const profile = await latestProfile(db, placeGeoObjectId);
  const value = profile?.attributes["derived.highlights"] as HighlightsValue | undefined;
  if (!value) return [];
  const derivedFrom = (profile!.provenance["derived.highlights"]?.derivedFrom ?? {}) as Partial<Record<HighlightCategory, { candidates?: StoredCandidate[] }>>;
  const ids = Object.values(value).flatMap((v) => v?.ids ?? []);
  const names = new Map<string, string | null>();
  if (ids.length > 0) {
    const { rows } = await db.execute<{ id: string; name: string | null }>(
      sql`select o.id, ${displayNameSql(sql`o.id`)} as name from geo_objects o where o.id = any(${sql.param(ids)}::uuid[])`,
    );
    for (const r of rows) names.set(r.id, r.name);
  }
  return HIGHLIGHT_CATEGORIES.flatMap((category) => {
    const sel = value[category];
    if (!sel) return [];
    const candidates = derivedFrom[category]?.candidates ?? [];
    const byId = new Map(candidates.map((c) => [c.geoObjectId, c]));
    return [
      {
        category,
        label: POI_CATEGORY_LABELS[category],
        level: sel.level,
        levelLabel: HIGHLIGHT_LEVEL_LABELS[sel.level],
        highlights: sel.ids.map((id) => ({
          geoObjectId: id,
          name: names.get(id) ?? null,
          importance: byId.get(id)?.importance ?? 0,
          distanceKm: byId.get(id)?.distanceKm ?? 0,
        })),
        others: Math.max(0, candidates.length - sel.ids.length),
      },
    ];
  });
}
