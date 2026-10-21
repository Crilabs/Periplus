import { z } from "zod";
import { fileEnvelope } from "./common";
import { changeEntrySchema } from "./changes";
import { coastCollectionSchema } from "./coast";
import { highlightSchema } from "./highlight";
import { manifestSchema } from "./manifest";
import { regionSchema } from "./region";
import { spotSchema } from "./spot";
import { weatherPointSchema } from "./weather-point";

export * from "./common";
export * from "./changes";
export * from "./coast";
export * from "./highlight";
export * from "./image";
export * from "./manifest";
export * from "./region";
export * from "./spot";
export * from "./weather-point";

/** File envelopes of a package. */
export const spotsFileSchema = z.strictObject({ ...fileEnvelope, spots: z.array(spotSchema) });
export const highlightsFileSchema = z.strictObject({ ...fileEnvelope, highlights: z.array(highlightSchema) });
export const regionsFileSchema = z.strictObject({ ...fileEnvelope, regions: z.array(regionSchema) });
export const weatherPointsFileSchema = z.strictObject({ ...fileEnvelope, points: z.array(weatherPointSchema) });
export const changesFileSchema = z.strictObject({
  ...fileEnvelope,
  previousDataVersion: z.number().int().min(1),
  changes: z.array(changeEntrySchema),
});

export type SpotsFile = z.infer<typeof spotsFileSchema>;
export type HighlightsFile = z.infer<typeof highlightsFileSchema>;
export type RegionsFile = z.infer<typeof regionsFileSchema>;
export type WeatherPointsFile = z.infer<typeof weatherPointsFileSchema>;
export type ChangesFile = z.infer<typeof changesFileSchema>;

export { manifestSchema, coastCollectionSchema };
