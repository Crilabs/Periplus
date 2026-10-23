import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Point } from "geojson";
import type { AppConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { asGeoJson } from "@/lib/db/geometry";
import { geoNames, geoObjects, places, researchHits } from "@/lib/db/schema";
import { comparedPosition, lonLatOf } from "@/lib/domain/quality/comparison-values";
import { subdivisionTilePredicate } from "@/lib/domain/quality/navily-compare";
import { distanceM, type NavilySpot } from "@/lib/domain/quality/navily-sample";
import { requireSubdivision } from "@/lib/domain/subdivisions/store";
import { latestProfiles, validAt } from "@/lib/domain/timeline";
import { verdictsByThreshold } from "./gate";
import { gateDecisions } from "./gate-conflicts";
import { evaluateGate, type GatePlace, type GateRow, type MissReason } from "./gate-navily";

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
  /** Spots in the subdivision's tiles, the ones the evaluation used. */
  spotCount: number;
  rows: GateRow[];
  /** Per threshold: the confirmed places with a human decision (berth or not). */
  decided: Map<number, number>;
  /** Per threshold: the misses with the index of the spot in the loaded file; `distanceM` to the near candidate. */
  misses: Map<number, Array<{ spotIndex: number; reason: MissReason; placeId: string | null; distanceM: number | null }>>;
  /** Per threshold: the confirmed places without a spot and without a decision. */
  conflicts: Map<number, string[]>;
  /** Per threshold: the error places (spot of another kind, human "no berth"), with the file index of their spot. */
  errors: Map<number, Array<{ placeId: string; kind: "wrong_kind" | "not_berth"; spotIndex: number | null; distanceM: number | null }>>;
  /** The smallest threshold with correctness 100 % and no open conflict; null when there is none. */
  passedAt: number | null;
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
 * Measures the gate of the subdivision against the loaded reference spots (only those in the subdivision's tiles count).
 * Pass the top-level `db`: the verdicts are read in one read-only snapshot, which a nested transaction would not honour.
 * Writes nothing.
 */
export async function measureGate(db: Db, input: { subdivisionKey: string; spots: NavilySpot[] }, cfg: AppConfig): Promise<GateMeasurement> {
  const { subdivisionKey } = input;
  const thresholds = cfg.research.gate.thresholds;
  const inArea = await subdivisionTilePredicate(db, subdivisionKey);
  const indexes = input.spots.flatMap((s, i) => (inArea(s) ? [i] : []));
  const spots = indexes.map((i) => input.spots[i]!);

  const base = await subdivisionPlaces(db, subdivisionKey);
  const decisions = await gateDecisions(db, base.map((p) => p.placeId));
  const verdicts = await verdictsByThreshold(db, subdivisionKey, thresholds, cfg, { includePlaceIds: [...decisions.keys()] });
  const gatePlaces: GatePlace[] = base.map((p) => ({
    ...p,
    verdicts: new Map(thresholds.flatMap((n) => (verdicts.get(n)!.has(p.placeId) ? [[n, verdicts.get(n)!.get(p.placeId)!] as const] : []))),
  }));
  const byId = new Map(gatePlaces.map((p) => [p.placeId, p]));

  const evaluated = evaluateGate({ thresholds, places: gatePlaces, spots, decisions }, cfg);
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
  const passedAt = evaluated.rows.find((r) => r.confirmed > 0 && r.correctness === 1 && r.conflicts === 0)?.threshold ?? null;
  const conflictThreshold = evaluated.rows.find((r) => r.conflicts > 0)?.threshold ?? null;
  return { subdivisionKey, scopePlaceIds: base.map((p) => p.placeId), spotCount: spots.length, rows: evaluated.rows, decided, misses, conflicts: evaluated.conflicts, errors, passedAt, conflictThreshold };
}

/** The one-line outcome the CLI prints: „Tor bestanden bei N=…“ or „Tor nicht bestanden: …“. */
export function gateOutcome(m: GateMeasurement): string {
  if (m.passedAt !== null) return `Tor bestanden bei N=${m.passedAt}`;
  if (m.rows.every((r) => r.confirmed === 0)) return "Tor nicht bestanden: bei keiner Schwelle ist ein Platz bestätigt";
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
    `Stand: ${generatedAt.toISOString().slice(0, 10)}. Gemessen wird, welche Plätze bei jeder Schwelle unabhängiger Quellen bestätigt wären, gegen die Referenz (${m.spotCount} Spots im Landesteil). Die Referenz ist nie Datenquelle, sie misst nur.`,
    "",
    "## Ergebnis je Schwelle",
    "",
    "| Schwelle N | bestätigt | korrekt | falsche Art | Konflikte offen | mit Entscheidung | davon „kein Liegeplatz“ | Korrektheit |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
    ...m.rows.map((r) => `| ${r.threshold} | ${r.confirmed} | ${r.correct} | ${r.wrongKind} | ${r.conflicts} | ${m.decided.get(r.threshold) ?? 0} | ${r.decidedNotBerth} | ${percent(r)} |`),
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
      ? `Kleinste Schwelle mit Korrektheit 100 % ohne offene Konflikte: **N=${m.passedAt}**. ${gateOutcome(m)}.`
      : `${gateOutcome(m)}. Gewählt wird die kleinste Schwelle mit Korrektheit 100 % ohne offene Konflikte; bisher gibt es keine.`,
    "",
  ];
  const lower = m.passedAt === null ? [] : m.rows.filter((r) => r.threshold < m.passedAt! && r.conflicts > 0).map((r) => `N=${r.threshold}`);
  if (lower.length > 0) lines.push(`Hinweis: Bei kleineren Schwellen (${lower.join(", ")}) gibt es noch offene Konflikte; das Tor gilt erst für die gewählte Schwelle.`, "");
  return lines.join("\n");
}

/** Per threshold the CSV of the per-item lists (misses and open conflicts); for a directory outside the repo only. */
export function renderGateLists(m: GateMeasurement): Map<number, string> {
  const out = new Map<number, string>();
  for (const r of m.rows) {
    const lines = ["kind,place_id,reason,distance_m,spot_index"];
    for (const x of m.misses.get(r.threshold) ?? []) lines.push(`miss,${x.placeId ?? ""},${x.reason},${x.distanceM ?? ""},${x.spotIndex}`);
    for (const e of m.errors.get(r.threshold) ?? []) lines.push(`error,${e.placeId},${e.kind},${e.distanceM ?? ""},${e.spotIndex ?? ""}`);
    for (const id of m.conflicts.get(r.threshold) ?? []) lines.push(`conflict,${id},not_in_reference,,`);
    out.set(r.threshold, `${lines.join("\n")}\n`);
  }
  return out;
}
