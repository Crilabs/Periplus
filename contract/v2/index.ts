import { z } from "zod";
import { fileEnvelope } from "./common";
import { coastCollectionSchema } from "./coast";
import { manifestSchema } from "./manifest";
import { regionSchema } from "./region";
import { spotSchema } from "./spot";
import { weatherPointSchema } from "./weather-point";

export * from "./common";
export * from "./coast";
export * from "./image";
export * from "./manifest";
export * from "./region";
export * from "./spot";
export * from "./weather-point";

/** File envelopes of a package. */
export const spotsFileSchema = z.strictObject({ ...fileEnvelope, spots: z.array(spotSchema) });
export const regionsFileSchema = z.strictObject({ ...fileEnvelope, regions: z.array(regionSchema) });
export const weatherPointsFileSchema = z.strictObject({ ...fileEnvelope, points: z.array(weatherPointSchema) });

/** The answer of every `…/changes` route in contract 4.0: there is no change feed, the consumer reloads (E8). */
export const changesResponseSchema = z.strictObject({ invalidSince: z.literal(true), reason: z.literal("reload") });

export type SpotsFile = z.infer<typeof spotsFileSchema>;
export type RegionsFile = z.infer<typeof regionsFileSchema>;
export type WeatherPointsFile = z.infer<typeof weatherPointsFileSchema>;
export type ChangesResponse = z.infer<typeof changesResponseSchema>;

export { manifestSchema, coastCollectionSchema };
