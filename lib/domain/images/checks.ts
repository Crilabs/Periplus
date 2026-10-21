import sharp from "sharp";
import type { ImageryLight, ImagesConfig } from "@/lib/config";

/*
 * Geometry check of a generated image (spec 13): the AI image must keep the render's coastline. The render's mask
 * says where water is (255), land (0) and sky (128); the water of the AI image is found by colour.
 */

type WaterColour = ImagesConfig["check"]["waterColour"];

const SKY = 128;
const WATER = 255;

/**
 * Intersection over union of the water in the mask and the water in the AI image, over all mask pixels that are not
 * sky. A pixel of the AI image is water when `b > r + blueOverRedMin && b >= g - greenTolerance`. Both are decoded
 * at the mask's size (1536 × 1024 in production); an AI image of another size is resized to it first, which only
 * guards against a wrong-sized input as the OpenAI adapter already rejects those. Without any water in either (an
 * empty union) the result is 0: a render without water cannot be confirmed.
 */
export async function waterIoU(
  mask: Uint8Array,
  image: Uint8Array,
  cfg: { waterColour: WaterColour },
): Promise<number> {
  const m = await sharp(mask).greyscale().raw().toBuffer({ resolveWithObject: true });
  const { width, height } = m.info;
  const channels = m.info.channels;
  const img = await sharp(image)
    .removeAlpha()
    .resize(width, height, { fit: "fill" })
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { blueOverRedMin, greenTolerance } = cfg.waterColour;
  let intersection = 0;
  let union = 0;
  for (let i = 0; i < width * height; i++) {
    const mv = m.data[i * channels]!;
    if (mv === SKY) continue;
    const r = img.data[i * 3]!;
    const g = img.data[i * 3 + 1]!;
    const b = img.data[i * 3 + 2]!;
    const maskWater = mv === WATER;
    const imageWater = b > r + blueOverRedMin && b >= g - greenTolerance;
    if (maskWater && imageWater) intersection++;
    if (maskWater || imageWater) union++;
  }
  return union === 0 ? 0 : intersection / union;
}

/** Whether the IoU reaches the minimum of the image's light (midday 0.80, evening 0.60). */
export function passesGeometry(iou: number, light: ImageryLight, cfg: Pick<ImagesConfig["check"], "minWaterIoU">): boolean {
  return iou >= cfg.minWaterIoU[light];
}

/** The delivery format: the generated PNG as JPEG. */
export async function toJpeg(png: Uint8Array, quality: number): Promise<Uint8Array> {
  return new Uint8Array(await sharp(png).jpeg({ quality }).toBuffer());
}
