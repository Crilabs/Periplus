import type { ImageryLight, ImagesConfig } from "@/lib/config";
import type { PlaceImageInput } from "./place-input";

/**
 * How the image is composed (spec 13, image rules): `open_water` looks from the water at the centre of the place;
 * `near_town` puts an anchorage or mooring field in front and the nearby town behind.
 */
export type Composition = "open_water" | "near_town";

/** What the composition and the light are decided from: the place kind and whether a town is nearby (`PlaceImageInput`, or the place info of the UI). */
export type CompositionInput = { kind: PlaceImageInput["kind"]; town: object | null };

/** `near_town` for an anchorage or mooring field with a town nearby, else `open_water`. */
export function compositionFor(input: CompositionInput): Composition {
  return input.town !== null && (input.kind === "anchorage" || input.kind === "mooring_field") ? "near_town" : "open_water";
}

/**
 * Light of the image: `light.nearTown` for the near-town composition, else the light of the place kind (anchorage and
 * mooring field midday, marina and port evening). A marina or port keeps its own light even with a town nearby.
 */
export function lightFor(input: CompositionInput, cfg: Pick<ImagesConfig, "light">): ImageryLight {
  return compositionFor(input) === "near_town" ? cfg.light.nearTown : cfg.light.byKind[input.kind];
}
