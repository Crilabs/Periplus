import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Point } from "geojson";
import type { AppConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { asGeoJson } from "@/lib/db/geometry";
import { geoNames, geoObjects, places, researchHits } from "@/lib/db/schema";
import type { LonLat } from "@/lib/domain/geometry/water";
import { comparedPosition, lonLatOf } from "@/lib/domain/quality/comparison-values";
import { subdivisionTileIds } from "@/lib/domain/gazetteer/tiles-ensure";
import { distanceM, type NavilySpot } from "@/lib/domain/quality/navily-sample";
import { requireSubdivision } from "@/lib/domain/subdivisions/store";
import { tileBbox, tileIdFor, tileNeighbours } from "@/lib/domain/tiles";
import { latestProfiles, validAt } from "@/lib/domain/timeline";
import { verdictsIn } from "./gate";
import { gateDecisions } from "./gate-conflicts";
import { evaluateGate, type GateErrorKind, type GatePlace, type GateRow, type MissReason } from "./gate-navily";

/*
 * The reference gate as a measurement run (plan N3): loads the places of a subdivision, decides them per threshold,
 * evaluates them against the reference spots and renders the report. The committed report holds counts only; the
 * per-item lists (place id, reason, distance, spot index) are meant for a directory outside the repo (Grundprinzip 9).
 */

export const MISS_REASON_LABELS: Record<MissReason, string> = {
  no_candidate: "kein Kandidat in der Nähe",
  matched_elsewhere: "Kandidat gehört schon zu einem anderen Spot",
  admin: "Status vom Admin gesetzt, nicht bestätigt",
  unnamed_candidate: "Kandidat ohne Namen",
  no_hits: "Kandidat ohne Suchtreffer",
  too_few_sources: "zu wenige unabhängige Quellen",
  negative: "negative Belege",
  restricted: "Schutzgebiet mit Ankerverbot",
  rejected: "abgelehnt oder aufgegeben",
};

export type GateMeasurement = {
  subdivisionKey: string;
  /** All places of the subdivision (the scope of the conflict tasks). */
  scopePlaceIds: string[];
  /** Tiles of the subdivision with at least one valid place (worked on), and all tiles of the subdivision. */
  builtTiles: number;
  totalTiles: number;
  /** Spots in the worked-on tiles, the ones counted (spots of the border buffer are matched, not counted). */
  spotCount: number;
  rows: GateRow[];
  /** Per threshold: the confirmed places with a human decision (berth or not). */
  decided: Map<number, number>;
  /** Per threshold: the misses with the index of the spot in the loaded file; `distanceM` to the near candidate. */
  misses: Map<number, Array<{ spotIndex: number; reason: MissReason; placeId: string | null; distanceM: number | null }>>;
  /** Per threshold: the confirmed places without a spot and without a decision. */
  conflicts: Map<number, string[]>;
  /** Per threshold: the error places (spot of another kind, position too far off, human "no berth"), with the file index of their spot. */
  errors: Map<number, Array<{ placeId: string; kind: GateErrorKind; spotIndex: number | null; distanceM: number | null }>>;
  /** The threshold the rule delivers with now (`confirmation.minIndependentSources`). */
  deliveredThreshold: number;
  /**
   * The places of the subdivision delivered as `confirmed` now whose verdict at `deliveredThreshold` is not confirmed:
   * delivered, but not backed by the rule. While there is one, the gate is not passed.
   */
  unbacked: string[];
  /** The smallest threshold with correctness 100 %, no open conflict and at least `gate.minConfirmed` confirmed places; null when there is none. */
  passedAt: number | null;
  /** When no threshold passes only for want of a sample: the confirmed count of the first threshold that is perfect but below `gate.minConfirmed`. */
  tooFewConfirmed: number | null;
  minConfirmed: number;
  /** The smallest threshold with open conflicts (where `--sync-conflicts` asks); null when none has. */
  conflictThreshold: number | null;
};

/** All valid, unmerged places of the subdivision of any status, with the delivered positions (as `confirmedSubdivisionPlaces`). */
async function subdivisionPlaces(db: Db, subdivisionKey: string): Promise<Array<Omit<GatePlace, "verdicts" | "hasHits"> & { hasHits: boolean }>> {
  const sub = await requireSubdivision(db, subdivisionKey);
  const rows = await db
    .select({
      placeId: places.id,
      geoObjectId: places.geoObjectId,
      kind: places.kind,
      status: places.status,
      statusReason: places.statusReason,
      position: asGeoJson(places.position),
      hasHits: sql<boolean>`exists (select 1 from ${researchHits} where ${researchHits.placeId} = ${places.id})`,
    })
    .from(places)
    .innerJoin(geoObjects, eq(geoObjects.id, places.geoObjectId))
    .where(and(eq(geoObjects.subdivisionId, sub.id), isNull(places.mergedIntoId), validAt(places)))
    .orderBy(asc(places.id));
  if (rows.length === 0) return [];
  const objectIds = rows.map((r) => r.geoObjectId);
  const nameRows = await db
    .selectDistinct({ geoObjectId: geoNames.geoObjectId, name: geoNames.name })
    .from(geoNames)
    .where(and(inArray(geoNames.geoObjectId, objectIds), validAt(geoNames)))
    .orderBy(asc(geoNames.geoObjectId), asc(geoNames.name));
  const namesOf = new Map<string, string[]>();
  for (const n of nameRows) namesOf.set(n.geoObjectId, [...(namesOf.get(n.geoObjectId) ?? []), n.name]);
  const profileOf = await latestProfiles(db, objectIds);
  return rows.map((r) => {
    const [lon, lat] = (r.position as Point).coordinates as [number, number];
    const attributes = profileOf.get(r.geoObjectId)?.attributes ?? {};
    const names = namesOf.get(r.geoObjectId) ?? [];
    return {
      placeId: r.placeId,
      kind: r.kind,
      status: r.status,
      statusReason: r.statusReason,
      position: lonLatOf(attributes["place.position"]) ?? { lon, lat },
      anchorPosition: lonLatOf(attributes["anchor_position"]),
      names,
      hasNames: names.length > 0,
      hasHits: r.hasHits,
    };
  });
}

/**
 * The worked-on tiles of the subdivision (those with at least one valid place; a tile seeded with zero candidates does
 * not count, it has nothing to deliver) as two predicates on a point: `inside` one of them (the spots counted), or
 * `matchable`: inside or within `bufferM` of one (the spots matched, so a place near the edge still finds its spot just
 * outside). The buffer is checked against the neighbour tiles only (a tile is far wider than any matching radius).
 */
async function subdivisionTileAreas(
  db: Db,
  subdivisionKey: string,
  bufferM: number,
): Promise<{ inside: (p: LonLat) => boolean; matchable: (p: LonLat) => boolean; built: number; total: number }> {
  const sub = await requireSubdivision(db, subdivisionKey);
  const all = await subdivisionTileIds(db, sub.id);
  const worked = await db
    .selectDistinct({ tileId: places.tileId })
    .from(places)
    .innerJoin(geoObjects, eq(geoObjects.id, places.geoObjectId))
    .where(and(eq(geoObjects.subdivisionId, sub.id), isNull(places.mergedIntoId), validAt(places), inArray(places.tileId, all)));
  const ids = new Set(worked.map((r) => r.tileId!));
  const inside = (p: LonLat) => ids.has(tileIdFor(p.lon, p.lat));
  const nearTile = (p: LonLat, id: string) => {
    const [west, south, east, north] = tileBbox(id);
    return distanceM(p, { lon: Math.min(Math.max(p.lon, west), east), lat: Math.min(Math.max(p.lat, south), north) }) <= bufferM;
  };
  return { inside, matchable: (p) => inside(p) || tileNeighbours(tileIdFor(p.lon, p.lat)).some((id) => ids.has(id) && nearTile(p, id)), built: ids.size, total: all.length };
}

/**
 * Measures the gate of the subdivision against the loaded reference spots: the spots inside the subdivision's worked-on tiles
 * count, those within `quality.navily.maxRadiusM` of them are matched as well (`subdivisionTileAreas`). Everything is read
 * in one read-only, repeatable-read transaction (one snapshot); pass the top-level `db`, a nested transaction would not
 * honour it. Also counts the places delivered as confirmed now that the rule at `confirmation.minIndependentSources`
 * does not back (`unbacked`). Writes nothing.
 */
export async function measureGate(db: Db, input: { subdivisionKey: string; spots: NavilySpot[] }, cfg: AppConfig): Promise<GateMeasurement> {
  return db.transaction((tx) => measureIn(tx, input, cfg), { accessMode: "read only", isolationLevel: "repeatable read" });
}

async function measureIn(tx: Db, input: { subdivisionKey: string; spots: NavilySpot[] }, cfg: AppConfig): Promise<GateMeasurement> {
  const { subdivisionKey } = input;
  const thresholds = cfg.research.gate.thresholds;
  const deliveredThreshold = cfg.research.confirmation.minIndependentSources;
  const area = await subdivisionTileAreas(tx, subdivisionKey, cfg.quality.navily.maxRadiusM);
  const indexes = input.spots.flatMap((s, i) => (area.matchable(s) ? [i] : []));
  const spots = indexes.map((i) => input.spots[i]!);
  const counted = spots.filter((s) => area.inside(s)).length;

  const base = await subdivisionPlaces(tx, subdivisionKey);
  const decisions = await gateDecisions(tx, base.map((p) => p.placeId));
  const verdicts = await verdictsIn(tx, subdivisionKey, thresholds, cfg, { includePlaceIds: [...decisions.keys()] });
  // what is delivered now: the rule as `applyBerthVerdicts` applies it, no human gate decision re-decided
  const delivered = (await verdictsIn(tx, subdivisionKey, [deliveredThreshold], cfg)).get(deliveredThreshold)!;
  const unbacked = base.filter((p) => p.status === "confirmed" && delivered.get(p.placeId)?.status !== "confirmed").map((p) => p.placeId);
  const gatePlaces: GatePlace[] = base.map((p) => ({
    ...p,
    verdicts: new Map(thresholds.flatMap((n) => (verdicts.get(n)!.has(p.placeId) ? [[n, verdicts.get(n)!.get(p.placeId)!] as const] : []))),
  }));
  const byId = new Map(gatePlaces.map((p) => [p.placeId, p]));

  const evaluated = evaluateGate({ thresholds, places: gatePlaces, spots, decisions, inArea: area.inside }, cfg);
  const decided = new Map<number, number>();
  const misses: GateMeasurement["misses"] = new Map();
  const errors: GateMeasurement["errors"] = new Map();
  for (const n of thresholds) {
    errors.set(
      n,
      (evaluated.errors.get(n) ?? []).map((e) => ({ ...e, spotIndex: e.spotIndex === null ? null : indexes[e.spotIndex]!, distanceM: e.distanceM === null ? null : Math.round(e.distanceM) })),
    );
    decided.set(n, gatePlaces.filter((p) => p.verdicts.get(n)?.status === "confirmed" && decisions.has(p.placeId)).length);
    misses.set(
      n,
      (evaluated.misses.get(n) ?? []).map((m) => {
        const place = m.placeId ? byId.get(m.placeId) : undefined;
        return { spotIndex: indexes[m.spotIndex]!, reason: m.reason, placeId: m.placeId, distanceM: place ? Math.round(distanceM(comparedPosition(place), spots[m.spotIndex]!)) : null };
      }),
    );
  }
  const minConfirmed = cfg.research.gate.minConfirmed;
  const perfect = evaluated.rows.filter((r) => r.confirmed > 0 && r.correctness === 1 && r.conflicts === 0);
  const passedAt = perfect.find((r) => r.confirmed >= minConfirmed)?.threshold ?? null;
  const tooFewConfirmed = passedAt === null ? (perfect[0]?.confirmed ?? null) : null;
  const conflictThreshold = evaluated.rows.find((r) => r.conflicts > 0)?.threshold ?? null;
  return {
    subdivisionKey,
    scopePlaceIds: base.map((p) => p.placeId),
    builtTiles: area.built,
    totalTiles: area.total,
    spotCount: counted,
    rows: evaluated.rows,
    decided,
    misses,
    conflicts: evaluated.conflicts,
    errors,
    deliveredThreshold,
    unbacked,
    passedAt,
    tooFewConfirmed,
    minConfirmed,
    conflictThreshold,
  };
}

/** The one-line outcome the CLI prints: „Tor bestanden bei N=…“ or „Tor nicht bestanden: …“. */
export function gateOutcome(m: GateMeasurement): string {
  if (m.unbacked.length > 0) {
    return `Tor nicht bestanden: ${m.unbacked.length} bestätigt gelieferte Plätze sind von der Regel (N=${m.deliveredThreshold}) nicht gedeckt`;
  }
  if (m.passedAt !== null) return `Tor bestanden bei N=${m.passedAt}`;
  if (m.rows.every((r) => r.confirmed === 0)) return "Tor nicht bestanden: bei keiner Schwelle ist ein Platz bestätigt";
  if (m.tooFewConfirmed !== null) return `Tor nicht bestanden: zu wenige bestätigte Plätze (${m.tooFewConfirmed} von mindestens ${m.minConfirmed})`;
  const open = m.rows.reduce((sum, r) => sum + r.conflicts, 0);
  return open > 0
    ? "Tor nicht bestanden: bei keiner Schwelle sind alle bestätigten Plätze korrekt, es gibt offene Konflikte"
    : "Tor nicht bestanden: bei keiner Schwelle sind alle bestätigten Plätze korrekt";
}

const percent = (r: GateRow) => (r.correctness === null ? "n/a" : `${Math.round(r.correctness * 1000) / 10} %`);

/** The committed report (German): counts only, no name, id, coordinate or value of the reference. */
export function renderGateReport(m: GateMeasurement, generatedAt: Date): string {
  const thresholds = m.rows.map((r) => r.threshold);
  const lines = [
    `# Navily-Tor ${m.subdivisionKey}`,
    "",
    `Stand: ${generatedAt.toISOString().slice(0, 10)}. Gemessen wird, welche Plätze bei jeder Schwelle unabhängiger Quellen bestätigt wären, gegen die Referenz (${m.spotCount} Spots in den bearbeiteten Kacheln des Landesteils). Die Referenz ist nie Datenquelle, sie misst nur.`,
    "",
    `Bearbeitete Kacheln: ${m.builtTiles} von ${m.totalTiles}. Nur Spots in bearbeiteten Kacheln (mit mindestens einem Platz) zählen; das Tor gilt nur mit mindestens ${m.minConfirmed} bestätigten Plätzen.`,
    "",
    "## Ergebnis je Schwelle",
    "",
    "| Schwelle N | bestätigt | korrekt | falsche Art | Position abweichend | Konflikte offen | mit Entscheidung | davon „kein Liegeplatz“ | Korrektheit |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...m.rows.map(
      (r) => `| ${r.threshold} | ${r.confirmed} | ${r.correct} | ${r.wrongKind} | ${r.wrongPosition} | ${r.conflicts} | ${m.decided.get(r.threshold) ?? 0} | ${r.decidedNotBerth} | ${percent(r)} |`,
    ),
    "",
    `Geliefert bestätigt, aber von der Regel (N=${m.deliveredThreshold}) nicht gedeckt: ${m.unbacked.length}. Solange es solche Plätze gibt, ist das Tor nicht bestanden.`,
    "",
    "Kernwerte gegen die Referenz: noch nicht verglichen (bekannte Lücke).",
    "",
    "## Fehlliste: Spots ohne bestätigten Platz, nach Grund",
    "",
    `| Grund | ${thresholds.map((n) => `N=${n}`).join(" | ")} |`,
    `| --- | ${thresholds.map(() => "---").join(" | ")} |`,
    ...(Object.keys(MISS_REASON_LABELS) as MissReason[]).map(
      (reason) => `| ${MISS_REASON_LABELS[reason]} | ${thresholds.map((n) => m.misses.get(n)!.filter((x) => x.reason === reason).length).join(" | ")} |`,
    ),
    "",
    "Die Einzellisten (Fehlliste, Fehler und Konflikte: Platz-ID, Grund, Abstand, Spot-Index) liegen nur außerhalb des Repos (`--out-dir`).",
    "",
    "## Gewählte Schwelle",
    "",
    m.passedAt !== null
      ? `Kleinste Schwelle mit Korrektheit 100 % ohne offene Konflikte und genug bestätigten Plätzen: **N=${m.passedAt}**. ${gateOutcome(m)}.`
      : `${gateOutcome(m)}. Gewählt wird die kleinste Schwelle mit Korrektheit 100 % ohne offene Konflikte und mit mindestens ${m.minConfirmed} bestätigten Plätzen; bisher gibt es keine.`,
    "",
  ];
  const lower = m.passedAt === null ? [] : m.rows.filter((r) => r.threshold < m.passedAt! && r.conflicts > 0).map((r) => `N=${r.threshold}`);
  if (lower.length > 0) lines.push(`Hinweis: Bei kleineren Schwellen (${lower.join(", ")}) gibt es noch offene Konflikte; das Tor gilt erst für die gewählte Schwelle.`, "");
  return lines.join("\n");
}

/**
 * Per threshold the CSV of the per-item lists (misses, errors, open conflicts, and in each file the places delivered as
 * confirmed without the rule's backing); for a directory outside the repo only.
 */
export function renderGateLists(m: GateMeasurement): Map<number, string> {
  const out = new Map<number, string>();
  for (const r of m.rows) {
    const lines = ["kind,place_id,reason,distance_m,spot_index"];
    for (const x of m.misses.get(r.threshold) ?? []) lines.push(`miss,${x.placeId ?? ""},${x.reason},${x.distanceM ?? ""},${x.spotIndex}`);
    for (const e of m.errors.get(r.threshold) ?? []) lines.push(`error,${e.placeId},${e.kind},${e.distanceM ?? ""},${e.spotIndex ?? ""}`);
    for (const id of m.conflicts.get(r.threshold) ?? []) lines.push(`conflict,${id},not_in_reference,,`);
    for (const id of m.unbacked) lines.push(`unbacked,${id},not_backed_at_n${m.deliveredThreshold},,`);
    out.set(r.threshold, `${lines.join("\n")}\n`);
  }
  return out;
}
