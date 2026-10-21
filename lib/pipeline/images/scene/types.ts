import type { Bbox } from "@/lib/domain/images/window";

/** A height grid as the browser scene gets it: the `Float32Array` of heights as base64 (little-endian). */
export type SceneGrid = { bbox: Bbox; cols: number; rows: number; heightsBase64: string };

/** The camera of the scene (the fields of `RenderCamera` the scene uses). */
export type SceneCamera = {
  target: [lon: number, lat: number];
  azimuthDeg: number;
  distanceM: number;
  heightM: number;
  tiltDeg: number;
  fovDeg: number;
  width: number;
  height: number;
};

/** Everything `window.periplusRender` needs; images as base64 (PNG or JPEG), nothing is loaded from a URL. */
export type SceneInput = {
  camera: SceneCamera;
  wide: SceneGrid;
  core: SceneGrid;
  /** Satellite image covering exactly `wide.bbox`. */
  wideTextureBase64: string;
  /** Aerial tiles of the core window, each covering its `bbox`. */
  coreTextures: Array<{ bbox: Bbox; base64: string }>;
  whiteThreshold: number;
  sinkM: number;
};

/** Both images as `data:image/png;base64,…` URLs. */
export type SceneOutput = { photo: string; mask: string };

declare global {
  interface Window {
    /** Set by the scene bundle. */
    periplusRender?: (input: SceneInput) => Promise<SceneOutput>;
  }
}
