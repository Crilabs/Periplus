import { z } from "zod";
import { latLon, publicId, weatherPointId } from "./common";

/** A weather point on open water (Teil B "Küste, Seegraph-Grundlage und Wetterpunkte"). */
export const weatherPointSchema = z.strictObject({
  id: weatherPointId,
  /** German name. */
  name: z.string().min(1),
  position: latLon,
  kind: z.enum(["region", "channel", "cape"]),
  regionId: publicId("rg").nullable(),
});

export type WeatherPoint = z.infer<typeof weatherPointSchema>;
