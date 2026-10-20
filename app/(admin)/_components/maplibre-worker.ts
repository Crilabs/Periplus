import { setWorkerUrl } from "maplibre-gl";

/*
 * MapLibre resolves its worker as `./maplibre-gl-worker.mjs` next to its own module URL. Bundled by Turbopack, that file
 * does not exist beside the chunk, the worker fails to load and the map stays blank. Referencing the worker through
 * `new URL(…, import.meta.url)` makes the bundler emit it as an asset of the installed version; MapLibre then loads it
 * from there. Import this module before creating a map.
 */
if (typeof window !== "undefined") {
  setWorkerUrl(new URL("../../../node_modules/maplibre-gl/dist/maplibre-gl-worker.mjs", import.meta.url).href);
}
