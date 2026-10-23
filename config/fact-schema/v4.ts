import type { AttributeDef, FactSchema } from "@/lib/domain/facts/schema-types";
import { SECTORS } from "@/lib/domain/facts/schema-types";
import { factSchemaV3 } from "./v3";

/*
 * Fact schema v4 (plan N2): the berth-relevant subset of v3, level `place` only. Every definition is v3's, unchanged;
 * what a charter crew needs to judge a berth stays, highlights, quietness, fetch and the geometric keys go. The
 * per-berth research reads this version (`research.extraction.factSchema`); `active.json` stays on v3 for the old pipeline.
 */

const KEYS: readonly string[] = [
  "place.kind_evidence",
  "berthable",
  ...SECTORS.map((s) => `shelter.${s}`),
  "swell_protection",
  "depth.min",
  "depth.max",
  "depth.anchoring_min",
  "depth.anchoring_max",
  "depth.approach",
  "seabed",
  "holding",
  "mooring.buoys",
  "mooring.types",
  "mooring.line_ashore_required",
  "prices",
  "occupancy",
  "season_notes",
  "prohibitions",
  "hazards",
  "max_draft",
  "max_length",
  "capacity",
  "services.water",
  "services.electricity",
  "services.fuel",
  "contact",
];

const v3 = new Map(factSchemaV3.levels.place.map((d) => [d.key, d]));

const place: AttributeDef[] = KEYS.flatMap((k) => {
  const def = v3.get(k);
  return def ? [def] : [];
});

const empty = { area: [], island: [], cape_strait: [], poi: [] };

export const factSchemaV4: FactSchema = { version: "v4", levels: { ...empty, place } };
