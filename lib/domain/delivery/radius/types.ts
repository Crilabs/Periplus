import type {
  CoverageEntry,
  Highlight,
  HighlightsFile,
  Manifest,
  Region,
  RegionsFile,
  Spot,
  SpotsFile,
  WeatherPoint,
  WeatherPointsFile,
} from "@/contract";

/*
 * Input and output of `composeRadiusPackage` (spec 18, "Woraus es gebaut wird"): the current valid packages of the
 * subdivisions the circle touches, already read, and the radius package composed from them (without coast, file list
 * and counts, which the build adds after clipping and serialising).
 */

/** One subdivision's current valid package, as read from the archive. */
export type SourcePackage = {
  coverage: CoverageEntry & { status: "delivered" };
  generatedAt: string;
  spots: Spot[];
  highlights: Highlight[];
  regions: Region[];
  weatherPoints: WeatherPoint[];
  tiles: Manifest["tiles"];
  areas: Manifest["areas"];
  licenses: Manifest["licenses"];
  imageFiles: Array<{ name: string; sha256: string; bytes: number }>;
};

export type RadiusInput = {
  /** The radius package's key (hash over the subdivision versions). */
  key: string;
  homeMarina: Spot;
  days: number;
  radiusNm: number;
  generatedAt: string;
  packages: SourcePackage[];
  /** Touched subdivisions without a valid package. */
  missing: Array<CoverageEntry & { status: "missing" }>;
  /** Tiles in the circle from subdivisions without a package. */
  missingTiles: string[];
};

export type ComposedRadius = {
  manifestDraft: Omit<Manifest, "files" | "objectCounts">;
  files: {
    "spots.json": SpotsFile;
    "highlights.json": HighlightsFile;
    "regions.json": RegionsFile;
    "weather-points.json": WeatherPointsFile;
  };
  imageFiles: SourcePackage["imageFiles"];
  /** Shared objects whose versions differ beyond `spotIds`, `profileVersion` and `validFrom`; the build does not fail. */
  warnings: string[];
};
