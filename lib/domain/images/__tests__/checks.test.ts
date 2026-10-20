import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { loadConfig } from "@/lib/config";
import { passesGeometry, toJpeg, waterIoU } from "@/lib/domain/images/checks";

const cfg = loadConfig("config").images.check;
const W = 120;
const H = 80;
const WATER = [30, 90, 200];
const LAND = [120, 110, 90];

/** A single-channel mask PNG: water 255, land 0, sky 128 (the renderer's format). */
async function maskPng(value: (x: number, y: number) => number): Promise<Uint8Array> {
  const buf = Buffer.alloc(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) buf[y * W + x] = value(x, y);
  return sharp(buf, { raw: { width: W, height: H, channels: 1 } }).png().toBuffer();
}

async function imagePng(isWater: (x: number, y: number) => boolean): Promise<Uint8Array> {
  const buf = Buffer.alloc(W * H * 3);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) Buffer.from(isWater(x, y) ? WATER : LAND).copy(buf, (y * W + x) * 3);
  return sharp(buf, { raw: { width: W, height: H, channels: 3 } }).png().toBuffer();
}

describe("waterIoU", () => {
  it("identical water gives IoU 1", async () => {
    const mask = await maskPng((x) => (x < W / 2 ? 255 : 0));
    const image = await imagePng((x) => x < W / 2);
    expect(await waterIoU(mask, image, cfg)).toBe(1);
  });

  it("sky pixels are ignored", async () => {
    const mask = await maskPng((_x, y) => (y < 20 ? 128 : 255));
    // Water colour in the sky rows of the image must not count as a false positive.
    const image = await imagePng(() => true);
    expect(await waterIoU(mask, image, cfg)).toBe(1);
  });

  it("half-shifted coastline gives about 0.33", async () => {
    const mask = await maskPng((x) => (x < W / 2 ? 255 : 0));
    const image = await imagePng((x) => x >= W / 4 && x < (3 * W) / 4);
    expect(await waterIoU(mask, image, cfg)).toBeCloseTo(1 / 3, 2);
  });

  it("compares an image of another size at the mask size", async () => {
    const mask = await maskPng((x) => (x < W / 2 ? 255 : 0));
    const big = await sharp(await imagePng((x) => x < W / 2)).resize(W * 2, H * 2, { kernel: "nearest" }).png().toBuffer();
    expect(await waterIoU(mask, big, cfg)).toBeGreaterThan(0.97);
  });

  it("a render without any water gives 0", async () => {
    const mask = await maskPng(() => 0);
    expect(await waterIoU(mask, await imagePng(() => false), cfg)).toBe(0);
  });
});

describe("passesGeometry", () => {
  it("0.79 fails midday, 0.61 passes evening", () => {
    expect(passesGeometry(0.79, "midday", cfg)).toBe(false);
    expect(passesGeometry(0.8, "midday", cfg)).toBe(true);
    expect(passesGeometry(0.61, "evening", cfg)).toBe(true);
    expect(passesGeometry(0.59, "evening", cfg)).toBe(false);
  });
});

describe("toJpeg", () => {
  it("converts a PNG to a JPEG of the same size", async () => {
    const jpeg = await toJpeg(await imagePng((x) => x < W / 2), 85);
    const meta = await sharp(jpeg).metadata();
    expect(meta).toMatchObject({ format: "jpeg", width: W, height: H });
  });
});
