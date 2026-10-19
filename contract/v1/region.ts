import { z } from "zod";
import { areal, latLon, publicId, textDe, unit, versionFields } from "./common";

/** Region (Teil B "Region"): the gazetteer levels the planner needs. */
export const regionType = z.enum(["island", "coast", "gulf", "channel", "archipelago"]);

export const regionSchema = z.strictObject({
  id: publicId("rg"),
  /** German display name. */
  name: z.string().min(1),
  names: z.array(z.strictObject({ lang: z.string().min(2), name: z.string().min(1) })).optional(),
  type: regionType,
  center: latLon,
  radiusNm: z.number().positive(),
  polygon: areal.optional(),
  /** The parent region in the package (`rg_`) or the area (`ar_`). */
  parentId: z.union([publicId("rg"), publicId("ar")]).nullable(),
  spotIds: z.array(publicId("sp")),
  character: textDe.optional(),
  facts: z
    .strictObject({
      meltemiExposure: unit.nullable(),
      ferryTraffic: z.enum(["none", "light", "heavy"]).nullable(),
      charterBase: z.boolean().nullable(),
      supplyPort: z.boolean().nullable(),
    })
    .optional(),
  ...versionFields,
});

export type Region = z.infer<typeof regionSchema>;
export type RegionBody = Omit<Region, "profileVersion" | "validFrom">;
