import { z } from "zod";
import type { ModelTask } from "../types";

/*
 * Watermark check of a generated place image (spec 13): a vision call that looks only for overlay artefacts (legible
 * text, logos, watermarks, semi-transparent bands). The prompt has no variables. The image is attached as JPEG (the
 * caller converts with `toJpeg`, which also keeps the request small).
 */

export type CheckPlaceImageInput = { image: Uint8Array };
export type CheckPlaceImageOutput = { watermarkVisible: boolean; note: string };

const output: z.ZodType<CheckPlaceImageOutput> = z.object({ watermarkVisible: z.boolean(), note: z.string() });

export const checkPlaceImageTask: ModelTask<CheckPlaceImageInput, CheckPlaceImageOutput> = {
  name: "check-place-image",
  output,
  variables: () => ({}),
  attachments: (input) => [{ kind: "image", mediaType: "image/jpeg", data: input.image }],
};
