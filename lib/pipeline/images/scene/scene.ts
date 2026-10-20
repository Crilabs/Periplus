/**
 * The terrain scene of a place render (spec 13), run in headless Chromium: bundled with three.js into
 * `scene.bundle.ts` by `scripts/build-render-scene.ts` (`npm run images:scene`) and injected into an empty page. It
 * loads nothing; `render.ts` hands everything over as base64. Defines `window.periplusRender`.
 *
 * Local metres around the camera target (x east, y north, z up; `kx = 111320 cos(lat)`, `ky = 110540`). Two terrain
 * meshes: the wide window (Sentinel-2) sunk by `sinkM` under the core window, and the core window (aerial mosaic, its
 * white no-data border replaced by Sentinel-2). A sea plane at −0.4 m under both. The photo pass is lit like the
 * tested PyVista scene (headlight, ambient 0.6, diffuse 0.5) under a sky gradient; the mask pass is unlit and without
 * antialiasing: water 255, land 0, sky 128.
 */
import {
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  Color,
  ColorManagement,
  LinearMipmapLinearFilter,
  LinearSRGBColorSpace,
  Mesh,
  PerspectiveCamera,
  PlaneGeometry,
  Scene,
  ShaderMaterial,
  Vector3,
  WebGLRenderer,
  type Texture,
} from "three";
import type { SceneCamera, SceneGrid, SceneInput, SceneOutput } from "./types";

const KY = 110_540;
const SEA_Z = -0.4;
const NEAR = 1;
const FAR = 80_000;
const AMBIENT = 0.6;
const DIFFUSE = 0.5;
const SKY_BOTTOM = "#a9cbe8";
const SKY_TOP = "#5b97d3";
const SEA = "#245f8c";
const MASK_SKY = 128 / 255;
/** Wide-grid cells inside the core edge that stay at full height, so the two meshes meet without a gap. */
const SINK_INSET_CELLS = 2;
/** Largest texture side used, whatever the GPU allows. */
const MAX_TEXTURE_PX = 8192;

// Colours and textures pass through unconverted, as in the PyVista reference: what the aerial image shows is drawn.
ColorManagement.enabled = false;

type Frame = { lon: number; lat: number; kx: number };

function bytesOf(base64: string): Uint8Array {
  const bin = atob(base64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function heightsOf(grid: SceneGrid): Float32Array {
  const bytes = bytesOf(grid.heightsBase64);
  return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
}

async function bitmapOf(base64: string): Promise<ImageBitmap> {
  return createImageBitmap(new Blob([bytesOf(base64) as BlobPart]));
}

function canvas2d(width: number, height: number): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("no 2d context");
  return { canvas, ctx };
}

function textureOf(canvas: HTMLCanvasElement): Texture {
  const texture = new CanvasTexture(canvas);
  texture.minFilter = LinearMipmapLinearFilter;
  texture.colorSpace = LinearSRGBColorSpace;
  return texture;
}

/**
 * The grid as a triangle mesh in local metres with texture coordinates over its bbox and a per-vertex `water`
 * attribute (height ≤ 0). `sink` lowers the nodes inside a box by `sinkM` (water stays as the unsunk height says).
 */
function gridGeometry(grid: SceneGrid, frame: Frame, sink?: { bbox: SceneGrid["bbox"]; sinkM: number }): BufferGeometry {
  const { cols, rows, bbox } = grid;
  const [west, south, east, north] = bbox;
  const heights = heightsOf(grid);
  const position = new Float32Array(cols * rows * 3);
  const uv = new Float32Array(cols * rows * 2);
  const water = new Float32Array(cols * rows);
  const dLon = (east - west) / (cols - 1);
  const dLat = (north - south) / (rows - 1);
  const inset = sink && {
    west: sink.bbox[0] + SINK_INSET_CELLS * dLon,
    south: sink.bbox[1] + SINK_INSET_CELLS * dLat,
    east: sink.bbox[2] - SINK_INSET_CELLS * dLon,
    north: sink.bbox[3] - SINK_INSET_CELLS * dLat,
  };
  for (let i = 0; i < rows; i++) {
    const lat = south + i * dLat;
    for (let j = 0; j < cols; j++) {
      const lon = west + j * dLon;
      const k = i * cols + j;
      const h = heights[k]!;
      const sunk = inset && lon > inset.west && lon < inset.east && lat > inset.south && lat < inset.north;
      position[k * 3] = (lon - frame.lon) * frame.kx;
      position[k * 3 + 1] = (lat - frame.lat) * KY;
      position[k * 3 + 2] = sunk ? h - sink.sinkM : h;
      uv[k * 2] = j / (cols - 1);
      uv[k * 2 + 1] = i / (rows - 1);
      water[k] = h <= 0 ? 1 : 0;
    }
  }
  const index = new Uint32Array((cols - 1) * (rows - 1) * 6);
  let n = 0;
  for (let i = 0; i < rows - 1; i++) {
    for (let j = 0; j < cols - 1; j++) {
      const a = i * cols + j;
      const b = a + 1;
      const c = a + cols;
      const d = c + 1;
      // counter-clockwise seen from above: normals point up
      index.set([a, b, c, b, d, c], n);
      n += 6;
    }
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new BufferAttribute(position, 3));
  geometry.setAttribute("uv", new BufferAttribute(uv, 2));
  geometry.setAttribute("water", new BufferAttribute(water, 1));
  geometry.setIndex(new BufferAttribute(index, 1));
  geometry.computeVertexNormals();
  return geometry;
}

/**
 * The aerial mosaic of the core window: the tiles drawn onto a white canvas over `core.bbox`, at the finest tile
 * resolution (capped). White no-data (every channel ≥ `whiteThreshold`) connected to the border, or to an area no
 * tile covers, is replaced by the Sentinel-2 image of the same place.
 */
async function coreMosaic(input: SceneInput, wide: ImageBitmap, maxTexturePx: number): Promise<HTMLCanvasElement> {
  const [west, south, east, north] = input.core.bbox;
  const tiles = await Promise.all(input.coreTextures.map(async (t) => ({ bbox: t.bbox, image: await bitmapOf(t.base64) })));
  let pxPerLon = 0;
  let pxPerLat = 0;
  for (const t of tiles) {
    pxPerLon = Math.max(pxPerLon, t.image.width / (t.bbox[2] - t.bbox[0]));
    pxPerLat = Math.max(pxPerLat, t.image.height / (t.bbox[3] - t.bbox[1]));
  }
  // Without tiles the whole core shows Sentinel-2, at its own resolution.
  const [wWest, wSouth, wEast, wNorth] = input.wide.bbox;
  if (tiles.length === 0) {
    pxPerLon = wide.width / (wEast - wWest);
    pxPerLat = wide.height / (wNorth - wSouth);
  }
  const cap = Math.min(MAX_TEXTURE_PX, maxTexturePx);
  const width = Math.max(1, Math.min(cap, Math.ceil((east - west) * pxPerLon)));
  const height = Math.max(1, Math.min(cap, Math.ceil((north - south) * pxPerLat)));

  const { canvas, ctx } = canvas2d(width, height);
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);
  const covered = new Uint8Array(width * height);
  for (const t of tiles) {
    const x0 = ((t.bbox[0] - west) / (east - west)) * width;
    const x1 = ((t.bbox[2] - west) / (east - west)) * width;
    const y0 = ((north - t.bbox[3]) / (north - south)) * height;
    const y1 = ((north - t.bbox[1]) / (north - south)) * height;
    ctx.drawImage(t.image, x0, y0, x1 - x0, y1 - y0);
    for (let y = Math.max(0, Math.ceil(y0)); y < Math.min(height, Math.floor(y1)); y++) {
      covered.fill(1, y * width + Math.max(0, Math.ceil(x0)), y * width + Math.min(width, Math.floor(x1)));
    }
  }

  const { ctx: s2 } = canvas2d(width, height);
  const sx = ((west - wWest) / (wEast - wWest)) * wide.width;
  const sy = ((wNorth - north) / (wNorth - wSouth)) * wide.height;
  const sw = ((east - west) / (wEast - wWest)) * wide.width;
  const sh = ((north - south) / (wNorth - wSouth)) * wide.height;
  s2.drawImage(wide, sx, sy, sw, sh, 0, 0, width, height);
  const fill = s2.getImageData(0, 0, width, height).data;

  const image = ctx.getImageData(0, 0, width, height);
  const px = image.data;
  const isWhite = (k: number) =>
    px[k * 4]! >= input.whiteThreshold && px[k * 4 + 1]! >= input.whiteThreshold && px[k * 4 + 2]! >= input.whiteThreshold;
  // flood fill over white pixels, seeded at the border and in every uncovered pixel
  const replace = new Uint8Array(width * height);
  const stack = new Int32Array(width * height);
  let top = 0;
  const seed = (k: number) => {
    if (replace[k] || !isWhite(k)) return;
    replace[k] = 1;
    stack[top++] = k;
  };
  for (let x = 0; x < width; x++) {
    seed(x);
    seed((height - 1) * width + x);
  }
  for (let y = 0; y < height; y++) {
    seed(y * width);
    seed(y * width + width - 1);
  }
  for (let k = 0; k < width * height; k++) if (!covered[k]) seed(k);
  while (top > 0) {
    const k = stack[--top]!;
    const x = k % width;
    if (x > 0) seed(k - 1);
    if (x < width - 1) seed(k + 1);
    if (k >= width) seed(k - width);
    if (k < width * (height - 1)) seed(k + width);
  }
  for (let k = 0; k < width * height; k++) {
    if (!replace[k]) continue;
    px[k * 4] = fill[k * 4]!;
    px[k * 4 + 1] = fill[k * 4 + 1]!;
    px[k * 4 + 2] = fill[k * 4 + 2]!;
  }
  ctx.putImageData(image, 0, 0);
  return canvas;
}

function wideCanvas(wide: ImageBitmap): HTMLCanvasElement {
  const { canvas, ctx } = canvas2d(wide.width, wide.height);
  ctx.drawImage(wide, 0, 0);
  return canvas;
}

const TERRAIN_VERTEX = /* glsl */ `
  attribute float water;
  varying vec2 vUv;
  varying vec3 vNormal;
  varying float vWater;
  void main() {
    vUv = uv;
    vNormal = normal;
    vWater = water;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }`;

const PHOTO_FRAGMENT = /* glsl */ `
  uniform sampler2D map;
  uniform vec3 toLight;
  varying vec2 vUv;
  varying vec3 vNormal;
  void main() {
    float diffuse = max(dot(normalize(vNormal), toLight), 0.0);
    gl_FragColor = vec4(texture2D(map, vUv).rgb * (${AMBIENT.toFixed(2)} + ${DIFFUSE.toFixed(2)} * diffuse), 1.0);
  }`;

const MASK_FRAGMENT = /* glsl */ `
  varying float vWater;
  void main() {
    gl_FragColor = vec4(vec3(vWater > 0.5 ? 1.0 : 0.0), 1.0);
  }`;

const FLAT_VERTEX = /* glsl */ `
  void main() {
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }`;

/**
 * The sea plane at −0.4 m in `colour`. Nothing lies below it but the sunk part of the wide mesh, which the core mesh
 * covers anyway, so it is drawn first and without depth: a plane of hundreds of kilometres clipped at the near plane
 * gets depths too coarse to keep it under terrain at 0 m (SwiftShader drew it over all water).
 */
function sea(geometry: BufferGeometry, colour: Color): Mesh {
  const mesh = new Mesh(
    geometry,
    new ShaderMaterial({
      vertexShader: FLAT_VERTEX,
      fragmentShader: `uniform vec3 colour; void main() { gl_FragColor = vec4(colour, 1.0); }`,
      uniforms: { colour: { value: colour } },
      depthWrite: false,
    }),
  );
  mesh.renderOrder = -1;
  return mesh;
}

/** Full-screen gradient from `SKY_BOTTOM` to `SKY_TOP`, drawn behind everything. */
function sky(): Mesh {
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
  const mesh = new Mesh(
    geometry,
    new ShaderMaterial({
      vertexShader: `varying float vY; void main() { vY = position.y * 0.5 + 0.5; gl_Position = vec4(position.xy, 1.0, 1.0); }`,
      fragmentShader: `uniform vec3 bottom; uniform vec3 top; varying float vY; void main() { gl_FragColor = vec4(mix(bottom, top, vY), 1.0); }`,
      uniforms: { bottom: { value: new Color(SKY_BOTTOM) }, top: { value: new Color(SKY_TOP) } },
      depthTest: false,
      depthWrite: false,
    }),
  );
  mesh.frustumCulled = false;
  mesh.renderOrder = -2;
  return mesh;
}

/** Camera at `distanceM` from the target (origin) along `azimuthDeg`, `heightM` up, looking back down by `tiltDeg`. */
function perspective(c: SceneCamera): PerspectiveCamera {
  const az = (c.azimuthDeg * Math.PI) / 180;
  const tilt = (c.tiltDeg * Math.PI) / 180;
  const camera = new PerspectiveCamera(c.fovDeg, c.width / c.height, NEAR, FAR);
  camera.up.set(0, 0, 1);
  camera.position.set(Math.sin(az) * c.distanceM, Math.cos(az) * c.distanceM, c.heightM);
  const view = new Vector3(-Math.sin(az) * Math.cos(tilt), -Math.cos(az) * Math.cos(tilt), -Math.sin(tilt));
  camera.lookAt(camera.position.clone().add(view));
  camera.updateMatrixWorld();
  return camera;
}

function renderer(c: SceneCamera, antialias: boolean): WebGLRenderer {
  const r = new WebGLRenderer({ antialias, preserveDrawingBuffer: true, alpha: false });
  r.outputColorSpace = LinearSRGBColorSpace;
  r.setPixelRatio(1);
  r.setSize(c.width, c.height, false);
  return r;
}

async function render(input: SceneInput): Promise<SceneOutput> {
  const c = input.camera;
  const frame: Frame = { lon: c.target[0], lat: c.target[1], kx: 111_320 * Math.cos((c.target[1] * Math.PI) / 180) };
  const camera = perspective(c);
  const toLight = new Vector3();
  camera.getWorldDirection(toLight).negate(); // headlight

  const wideGeometry = gridGeometry(input.wide, frame, { bbox: input.core.bbox, sinkM: input.sinkM });
  const coreGeometry = gridGeometry(input.core, frame);
  const [w, s, e, n] = input.wide.bbox;
  const big = 10 * Math.max((e - w) * frame.kx, (n - s) * KY);
  const seaGeometry = new PlaneGeometry(big, big);
  seaGeometry.translate(0, 0, SEA_Z);

  // photo
  const photoRenderer = renderer(c, true);
  const wideImage = await bitmapOf(input.wideTextureBase64);
  const wideTexture = textureOf(wideCanvas(wideImage));
  const coreTexture = textureOf(await coreMosaic(input, wideImage, photoRenderer.capabilities.maxTextureSize));
  const lit = (map: Texture) =>
    new ShaderMaterial({
      vertexShader: TERRAIN_VERTEX,
      fragmentShader: PHOTO_FRAGMENT,
      uniforms: { map: { value: map }, toLight: { value: toLight } },
    });
  const photoScene = new Scene();
  photoScene.add(sky(), sea(seaGeometry, new Color(SEA)), new Mesh(wideGeometry, lit(wideTexture)), new Mesh(coreGeometry, lit(coreTexture)));
  photoRenderer.render(photoScene, camera);
  const photo = photoRenderer.domElement.toDataURL("image/png");

  // mask
  const maskRenderer = renderer(c, false);
  maskRenderer.setClearColor(new Color(MASK_SKY, MASK_SKY, MASK_SKY), 1);
  const waterMaterial = new ShaderMaterial({ vertexShader: TERRAIN_VERTEX, fragmentShader: MASK_FRAGMENT });
  const maskScene = new Scene();
  maskScene.add(sea(seaGeometry, new Color(1, 1, 1)), new Mesh(wideGeometry, waterMaterial), new Mesh(coreGeometry, waterMaterial));
  maskRenderer.render(maskScene, camera);
  const mask = maskRenderer.domElement.toDataURL("image/png");

  photoRenderer.dispose();
  maskRenderer.dispose();
  return { photo, mask };
}

window.periplusRender = render;
