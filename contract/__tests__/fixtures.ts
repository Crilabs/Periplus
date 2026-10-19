import type { Spot, SpotsFile } from "@/contract";

/**
 * The example spot of `.idea/datendienst-spec.md` Teil B, adapted to v1: `regionId` and the highlight id are
 * shortened/illustrative in Teil B and get valid 26-character ULIDs here (Teil B's `hl_…5F` holds an `L`, which is
 * no Crockford base-32 character).
 */
export const TEIL_B_EXAMPLE: Spot = {
  id: "sp_01J9X4K2M7Q8R5T6V7W8X9Y0Z1",
  kind: "anchorage",
  name: "Ormos Vathi",
  names: [
    { lang: "el", name: "Όρμος Βαθύ", script: "greek" },
    { lang: "en", name: "Vathi Bay", script: "latin" },
  ],
  position: { lat: 37.60812, lon: 23.33945 },
  anchorPosition: { lat: 37.6074, lon: 23.3389, confidence: 0.6, source: "computed" },
  shelter: {
    sectors: { N: 0.9, NE: 0.8, E: 0.4, SE: 0.1, S: 0.2, SW: 0.7, W: 0.9, NW: 0.95 },
    swell: 0.5,
    source: "computed+text",
  },
  depth: { min: 2, max: 14, anchoring: { min: 4, max: 8 }, confidence: 0.7, source: "computed+text" },
  seabed: [
    { type: "sand", share: 0.7 },
    { type: "weed", share: 0.3 },
  ],
  holding: "good",
  limits: { maxDraft: null, maxLength: null, capacity: 8 },
  mooring: { types: ["anchor", "lineAshore"], buoys: 0, lineAshoreRequired: false },
  services: {
    water: "no",
    electricity: "no",
    fuel: "no",
    showers: "no",
    shop: "no",
    taverna: "seasonal",
    wifi: "unknown",
    dinghyLanding: "yes",
  },
  berth: { status: "unknown", months: [], sourcesCount: 0, bookable: false },
  occupancy: [
    { month: 7, level: "full" },
    { month: 8, level: "full" },
    { month: 9, level: "moderate" },
  ],
  exclude: { excluded: false, reason: null, detail: null },
  hazards: [{ kind: "gusts", text: "Fallböen bei Meltemi aus NO" }],
  seasonNote: [{ months: [6, 7, 8, 9], text: "Taverne am Strand geöffnet, Dinghy-Steg" }],
  score: { confidence: 0.72, popularity: 0.55, quietness: 0.8, sourcesCount: 6, lastObserved: "2026-06-14" },
  highlightIds: ["hl_01J9X4KQ3P2N1M0Z9K8J7H6G5F"],
  externalRefs: { googlePlaceIds: { food: ["ChIJ..."] }, osmId: "way/123456789", wikidataId: null },
  summary: {
    de: "Tiefe Bucht mit gutem Schutz von West bis Nord, offen nach Südost. Sandgrund mit Seegras, 4 bis 8 m. In der Saison Taverne mit Dinghy-Steg; im Hochsommer abends voll.",
  },
  sources: [
    { url: "https://example-toernbericht.de/saronisch-2025", kind: "tripReport", observedAt: "2025-06-10" },
    { url: "https://example-revierfuehrer.com/vathi", kind: "pilotGuide", observedAt: "2024-01-01" },
  ],
  provenance: {
    shelter: { source: "computed", confidence: 0.8, observedAt: "2026-10-01" },
    depth: { source: "text", confidence: 0.7, observedAt: "2025-06-10" },
    "services.taverna": { source: "text", confidence: 0.9, observedAt: "2026-06-14" },
  },
  regionId: "rg_01J9X4KZ0A1B2C3D4E5F6G7H8J",
  profileVersion: 3,
  validFrom: "2026-10-15",
  mergedInto: null,
};

export function spotsFile(spots: unknown[]): SpotsFile {
  return {
    schemaVersion: "1.0",
    area: "ar_01J9X4M0A1B2C3D4E5F6G7H8J9",
    dataVersion: 1,
    generatedAt: "2026-10-19T08:00:00.000Z",
    spots: spots as Spot[],
  };
}
