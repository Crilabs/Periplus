import { inArray } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import { places } from "@/lib/db/schema";
import { latestComputations, type StoredComputation } from "@/lib/domain/facts/computations";
import { SECTORS } from "@/lib/domain/facts/schema-types";
import { displayNameSql } from "@/lib/domain/gazetteer/names";
import { GAP_REASONS, type Gap, type GapReason } from "@/lib/domain/geometry/gaps";
import { requireSubdivision } from "@/lib/domain/subdivisions/store";
import { geometryPlaceIds } from "@/lib/pipeline/geometry";

export type GeometryCheck = {
  places: number;
  complete: number;
  missing: Array<{ placeId: string; name: string; missing: string[] }>;
  depthGaps: Array<{ placeId: string; name: string; reason: GapReason }>;
};

/** Depth gaps that count as a justified gap ("begründete Lücke"): the data says there is no depth, not the run. */
const ACCEPTED_DEPTH_GAPS: GapReason[] = ["no_bathymetry", "no_anchor_area"];
/** Attributes whose value or accepted gap makes the depth complete. */
const DEPTH_ATTRIBUTES = ["depth.approach", "depth.min"];

type Stored = Map<StoredComputation["kind"], StoredComputation>;

function gapsOf(stored: Stored, kind: StoredComputation["kind"]): Gap[] {
  const gaps = stored.get(kind)?.outputs.gaps;
  return Array.isArray(gaps) ? (gaps as Gap[]).filter((g) => GAP_REASONS.includes(g.reason)) : [];
}

const hasFact = (stored: Stored, kind: StoredComputation["kind"], attribute: string) =>
  stored.get(kind)?.facts.some((f) => f.attribute === attribute) ?? false;

/**
 * What the newest computations of a place lack for acceptance, and its accepted depth gap. A `shelter.*` or `depth.*`
 * gap on the newest anchor area (no water, no origin; M2-P13) outranks older shelter and depth rows: they are stale.
 */
function assess(stored: Stored): { missing: string[]; depthGap: GapReason | null } {
  const areaGaps = gapsOf(stored, "anchor_area");
  const noShelter = areaGaps.some((g) => g.attribute === "shelter.*");
  const noDepth = areaGaps.some((g) => g.attribute === "depth.*");

  const missing: string[] = [];
  for (const s of SECTORS) if (noShelter || !hasFact(stored, "shelter", `shelter.${s}`)) missing.push(`shelter.${s}`);
  if (noShelter || !hasFact(stored, "shelter", "opening_bearing")) missing.push("opening_bearing");

  if (noDepth) return { missing: [...missing, "depth"], depthGap: null };
  if (DEPTH_ATTRIBUTES.some((a) => hasFact(stored, "depth", a))) return { missing, depthGap: null };
  const gap = gapsOf(stored, "depth").find((g) => DEPTH_ATTRIBUTES.includes(g.attribute) && ACCEPTED_DEPTH_GAPS.includes(g.reason));
  return gap ? { missing, depthGap: gap.reason } : { missing: [...missing, "depth"], depthGap: null };
}

/**
 * Acceptance check of the geometry stage for the subdivision `subdivisionKey`, over the places the stage computes
 * (`geometryPlaceIds`). A place is complete with all 8 `shelter.*` facts, `opening_bearing`, and `depth.approach` or
 * `depth.min` — or instead of a depth a gap `no_bathymetry` / `no_anchor_area` (listed in `depthGaps`). `missing`
 * lists the incomplete places (attributes, `depth` for the depth), sorted by name. Throws for an unknown subdivision.
 */
export async function checkGeometry(db: Db, subdivisionKey: string): Promise<GeometryCheck> {
  await requireSubdivision(db, subdivisionKey);
  const ids = await geometryPlaceIds(db, { subdivisionKey });
  const rows = ids.length
    ? await db
        .select({ placeId: places.id, geoObjectId: places.geoObjectId, name: displayNameSql(places.geoObjectId) })
        .from(places)
        .where(inArray(places.id, ids))
    : [];
  const named = rows
    .map((r) => ({ ...r, name: r.name ?? "(ohne Namen)" }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.placeId.localeCompare(b.placeId));

  const result: GeometryCheck = { places: named.length, complete: 0, missing: [], depthGaps: [] };
  for (const r of named) {
    const { missing, depthGap } = assess(await latestComputations(db, r.geoObjectId));
    if (depthGap) result.depthGaps.push({ placeId: r.placeId, name: r.name, reason: depthGap });
    if (missing.length === 0) result.complete += 1;
    else result.missing.push({ placeId: r.placeId, name: r.name, missing });
  }
  return result;
}
