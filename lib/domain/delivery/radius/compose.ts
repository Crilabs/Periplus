import { SCHEMA_VERSION, type Manifest } from "@/contract";
import type { DeliveryConfig } from "@/lib/config";
import { distanceNm } from "../geo";
import { circleBbox, circlePolygon, regionTouchesCircle, tileTouchesCircle } from "./geometry";
import type { ComposedRadius, RadiusInput, SourcePackage } from "./types";

/*
 * Composes a radius package from the current valid subdivision packages (spec 18, "Was im Paket steht", "Woraus es
 * gebaut wird", "Lücken"). Pure: every object is taken as it stands in one of the packages; only `spotIds` of
 * highlights and regions are united over all versions and trimmed to the included spots. Coast, file list and object
 * counts are added by the build after clipping and serialising.
 */

type Versioned = { id: string; profileVersion?: number; spotIds?: string[] };

/** One object over all packages: the version taken, the package it came from, the united `spotIds`. */
type Merged<T> = { value: T; from: SourcePackage; spotIds: string[] };

const byId = <T extends { id: string }>(a: T, b: T) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** JSON with sorted keys: equal for equal content regardless of key order (absent and undefined alike). */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v,
  );
}

/** The content compared between versions: everything but `spotIds`, `profileVersion` and `validFrom`. */
function content(o: Versioned & { validFrom?: string }): string {
  return canonical({ ...o, spotIds: undefined, profileVersion: undefined, validFrom: undefined });
}

/**
 * Each object once: the version with the higher `profileVersion`, on a tie the one from the younger package. Versions
 * that differ beyond `spotIds`, `profileVersion` and `validFrom` add one warning per object.
 */
function merge<T extends Versioned>(
  packages: SourcePackage[],
  pick: (p: SourcePackage) => T[],
  warnings: string[],
): Map<string, Merged<T>> {
  const versions = new Map<string, Array<{ value: T; from: SourcePackage }>>();
  for (const from of packages) {
    for (const value of pick(from)) versions.set(value.id, [...(versions.get(value.id) ?? []), { value, from }]);
  }
  const out = new Map<string, Merged<T>>();
  for (const [id, list] of versions) {
    const sorted = [...list].sort(
      (a, b) =>
        (b.value.profileVersion ?? 0) - (a.value.profileVersion ?? 0) ||
        Date.parse(b.from.generatedAt) - Date.parse(a.from.generatedAt),
    );
    const [taken] = sorted as [(typeof sorted)[number], ...typeof sorted];
    const spotIds = [...new Set(sorted.flatMap((v) => v.value.spotIds ?? []))];
    if (sorted.some((v) => content(v.value) !== content(taken.value))) {
      const keys = sorted.map((v) => v.from.coverage.key).join(", ");
      warnings.push(`${id}: versions differ between subdivision packages (${keys}); took the one from ${taken.from.coverage.key}`);
    }
    out.set(id, { value: taken.value, from: taken.from, spotIds });
  }
  return out;
}

export function composeRadiusPackage(input: RadiusInput, cfg: DeliveryConfig): ComposedRadius {
  const { packages, radiusNm: r, homeMarina } = input;
  const center = homeMarina.position;
  const inCircle = (p: { lat: number; lon: number }, margin = 0) => distanceNm(center, p) <= r + margin;
  const warnings: string[] = [];

  const spots = merge(packages, (p) => p.spots, warnings);
  const highlights = merge(packages, (p) => p.highlights, warnings);
  const regions = merge(packages, (p) => p.regions, warnings);
  const points = merge(packages, (p) => p.weatherPoints, warnings);

  // spots: position in the circle
  const keptSpots = [...spots.values()].filter((m) => inCircle(m.value.position));
  const spotIn = new Set(keptSpots.map((m) => m.value.id));
  const trim = (ids: string[]) => ids.filter((id) => spotIn.has(id));

  // highlights: assigned to an included spot, or in the circle
  const keptHighlights = [...highlights.values()].filter((m) => m.spotIds.some((id) => spotIn.has(id)) || inCircle(m.value.position));

  // regions: touching the circle, every region of an included spot or highlight, and their parent chains
  const regionIn = new Set<string>();
  const queue = [
    ...[...regions.values()].filter((m) => regionTouchesCircle(m.value, center, r)).map((m) => m.value.id),
    ...[...keptSpots, ...keptHighlights].flatMap((m) => (m.value.regionId ? [m.value.regionId] : [])),
  ];
  for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
    if (regionIn.has(id)) continue;
    const region = regions.get(id);
    if (!region) {
      warnings.push(`${id}: referenced but in no subdivision package`);
      continue;
    }
    regionIn.add(id);
    if (region.value.parentId) queue.push(region.value.parentId);
  }
  const keptRegions = [...regionIn].map((id) => regions.get(id)!);

  // weather points: in the circle plus the coast margin, region none or included
  const keptPoints = [...points.values()].filter(
    (m) => inCircle(m.value.position, cfg.coast.marginNm) && (m.value.regionId === null || regionIn.has(m.value.regionId)),
  );

  const envelope = { schemaVersion: SCHEMA_VERSION, scope: { type: "radius", key: input.key }, generatedAt: input.generatedAt } as const;
  return {
    manifestDraft: {
      schemaVersion: SCHEMA_VERSION,
      scope: {
        type: "radius",
        key: input.key,
        homeMarina: { id: homeMarina.id, name: homeMarina.name },
        center,
        days: input.days,
        radiusNm: r,
        circle: circlePolygon(center, r),
      },
      coverage: [...packages.map((p) => p.coverage), ...input.missing].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)),
      areas: mergeAreas(packages),
      generatedAt: input.generatedAt,
      bbox: circleBbox(center, r),
      tiles: mergeTiles(input),
      licenses: mergeLicenses(packages),
    },
    files: {
      "spots.json": { ...envelope, spots: keptSpots.map((m) => m.value).sort(byId) },
      "highlights.json": { ...envelope, highlights: keptHighlights.map((m) => ({ ...m.value, spotIds: trim(m.spotIds) })).sort(byId) },
      "regions.json": { ...envelope, regions: keptRegions.map((m) => ({ ...m.value, spotIds: trim(m.spotIds) })).sort(byId) },
      "weather-points.json": { ...envelope, points: keptPoints.map((m) => m.value).sort(byId) },
    },
    imageFiles: imagesOf([...keptSpots, ...keptHighlights]),
    warnings,
  };
}

/** The images of the included spots and highlights (`images/<id>-<slot>.jpg`), from the package their version came from. */
function imagesOf(kept: Array<Merged<{ id: string }>>): SourcePackage["imageFiles"] {
  return kept
    .flatMap((m) => m.from.imageFiles.filter((f) => f.name.startsWith(`images/${m.value.id}-`)))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** The packages' tiles whose cell touches the circle (the most recent run per tile), plus the missing tiles without a run. */
function mergeTiles(input: RadiusInput): Manifest["tiles"] {
  const center = input.homeMarina.position;
  const tiles = new Map<string, Manifest["tiles"][number]>();
  for (const tile of input.packages.flatMap((p) => p.tiles)) {
    if (!tileTouchesCircle(tile.id, center, input.radiusNm)) continue;
    const seen = tiles.get(tile.id);
    if (!seen || (tile.lastRunAt ?? "") > (seen.lastRunAt ?? "")) tiles.set(tile.id, tile);
  }
  for (const id of input.missingTiles) if (!tiles.has(id)) tiles.set(id, { id, lastRunAt: null, profilesAsOf: null });
  return [...tiles.values()].sort(byId);
}

function mergeAreas(packages: SourcePackage[]): Manifest["areas"] {
  const areas = new Map<string, Manifest["areas"][number]>();
  for (const area of packages.flatMap((p) => p.areas)) if (!areas.has(area.id)) areas.set(area.id, area);
  return [...areas.values()].sort(byId);
}

/** Licences by name, `files` and `fields` united in order of appearance. */
function mergeLicenses(packages: SourcePackage[]): Manifest["licenses"] {
  const licenses = new Map<string, Manifest["licenses"][number]>();
  for (const license of packages.flatMap((p) => p.licenses)) {
    const seen = licenses.get(license.name);
    licenses.set(
      license.name,
      seen
        ? { ...seen, files: [...new Set([...seen.files, ...license.files])], fields: [...new Set([...seen.fields, ...license.fields])] }
        : license,
    );
  }
  return [...licenses.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}
