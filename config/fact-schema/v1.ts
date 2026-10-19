import { z } from "zod";
import { restrictedKindEnum } from "@/lib/db/schema/geo";
import { SECTORS, type AttributeDef, type FactSchema } from "@/lib/domain/facts/schema-types";

/*
 * Fact schema v1: the computed place attributes of M2. A changed key, value shape or rule is a new
 * version file, never an edit here; `active.json` names the version new facts are written with.
 */

const share = z.number().min(0).max(1);
const depthM = z.number().min(0);

const SEABED_TYPES = ["sand", "mud", "gravel", "rock", "mixed", "weed"] as const;

const sectorAttributes = (
  prefix: string,
  def: Omit<AttributeDef, "key" | "description">,
  description: (sector: string) => string,
): AttributeDef[] => SECTORS.map((s) => ({ key: `${prefix}.${s}`, ...def, description: description(s) }));

const place: AttributeDef[] = [
  ...sectorAttributes(
    "shelter",
    { value: share, rule: "shelter", origins: ["computed", "text"] },
    (s) => `Shelter from wind and sea out of sector ${s}, 0 (open) to 1 (fully sheltered)`,
  ),
  {
    key: "swell_protection",
    value: share,
    rule: "swell_protection",
    origins: ["computed", "text"],
    description: "Protection from swell entering through the widest opening, 0 to 1",
  },
  {
    key: "opening_bearing",
    value: z.strictObject({
      bearingDeg: z.number().min(0).lt(360).nullable(),
      widthDeg: z.number().min(0).max(360),
    }),
    rule: "computed_only",
    origins: ["computed"],
    description: "Mean bearing and angular width of the opening to the sea (rays with long fetch)",
  },
  ...sectorAttributes(
    "fetch",
    { value: z.number().int().min(0).max(50000), rule: "computed_only", origins: ["computed"] },
    (s) => `Fetch towards sector ${s} in metres, mean of its 9 rays`,
  ),
  ...(
    [
      ["depth.min", "Minimum depth in the water area"],
      ["depth.max", "Maximum depth in the water area"],
      ["depth.anchoring_min", "Minimum depth in the anchor area"],
      ["depth.anchoring_max", "Maximum depth in the anchor area"],
    ] as const
  ).map(
    ([key, text]): AttributeDef => ({
      key,
      value: depthM,
      rule: "bathymetry",
      origins: ["computed", "text"],
      description: `${text}, metres below LAT`,
    }),
  ),
  {
    key: "depth.approach",
    value: z.strictObject({ at50m: depthM.nullable(), at100m: depthM.nullable(), at200m: depthM.nullable() }),
    rule: "bathymetry",
    origins: ["computed", "text"],
    description: "Depth samples 50, 100 and 200 m out along the opening bearing, metres below LAT",
  },
  {
    key: "seabed",
    value: z
      .array(z.strictObject({ type: z.enum(SEABED_TYPES), share }))
      .min(1)
      .refine(
        (parts) => Math.abs(parts.reduce((sum, p) => sum + p.share, 0) - 1) <= 0.01 + 1e-9,
        "shares must sum to 1 (± 0.01)",
      ),
    rule: "bathymetry",
    origins: ["computed", "text"],
    description: "Seabed types in the anchor area with their area shares",
  },
  {
    key: "anchor_area",
    value: z.strictObject({ areaM2: z.number().min(0) }),
    rule: "computed_only",
    origins: ["computed"],
    description: "Size of the area with anchoring depth and distance to land, square metres",
  },
  {
    key: "anchor_position",
    value: z.strictObject({ lon: z.number().min(-180).max(180), lat: z.number().min(-90).max(90) }),
    rule: "review_over_computed",
    origins: ["computed", "observed"],
    description: "Anchoring position (WGS84); a review correction beats the computed one",
  },
  {
    key: "prohibitions",
    value: z.array(
      z.strictObject({
        kind: z.enum(restrictedKindEnum.enumValues),
        restrictedAreaId: z.uuid(),
        sourceRef: z.string().nullable(),
        share,
        anchoringBan: z.boolean(),
      }),
    ),
    rule: "prohibitions",
    origins: ["computed"],
    description: "Restricted areas overlapping the anchor area (or position), with share and anchoring ban",
  },
];

export const factSchemaV1: FactSchema = {
  version: "v1",
  levels: { place, area: [], island: [], cape_strait: [], poi: [] },
};
