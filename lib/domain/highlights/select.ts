import type { ConsolidationConfig } from "@/lib/config/schemas";
import type { PoiCategory } from "@/lib/db/schema";
import { distanceNm } from "@/lib/domain/delivery/geo";

/*
 * Pure selection of the highlights of one place (spec 16): at most `maxPerCategory` per category, plus a level
 * none / some / many from the weighted rest. No database, no config reads.
 */

export type HighlightsConfig = NonNullable<ConsolidationConfig["highlights"]>;
export type HighlightLevel = "none" | "some" | "many";

export type HighlightCandidate = {
  geoObjectId: string;
  category: PoiCategory;
  name: string | null;
  nameNormalized: string | null;
  importance: 1 | 2 | 3 | 4 | 5;
  score: number;
  distanceKm: number;
  lon: number;
  lat: number;
};

export type TextName = { category: PoiCategory; nameNormalized: string };

export type CategorySelection = {
  ids: string[];
  level: HighlightLevel;
  /** In reach after duplicate collapse (provenance). */
  candidates: Array<{ geoObjectId: string; importance: number; score: number; distanceKm: number }>;
  /** Distinct text names no candidate carries. */
  textNames: string[];
};

const METRES_PER_NM = 1852;

/** The highlights configuration of a consolidation version; v1 predates it. */
export function highlightsConfig(cfg: ConsolidationConfig): HighlightsConfig {
  if (!cfg.highlights) {
    const version = (cfg as { version?: string }).version ?? "?";
    throw new Error(`consolidation ${version} has no highlights configuration`);
  }
  return cfg.highlights;
}

function byRank(a: HighlightCandidate, b: HighlightCandidate): number {
  return (
    b.importance - a.importance ||
    b.score - a.score ||
    a.distanceKm - b.distanceKm ||
    (a.geoObjectId < b.geoObjectId ? -1 : a.geoObjectId > b.geoObjectId ? 1 : 0)
  );
}

/** Same normalised name within `duplicateM` metres counts once; the better-ranked one stays. */
function collapseDuplicates(list: HighlightCandidate[], duplicateM: number): HighlightCandidate[] {
  const kept: HighlightCandidate[] = [];
  for (const c of [...list].sort(byRank)) {
    const twin =
      c.nameNormalized !== null &&
      kept.some((k) => k.nameNormalized === c.nameNormalized && distanceNm(k, c) * METRES_PER_NM <= duplicateM);
    if (!twin) kept.push(c);
  }
  return kept;
}

export function selectHighlights(
  candidates: HighlightCandidate[],
  textNames: TextName[],
  cfg: HighlightsConfig,
  duplicateM: number,
): Partial<Record<PoiCategory, CategorySelection>> {
  const categories = new Set<PoiCategory>([...candidates.map((c) => c.category), ...textNames.map((t) => t.category)]);
  const result: Partial<Record<PoiCategory, CategorySelection>> = {};
  const weight = (importance: number) => cfg.levelWeights[importance - 1] as number;
  const [someFrom, manyFrom] = cfg.levelThresholds as [number, number];

  for (const category of categories) {
    const all = candidates.filter((c) => c.category === category);
    const inReach = all.filter((c) => c.distanceKm <= (cfg.reachKm[c.importance - 1] as number));
    const ranked = collapseDuplicates(inReach, duplicateM);

    // A text name a loaded POI carries is that POI, in reach or not.
    const known = new Set(all.map((c) => c.nameNormalized).filter((n): n is string => n !== null));
    const unassigned = [
      ...new Set(
        textNames.filter((t) => t.category === category && !known.has(t.nameNormalized)).map((t) => t.nameNormalized),
      ),
    ];
    if (ranked.length === 0 && unassigned.length === 0) continue;

    const rest =
      ranked.slice(cfg.maxPerCategory).reduce((sum, c) => sum + weight(c.importance), 0) +
      unassigned.length * weight(cfg.textNameImportance);
    result[category] = {
      ids: ranked.slice(0, cfg.maxPerCategory).map((c) => c.geoObjectId),
      level: rest < someFrom ? "none" : rest < manyFrom ? "some" : "many",
      candidates: ranked.map((c) => ({
        geoObjectId: c.geoObjectId,
        importance: c.importance,
        score: c.score,
        distanceKm: c.distanceKm,
      })),
      textNames: unassigned,
    };
  }
  return result;
}
