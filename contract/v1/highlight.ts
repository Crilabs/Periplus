import { z } from "zod";
import { count, highlightCategory, isoDate, latLon, month, publicId, sourceRef, textDe, unit, versionFields } from "./common";

/** Highlight (Teil B "Highlight"): a reason to go somewhere. */
export const highlightSchema = z.strictObject({
  id: publicId("hl"),
  name: z.string().min(1),
  category: highlightCategory,
  /** 1–5; radius of meaning 5/10/20/35/50 nm. */
  importance: z.number().int().min(1).max(5),
  position: latLon,
  /** Spots where the highlight counts, by distance. */
  spotIds: z.array(publicId("sp")),
  regionId: publicId("rg").nullable().optional(),
  /** Only reachable or open in these months; null = all year. */
  season: z.strictObject({ months: z.array(month).min(1) }).nullable(),
  summary: textDe.optional(),
  sources: z.array(sourceRef).optional(),
  externalRefs: z
    .strictObject({
      googlePlaceId: z.string().min(1).nullable(),
      osmId: z.string().regex(/^(node|way|relation)\/\d+$/).nullable(),
      wikidataId: z.string().regex(/^Q\d+$/).nullable(),
    })
    .optional(),
  score: z.strictObject({ confidence: unit, sourcesCount: count, lastObserved: isoDate.nullable() }),
  ...versionFields,
});

export type Highlight = z.infer<typeof highlightSchema>;
export type HighlightBody = Omit<Highlight, "profileVersion" | "validFrom">;
