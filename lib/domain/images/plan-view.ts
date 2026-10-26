import type { ImagesConfig, ZoomLevel } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { planAnchorWindow } from "./anchor-window";
import { planHarbour } from "./harbour-focus";
import type { PlaceImageInput } from "./place-input";
import { planRender, type RenderPlan } from "./render-plan";

/**
 * Camera of a view of a place. The automatic view (no zoom and no start bearing of its own: the title image of a
 * run) takes its camera from the outline (spec 19): the basin or piers of a marina or port (`planHarbour`), the
 * anchor window along the coastline of an anchorage or mooring field (`planAnchorWindow`), never lower than the
 * height of `zoom` (the title zoom the imagery allows); without such a camera, and for every view an admin asked for,
 * the camera-3 rule (`planRender` at `zoom`). The plan of a run and the job both call this, so their keys agree.
 */
export async function planView(
  db: Db,
  input: PlaceImageInput,
  view: { slot: string; zoom?: ZoomLevel; azimuthDeg?: number },
  zoom: ZoomLevel,
  cfg: Pick<ImagesConfig, "camera" | "composition">,
): Promise<RenderPlan> {
  if (view.zoom === undefined && view.azimuthDeg === undefined) {
    const harbour = input.kind === "marina" || input.kind === "port";
    const camera = harbour ? await planHarbour(db, input, zoom, cfg) : (await planAnchorWindow(db, input, zoom, cfg))?.camera ?? null;
    if (camera) return { ok: true, camera };
  }
  return planRender(db, input, zoom, cfg, view.azimuthDeg ?? null);
}
