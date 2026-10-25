import type { PlaceImage } from "@/contract/v3_0";
import type { DeliverableImage } from "./types";

/*
 * Current images of a place → contract `images` (2.1, spec 13) and the package files behind them. Pure: no database,
 * no archive. The order is the loader's (rank, sort order, slot).
 */

/** A package file of an image: its name in the package and the archive key its bytes come from. */
export type ImageFile = { file: string; fileKey: string };

/** The package file of an image of `publicId`: `images/<public id>-<slot>.jpg`. */
export const imageFileName = (publicId: string, slot: string) => `images/${publicId}-${slot}.jpg`;

/** The contract images of the place, or undefined when it has none (the contract has no empty list). */
export function mapImages(publicId: string, rows: DeliverableImage[]): PlaceImage[] | undefined {
  if (rows.length === 0) return undefined;
  return rows.map((r) => ({
    kind: r.kind,
    slot: r.slot,
    file: imageFileName(publicId, r.slot),
    width: r.width,
    height: r.height,
    alt: { de: r.alt },
    light: r.light,
    observedAt: r.observedAt,
    license: r.license,
    attribution: r.attribution,
    sourceUrl: null,
    camera: r.camera,
  }));
}

/** The package files of the place's images, in the order of `mapImages`. */
export function imageFiles(publicId: string, rows: DeliverableImage[]): ImageFile[] {
  return rows.map((r) => ({ file: imageFileName(publicId, r.slot), fileKey: r.fileKey }));
}
