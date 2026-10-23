import type { ResearchConfig } from "@/lib/config";
import type { Bbox } from "@/lib/domain/tiles";

/*
 * The two rings of the stage `gazetteer.land` around the research candidates (N7 4.4, 4.6). Pure.
 */

/** A research candidate as ring center: its anchor position, else its place position. */
export type RingCenter = { placeId: string; lon: number; lat: number };

/** Mean earth radius (IUGG), as `withinRing` measures. */
const EARTH_RADIUS_M = 6_371_008.8;
/** Metres per degree of latitude on that sphere. */
const M_PER_DEG = (EARTH_RADIUS_M * Math.PI) / 180;
const rad = (deg: number) => (deg * Math.PI) / 180;

/**
 * The ring radii derived from N4a (`research.state`), so the loaded surroundings are never smaller than what N4a looks
 * for: near = margin + landing radius + foot distance, far = margin + landing radius + transport distance. N4a counts
 * the straight line times `detourFactor`, so these straight lines are upper bounds. `marginM` covers the extent of the
 * anchor area around the candidate point.
 */
export function landRings(state: ResearchConfig["state"], marginM: number): { nearM: number; farM: number } {
  return {
    nearM: marginM + state.landingRadiusM + state.footMaxM,
    farM: marginM + state.landingRadiusM + state.transportMaxM,
  };
}

/** Great-circle distance in metres (haversine). */
export function distanceM(a: { lon: number; lat: number }, b: { lon: number; lat: number }): number {
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Whether `point` lies within `radiusM` of at least one center. */
export function withinRing(point: { lon: number; lat: number }, centers: RingCenter[], radiusM: number): boolean {
  return centers.some((c) => distanceM(point, c) <= radiusM);
}

/** Edge lengths in km of a box (east-west at the latitude nearest the equator, the longest). */
function extentKm([west, south, east, north]: Bbox): { widthKm: number; heightKm: number } {
  const lat = south <= 0 && north >= 0 ? 0 : Math.min(Math.abs(south), Math.abs(north));
  return { widthKm: ((east - west) * M_PER_DEG * Math.cos(rad(lat))) / 1000, heightKm: ((north - south) * M_PER_DEG) / 1000 };
}

/**
 * The query boxes of a ring: the centers, sorted by longitude then latitude, are grouped greedily, each into the first
 * group whose box stays at most `maxBoxKm` on each edge with it, else into a new one; every group box is then widened
 * by `radiusM` on each side (longitude degrees at the box's latitude farthest from the equator), so it covers the whole
 * ring of each of its centers. Every center belongs to exactly one box. No centers, no boxes.
 */
export function ringBoxes(centers: RingCenter[], radiusM: number, maxBoxKm: number): Bbox[] {
  const sorted = [...centers].sort((a, b) => a.lon - b.lon || a.lat - b.lat || (a.placeId < b.placeId ? -1 : 1));
  const groups: Bbox[] = [];
  for (const c of sorted) {
    const i = groups.findIndex(([w, s, e, n]) => {
      const { widthKm, heightKm } = extentKm([Math.min(w, c.lon), Math.min(s, c.lat), Math.max(e, c.lon), Math.max(n, c.lat)]);
      return widthKm <= maxBoxKm && heightKm <= maxBoxKm;
    });
    if (i < 0) {
      groups.push([c.lon, c.lat, c.lon, c.lat]);
    } else {
      const [w, s, e, n] = groups[i]!;
      groups[i] = [Math.min(w, c.lon), Math.min(s, c.lat), Math.max(e, c.lon), Math.max(n, c.lat)];
    }
  }
  return groups.map(([w, s, e, n]) => {
    const dLat = radiusM / M_PER_DEG;
    const farLat = Math.min(89, Math.max(Math.abs(s - dLat), Math.abs(n + dLat)));
    const dLon = radiusM / (M_PER_DEG * Math.cos(rad(farLat)));
    return [w - dLon, s - dLat, e + dLon, n + dLat];
  });
}
