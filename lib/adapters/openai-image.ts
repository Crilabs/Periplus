import sharp from "sharp";
import { getConfig, type AppConfig } from "@/lib/config";
import { getEnv } from "@/lib/env";
import { httpCall, type CallContext, type HttpResponse, type Transport } from "./http";
import { assertNotSimulated } from "./simulation";

export type ImageEditRequest = {
  task: "generate-place-image";
  image: Uint8Array;
  prompt: string;
  /** The place and slot the edit is for, recorded in `external_calls.meta`: the cost per Landesteil sums by them. */
  subject?: { geoObjectId: string; slot: string };
};
export type ImageEditResult = { image: Uint8Array; model: string; promptVersion: number; costEur: number };

/** Image-to-image model (OpenAI `v1/images/edits`); `MockImageModel` stands in for it in tests. */
export interface ImageModel {
  edit(req: ImageEditRequest, ctx: CallContext): Promise<ImageEditResult>;
  /** Whether `edit` can be called at all (the OpenAI adapter: `OPENAI_API_KEY` is set); the image plan asks first. */
  available(): boolean;
}

/** The model answered, but without a usable image (no `b64_json`, not a PNG, or not 1536 x 1024). */
export class ImageOutputInvalid extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ImageOutputInvalid";
  }
}

export const OPENAI_IMAGE_EDITS_URL = "https://api.openai.com/v1/images/edits";
/** Fixed multipart boundary: the body, and with it the fixture key, is deterministic. */
export const MULTIPART_BOUNDARY = "----periplus-image";
const WIDTH = 1536;
const HEIGHT = 1024;

function multipart(fields: Record<string, string>, image: Uint8Array): Uint8Array {
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  for (const [name, value] of Object.entries(fields)) {
    parts.push(enc.encode(`--${MULTIPART_BOUNDARY}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  }
  parts.push(
    enc.encode(
      `--${MULTIPART_BOUNDARY}\r\nContent-Disposition: form-data; name="image"; filename="render.png"\r\nContent-Type: image/png\r\n\r\n`,
    ),
    image,
    enc.encode(`\r\n--${MULTIPART_BOUNDARY}--\r\n`),
  );
  return Buffer.concat(parts);
}

function b64Of(res: HttpResponse): string | undefined {
  try {
    const answer = JSON.parse(res.text()) as { data?: Array<{ b64_json?: unknown }> };
    const b64 = answer.data?.[0]?.b64_json;
    return typeof b64 === "string" && b64 !== "" ? b64 : undefined;
  } catch {
    return undefined;
  }
}

/** The OpenAI image edit model of task `generate-place-image`, priced from `models.pricesEurPerImage`. */
export function createOpenAiImageModel(transport: Transport, config: Pick<AppConfig, "models"> = getConfig()): ImageModel {
  return {
    available: () => getEnv().OPENAI_API_KEY !== undefined,
    async edit(req, ctx) {
      assertNotSimulated("openai", "images.edit");
      const key = getEnv().OPENAI_API_KEY;
      if (!key) throw new Error("OPENAI_API_KEY is not set");
      const task = config.models.imageTasks[req.task];
      if (!task) throw new Error(`no image task ${req.task} in config/models.json`);
      const price = config.models.pricesEurPerImage[task.model]?.[task.quality];
      if (price === undefined) throw new Error(`no price for image model ${task.model}`);

      const body = multipart(
        { model: task.model, prompt: req.prompt, size: task.size, quality: task.quality, n: "1" },
        req.image,
      );
      const res = await httpCall(
        transport,
        {
          service: "openai",
          operation: "images.edit",
          url: OPENAI_IMAGE_EDITS_URL,
          method: "POST",
          body,
          headers: { Authorization: `Bearer ${key}`, "Content-Type": `multipart/form-data; boundary=${MULTIPART_BOUNDARY}` },
          // an edit of a 1536 x 1024 image takes minutes: its own ceiling (`imageTasks.<task>.timeoutSeconds`), not the text-model timeout
          timeoutMs: task.timeoutSeconds * 1000,
          budget: "openai",
          // an answered call is billed even when its image turns out unusable
          costOf: () => ({ units: 1, unit: "image", costEur: price }),
          meta: { model: task.model, quality: task.quality, task: req.task, ...req.subject },
        },
        ctx,
      );

      const b64 = b64Of(res);
      if (!b64) throw new ImageOutputInvalid("openai answered without data[0].b64_json");
      const image = new Uint8Array(Buffer.from(b64, "base64"));
      let size: { width?: number; height?: number };
      try {
        size = await sharp(image).metadata();
      } catch (error) {
        throw new ImageOutputInvalid(`openai image is not readable: ${(error as Error).message}`, { cause: error });
      }
      if (size.width !== WIDTH || size.height !== HEIGHT) {
        throw new ImageOutputInvalid(`openai image is ${size.width}x${size.height}, expected ${WIDTH}x${HEIGHT}`);
      }
      return { image, model: task.model, promptVersion: task.promptVersion, costEur: price };
    },
  };
}
