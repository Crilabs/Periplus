import type { ImageryLight, ImagesConfig } from "@/lib/config";
import type { PlaceImageInput } from "./place-input";
import { projectGround } from "./projection";
import type { RenderCamera } from "./render-plan";

/**
 * Light of the image (spec 19): a marina or port by its kind (evening); an anchorage or mooring field `light.nearTown`
 * (evening) when its town (`town`: the nearest place of `light.townPlaces`, town or city, within `townRadiusM`) lies
 * in the image of `camera`, at least `townInFrameMargin` inside the edges, else by its kind (midday). Without a camera
 * (no view over water) the light of the kind.
 */
export function lightFor(
  input: Pick<PlaceImageInput, "kind" | "town">,
  camera: RenderCamera | null,
  cfg: Pick<ImagesConfig, "light">,
): ImageryLight {
  const byKind = cfg.light.byKind[input.kind];
  if (input.kind === "marina" || input.kind === "port" || !input.town || !camera) return byKind;
  const [p] = projectGround(camera, [[input.town.lon, input.town.lat]]);
  const limit = 1 - cfg.light.townInFrameMargin;
  return p && Math.abs(p[0]) <= limit && Math.abs(p[1]) <= limit ? cfg.light.nearTown : byKind;
}
