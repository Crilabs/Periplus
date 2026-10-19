import { readFile } from "node:fs/promises";
import { and, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "@/lib/db/client";
import { comparisonSet, externalCalls, places, runs, runStages, type SeabedType } from "@/lib/db/schema";
import { latestComputations, type StoredComputation } from "@/lib/domain/facts/computations";
import { SECTORS, type Sector } from "@/lib/domain/facts/schema-types";
import { displayNameSql } from "@/lib/domain/gazetteer/names";
import type { Gap, GapReason } from "@/lib/domain/geometry/gaps";
import type { LonLat } from "@/lib/domain/geometry/water";
import { DATASETS_STAGE } from "@/lib/pipeline/datasets";
import { GEOMETRY_STAGE, geometryPlaceIds } from "@/lib/pipeline/geometry";
import { areaGeoObjectId } from "@/lib/pipeline/tile-scope";

// Grundprinzip 9: Navily values are read at runtime only. Nothing in this module writes them anywhere; the report
// carries Periplus names and ids plus aggregated agreement, never a Navily name, id, url or value.

/** Defaults of the spot check (spec 04: Stichprobe gegen Navily). */
export const NAVILY_SAMPLE_DEFAULTS = {
  radiusM: 500,
  protectedThreshold: 0.5,
  /** Own seabed types below this share do not count as the place's seabed. */
  seabedMinShare: 0.3,
  /** Spec 04: the sample covers 20 places. */
  minPlaces: 20,
} as const;

/** The only fields read from a Navily spot; zod drops all others. */
export type NavilySpot = { lat: number; lon: number; prot: string[] | null; seabeds: string[] | null };

const spotSchema = z.object({
  lat: z.number(),
  lon: z.number(),
  prot: z.array(z.string()).nullable().optional().transform((v) => v ?? null),
  seabeds: z.array(z.string()).nullable().optional().transform((v) => v ?? null),
});

/** Reads the Navily spot file; never writes anything. */
export async function loadNavilySpots(path: string): Promise<NavilySpot[]> {
  const raw: unknown = JSON.parse(await readFile(path, "utf8"));
  return z.array(spotSchema).parse(raw);
}

export type OwnPlaceValues = {
  placeId: string;
  publicId: string | null;
  name: string;
  position: LonLat;
  shelter: Record<Sector, number> | null;
  seabed: SeabedType[] | null;
  depthGap: GapReason | null;
  hasDepth: boolean;
};

type Stored = Map<StoredComputation["kind"], StoredComputation>;

function factValue<T>(stored: Stored, kind: StoredComputation["kind"], attribute: string): T | null {
  return (stored.get(kind)?.facts.find((f) => f.attribute === attribute)?.value as T | undefined) ?? null;
}

function gapsOf(stored: Stored, kind: StoredComputation["kind"]): Gap[] {
  const gaps = stored.get(kind)?.outputs.gaps;
  return Array.isArray(gaps) ? (gaps as Gap[]) : [];
}

/** Own values of a place from the newest computation per kind of its geo object. */
function ownValuesOf(stored: Stored, minShare: number): Pick<OwnPlaceValues, "shelter" | "seabed" | "depthGap" | "hasDepth"> {
  const sectors = SECTORS.map((s) => factValue<number>(stored, "shelter", `shelter.${s}`));
  const shelter = sectors.every((v) => v !== null)
    ? (Object.fromEntries(SECTORS.map((s, i) => [s, sectors[i]!])) as Record<Sector, number>)
    : null;

  const shares = factValue<Array<{ type: SeabedType; share: number }>>(stored, "seabed", "seabed");
  const seabedTypes = shares?.filter((s) => s.share >= minShare).map((s) => s.type) ?? [];

  const hasDepth = factValue(stored, "depth", "depth.min") !== null || factValue(stored, "depth", "depth.approach") !== null;
  // Without a depth computation, the reason sits on the anchor area (`no_water`, `origin_unresolved`; M2-P13).
  const gap =
    gapsOf(stored, "depth").find((g) => g.attribute === "depth.min") ??
    gapsOf(stored, "depth").find((g) => g.attribute.startsWith("depth.")) ??
    (stored.has("depth") ? undefined : gapsOf(stored, "anchor_area").find((g) => g.reason === "no_water" || g.reason === "origin_unresolved"));

  return {
    shelter,
    seabed: seabedTypes.length > 0 ? seabedTypes : null,
    depthGap: hasDepth ? null : (gap?.reason ?? null),
    hasDepth,
  };
}

/**
 * The places of the area's comparison set that the geometry stage computes (`geometryPlaceIds`: valid, unmerged,
 * candidate/confirmed/no_anchoring), with the facts of their newest computations; `seabed` = types with a share ≥ 0.3.
 * An unknown area has no set: empty list.
 */
export async function ownValuesForComparisonSet(
  db: Db,
  areaKey: string,
  opts: { seabedMinShare?: number } = {},
): Promise<OwnPlaceValues[]> {
  const areaId = await areaGeoObjectId(db, areaKey);
  if (!areaId) return [];
  const members = await db.select({ placeId: comparisonSet.placeId }).from(comparisonSet).where(eq(comparisonSet.areaId, areaId));
  const ids = await geometryPlaceIds(db, { placeIds: members.map((m) => m.placeId) });
  if (ids.length === 0) return [];

  const rows = await db
    .select({
      placeId: places.id,
      publicId: places.publicId,
      geoObjectId: places.geoObjectId,
      name: displayNameSql(places.geoObjectId),
      lon: sql<number>`ST_X(${places.position})`,
      lat: sql<number>`ST_Y(${places.position})`,
    })
    .from(places)
    .where(inArray(places.id, ids));
  rows.sort((a, b) => (a.name ?? "").localeCompare(b.name ?? "") || a.placeId.localeCompare(b.placeId));

  const minShare = opts.seabedMinShare ?? NAVILY_SAMPLE_DEFAULTS.seabedMinShare;
  const result: OwnPlaceValues[] = [];
  for (const r of rows) {
    const stored = await latestComputations(db, r.geoObjectId);
    result.push({
      placeId: r.placeId,
      publicId: r.publicId,
      name: r.name ?? "(ohne Namen)",
      position: { lon: Number(r.lon), lat: Number(r.lat) },
      ...ownValuesOf(stored, minShare),
    });
  }
  return result;
}

export type PlaceVerdict = {
  placeId: string;
  publicId: string | null;
  name: string;
  matched: boolean;
  sectorsAgree: number | null;
  sectorResults: Record<Sector, "match" | "deviation"> | null;
  seabed: "match" | "deviation" | "no_own_value" | "not_at_navily";
  /** `not_computed`: the place has no geometry computation yet, so there is neither a depth nor a gap reason. */
  depth: "value" | GapReason | "not_computed";
  verdict: "stimmt" | "teilweise" | "weicht ab" | "nicht bei Navily" | "ohne Geometrie";
};

const EARTH_RADIUS_M = 6_371_008.8;

function distanceM(a: LonLat, b: LonLat): number {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Navily seabed names in the Periplus vocabulary; unknown names are ignored. */
const NAVILY_SEABED: Record<string, SeabedType> = { algae: "weed", sand: "sand", mud: "mud", rock: "rock", gravel: "gravel" };

/**
 * Compares a place with the nearest Navily spot within `radiusM`. A sector is protected at Periplus when its
 * shelter is ≥ `protectedThreshold`, at Navily when its lower-case code is in `prot`; seabeds agree when the
 * type sets intersect (Navily `algae` = `weed`). Verdict from the agreeing sectors: ≥ 6 „stimmt“, 4–5
 * „teilweise“, ≤ 3 „weicht ab“. Navily has no depth: depth is reported as own coverage only.
 */
export function comparePlace(
  own: OwnPlaceValues,
  spots: NavilySpot[],
  opts: { radiusM: number; protectedThreshold: number },
): PlaceVerdict {
  let nearest: NavilySpot | null = null;
  let nearestM = Infinity;
  for (const s of spots) {
    const d = distanceM(own.position, s);
    if (d <= opts.radiusM && d < nearestM) {
      nearest = s;
      nearestM = d;
    }
  }

  const depth: PlaceVerdict["depth"] = own.hasDepth ? "value" : (own.depthGap ?? "not_computed");
  const base = { placeId: own.placeId, publicId: own.publicId, name: own.name, matched: nearest !== null, depth };

  let seabed: PlaceVerdict["seabed"] = "not_at_navily";
  const navilySeabed = (nearest?.seabeds ?? []).flatMap((s) => NAVILY_SEABED[s.toLowerCase()] ?? []);
  if (nearest && navilySeabed.length > 0) {
    if (!own.seabed || own.seabed.length === 0) seabed = "no_own_value";
    else seabed = own.seabed.some((t) => navilySeabed.includes(t)) ? "match" : "deviation";
  }

  if (!own.shelter) return { ...base, sectorsAgree: null, sectorResults: null, seabed, verdict: "ohne Geometrie" };
  if (!nearest) return { ...base, sectorsAgree: null, sectorResults: null, seabed, verdict: "nicht bei Navily" };

  const prot = new Set((nearest.prot ?? []).map((p) => p.toLowerCase()));
  const sectorResults = Object.fromEntries(
    SECTORS.map((s) => [s, own.shelter![s] >= opts.protectedThreshold === prot.has(s.toLowerCase()) ? "match" : "deviation"]),
  ) as Record<Sector, "match" | "deviation">;
  const sectorsAgree = SECTORS.filter((s) => sectorResults[s] === "match").length;
  const verdict = sectorsAgree >= 6 ? "stimmt" : sectorsAgree >= 4 ? "teilweise" : "weicht ab";
  return { ...base, sectorsAgree, sectorResults, seabed, verdict };
}

export type GeometryRunStats = { runId: string; places: number; durationS: number; perPlaceS: number };
export type DatasetImportCosts = { calls: number; costEur: number; byService: Record<string, number> };

/** The newest finished run with stage `geometry.place` over this area (scope `area`), with its place count and duration. */
export async function geometryRunStats(db: Db, areaKey: string): Promise<GeometryRunStats | null> {
  const [run] = await db
    .select({ id: runs.id, startedAt: runs.startedAt, finishedAt: runs.finishedAt, total: runStages.total })
    .from(runs)
    .innerJoin(runStages, and(eq(runStages.runId, runs.id), eq(runStages.stage, GEOMETRY_STAGE)))
    .where(
      and(
        eq(runs.status, "finished"),
        eq(runs.scopeType, "area"),
        eq(runs.scopeId, areaKey),
        isNotNull(runs.startedAt),
        isNotNull(runs.finishedAt),
      ),
    )
    .orderBy(desc(runs.finishedAt), desc(runs.id))
    .limit(1);
  if (!run) return null;
  const durationS = (run.finishedAt!.getTime() - run.startedAt!.getTime()) / 1000;
  return { runId: run.id, places: run.total, durationS, perPlaceS: run.total > 0 ? durationS / run.total : 0 };
}

/** External calls and costs of the newest `datasets.import` run of this area; zeros when there is none. */
export async function datasetImportCosts(db: Db, areaKey: string): Promise<DatasetImportCosts> {
  const [run] = await db
    .select({ id: runs.id })
    .from(runs)
    .where(and(eq(runs.scopeType, "area"), eq(runs.scopeId, areaKey), sql`${DATASETS_STAGE} = any(${runs.stages})`))
    .orderBy(desc(runs.createdAt), desc(runs.id))
    .limit(1);
  if (!run) return { calls: 0, costEur: 0, byService: {} };
  const rows = await db
    .select({
      service: externalCalls.service,
      calls: sql<number>`count(*)::int`,
      costEur: sql<string>`coalesce(sum(${externalCalls.costEur}), 0)`,
    })
    .from(externalCalls)
    .where(eq(externalCalls.runId, run.id))
    .groupBy(externalCalls.service)
    .orderBy(externalCalls.service);
  return {
    calls: rows.reduce((n, r) => n + r.calls, 0),
    costEur: rows.reduce((n, r) => n + Number(r.costEur), 0),
    byService: Object.fromEntries(rows.map((r) => [r.service, r.calls])),
  };
}

const pct = (part: number, whole: number): string => (whole === 0 ? "–" : `${Math.round((part / whole) * 100)} %`);
const fmt = (n: number, digits = 1): string => n.toLocaleString("de-DE", { maximumFractionDigits: digits });
const cell = (s: string): string => s.replace(/\|/g, "\\|").replace(/\n/g, " ");

const DEPTH_LABEL: Record<PlaceVerdict["depth"], string> = {
  value: "Wert",
  no_water: "Lücke: keine Wasserfläche",
  origin_unresolved: "Lücke: kein Ausgangspunkt",
  no_bathymetry: "Lücke: keine Bathymetrie",
  no_anchor_area: "Lücke: keine Ankerfläche",
  no_seabed_coverage: "Lücke: kein Grund",
  not_computed: "nicht berechnet",
};

const SEABED_LABEL: Record<PlaceVerdict["seabed"], string> = {
  match: "stimmt",
  deviation: "weicht ab",
  no_own_value: "kein eigener Wert",
  not_at_navily: "nicht bei Navily",
};

/**
 * The spot check report as Markdown: Periplus names and ids, aggregated agreement and per-place verdicts only.
 * „Verglichene Orte“ are the places with geometry; sector and seabed rates refer to those found at Navily.
 */
export function renderReport(input: {
  areaKey: string;
  generatedAt: Date;
  verdicts: PlaceVerdict[];
  runtime: GeometryRunStats | null;
  costs: DatasetImportCosts;
}): string {
  const { verdicts } = input;
  const withGeometry = verdicts.filter((v) => v.verdict !== "ohne Geometrie");
  const matched = withGeometry.filter((v) => v.matched);
  const agreeTotal = matched.reduce((n, v) => n + (v.sectorsAgree ?? 0), 0);
  const seabedCompared = matched.filter((v) => v.seabed === "match" || v.seabed === "deviation");
  const withDepth = withGeometry.filter((v) => v.depth === "value");

  const lines: string[] = [
    `# Stichprobe gegen Navily – Revier ${input.areaKey}`,
    "",
    `Erstellt: ${input.generatedAt.toISOString()}`,
    "",
    "> Navily-Werte wurden nur zur Laufzeit gelesen und nicht gespeichert (Grundprinzip 9).",
    "> Dieser Bericht enthält nur eigene Namen und IDs sowie das Ergebnis des Vergleichs.",
    "",
    "## Kennzahlen",
    "",
    "| Kennzahl | Wert |",
    "| --- | --- |",
    `| Orte im Vergleichssatz | ${verdicts.length} |`,
    `| Verglichene Orte (mit Geometrie) | ${withGeometry.length} |`,
    `| Bei Navily gefunden | ${matched.length} |`,
    `| Sektor-Übereinstimmung gesamt | ${pct(agreeTotal, matched.length * SECTORS.length)} |`,
    ...SECTORS.map((s) => `| Sektor ${s} | ${pct(matched.filter((v) => v.sectorResults?.[s] === "match").length, matched.length)} |`),
    `| Grund-Übereinstimmung | ${pct(seabedCompared.filter((v) => v.seabed === "match").length, seabedCompared.length)} |`,
    `| Tiefen-Deckung | ${pct(withDepth.length, withGeometry.length)} |`,
    "",
    "Urteil je Ort aus den übereinstimmenden Sektoren: ab 6/8 „stimmt“, 4–5 „teilweise“, bis 3 „weicht ab“. " +
      "Navily kennt keine Tiefe; die Tiefe zeigt nur, ob ein eigener Wert vorliegt.",
    "",
    "## Orte",
    "",
    "| Ort | ID | Sektoren | Grund | Tiefe | Urteil |",
    "| --- | --- | --- | --- | --- | --- |",
    ...verdicts.map(
      (v) =>
        `| ${cell(v.name)} | ${v.publicId ?? v.placeId} | ${v.sectorsAgree === null ? "–" : `${v.sectorsAgree}/8`} | ` +
        `${SEABED_LABEL[v.seabed]} | ${DEPTH_LABEL[v.depth]} | ${v.verdict} |`,
    ),
    "",
    "## Laufzeit und Kosten",
    "",
  ];

  if (input.runtime) {
    const r = input.runtime;
    lines.push(
      `Jüngster beendeter Geometrie-Lauf ${r.runId}: ${r.places} Orte in ${fmt(r.durationS, 0)} s, ` +
        `${fmt(r.perPlaceS, 2)} s je Ort.`,
    );
  } else {
    lines.push("Kein beendeter Geometrie-Lauf für dieses Revier.");
  }
  lines.push("");
  const services = Object.entries(input.costs.byService);
  lines.push(
    `Jüngster Lauf „Datensätze laden“: ${input.costs.calls} externe Aufrufe, Kosten ${fmt(input.costs.costEur, 2)} €` +
      (services.length > 0 ? ` (${services.map(([s, n]) => `${s}: ${n}`).join(", ")}).` : "."),
  );
  lines.push("");
  return lines.join("\n");
}
