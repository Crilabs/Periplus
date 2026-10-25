import { z } from "zod";
import { isoDate, latitude, longitude, textDe } from "./common";

/*
 * Title images of a place (contract 2.1, spec 13): a spot or highlight carries any number of images, one per slot. The
 * file lies in the package under `images/<public id>-<slot>.jpg`; `camera` says where the picture was taken from.
 */

const ULID = "[0-9A-HJKMNP-TV-Z]{26}";

/** The slot of an image: `title` (generated) or `view-<n>` (added in the admin interface). */
export const imageSlot = z.string().regex(/^(?:title|view-[1-9]\d*)$/, "must be title or view-<n>");

/** A package file of an image, `images/<sp|hl>_<ulid>-<slot>.jpg`. */
export const IMAGE_FILE_PATTERN = new RegExp(`^images/(?:sp|hl)_${ULID}-(?:title|view-[1-9]\\d*)\\.jpg$`);
export const imageFile = z.string().regex(IMAGE_FILE_PATTERN, "must be images/<public id>-<slot>.jpg");

/** Where the picture was taken from (spec 13): never present for a photograph without known viewpoint. */
export const imageCameraSchema = z.strictObject({
  /** `[lon, lat]`. */
  position: z.tuple([longitude, latitude]),
  /** Height above sea level, metres. */
  heightM: z.number().min(0),
  /** The direction the camera looks, degrees clockwise from north. */
  viewBearingDeg: z.number().min(0).lt(360),
  tiltDeg: z.number().min(0).max(90),
  /** Vertical field of view. */
  fovDeg: z.number().gt(0).lt(180),
});

export const placeImageSchema = z.strictObject({
  kind: z.enum(["photo", "ai_illustration"]),
  slot: imageSlot,
  file: imageFile,
  width: z.number().int().min(1),
  height: z.number().int().min(1),
  alt: textDe,
  light: z.enum(["midday", "evening"]).nullable(),
  observedAt: isoDate.nullable(),
  license: z.string().min(1),
  attribution: z.string().min(1),
  camera: imageCameraSchema.nullable(),
});

export type PlaceImage = z.infer<typeof placeImageSchema>;
