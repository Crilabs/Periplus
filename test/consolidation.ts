import { loadConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { geomFromGeoJson } from "@/lib/db/geometry";
import {
  computations,
  facts,
  places,
  sources,
  type ComputationKind,
  type DocType,
  type PlaceStatus,
} from "@/lib/db/schema";
import type { GeoObjectType } from "@/lib/db/schema/geo";
import type { ConfidenceClass, RuleName, RuleOrigin } from "@/lib/domain/rules/types";
import { newId } from "@/lib/domain/ids";
import { insertNamedObject } from "@/test/text";

/** Where a profile value comes from: a rule origin, the gazetteer (identity fields) or a derived value. */
export type ProvenanceOrigin = RuleOrigin | "gazetteer" | "derived";

/**
 * Where one profile value comes from. A proposed change under review is not stored here (ruling M5-P8): the view
 * derives it from the open `uncertain_change` task.
 */
export type AttributeProvenance = {
  origin: ProvenanceOrigin;
  rule: RuleName | "identity" | "derived";
  confidence: number;
  confidenceClass: ConfidenceClass;
  observedAt: string | null;
  lastConfirmedAt: string | null;
  factIds: string[];
  sourceKeys: string[];
  computationIds: string[];
  poiIds: string[];
  /** Older than two cycles of the tile: the value stays, its confidence drops one class. */
  expired: boolean;
  /**
   * Every supporting document is gone and no input outside documents (computation, review, observation, POI) carries
   * the value: it is no longer "currently confirmed" (part of the content hash, ruling M5-E-R3 M-1/M-2).
   */
  onlyGoneSources: boolean;
  conflictKey: string | null;
  observedMonths: number[];
  /**
   * List rules only (union lists `hazards`, `restricted_zones` …, ruling M5-C-R1 (5); `prohibitions`, ruling M5-E-R3):
   * entry identity key → the sorted input ids (`inputId`) naming the entry; an entry a review added cites the review
   * fact.
   */
  entryFactIds?: Record<string, string[]>;
  /**
   * Safety lists only (ruling M6-FIN-R3): entry identity key → `in_review` for a kept entry that cites no fact any
   * more (its source ended or was rejected) while the change removing it waits in an `uncertain_change` task. The
   * entry stays (safe direction) until the task is decided. Provenance, not part of the content hash.
   */
  entryMarkers?: Record<string, "in_review">;
  /**
   * Derived and identity values only (ruling M5-E-R3 I-3, M-5): the inputs that decided the value, which cannot be
   * reconstructed later (spatial candidates, sitelinks, the ferry basis). Provenance, not part of the content hash.
   */
  derivedFrom?: Record<string, unknown>;
};

/*
 * Fixtures against the database: places, sources and computations with their facts, inserted directly. Meant for `withRollback`; synthetic
 * objects at 21.0° E / 35.2° N (outside the pilot box), sources on `<uuid>.test.invalid`. A test that commits must
 * use other coordinates (see `store.test.ts`): committed places at 21.0° E / 35.2° N join the geometry test tiles.
 */

/** The active fact schema version: fixtures that mean "the active schema" use it, so a schema switch breaks no test. */
const ACTIVE_SCHEMA = loadConfig("config").factSchema.version;

/** A geo object (default a bay) with a place (anchorage, default confirmed). */
export async function insertPlace(
  db: Db,
  o: { lon?: number; lat?: number; name?: string; type?: GeoObjectType; status?: PlaceStatus } = {},
): Promise<{ objectId: string; placeId: string }> {
  const lon = o.lon ?? 21.0;
  const lat = o.lat ?? 35.2;
  const objectId = await insertNamedObject(db, { type: o.type ?? "bay", names: [{ name: o.name ?? "Kolona" }], lon, lat });
  const [p] = await db
    .insert(places)
    .values({ geoObjectId: objectId, kind: "anchorage", status: o.status ?? "confirmed", position: geomFromGeoJson({ type: "Point", coordinates: [lon, lat] }) })
    .returning({ id: places.id });
  return { objectId, placeId: p!.id };
}

/** A source of `type` with `weight` (default a pilot guide, 0.9). */
export async function insertSource(db: Db, type: DocType = "pilot_guide", weight = 0.9): Promise<string> {
  const [row] = await db
    .insert(sources)
    .values({ domain: `${newId()}.test.invalid`, name: "Test source", type, weight, crawlRules: { startUrls: [] }, origin: "manual" })
    .returning({ id: sources.id });
  return row!.id;
}

/** A computation of `kind` with one fact per entry of `values` (confidence `confidence`, default 0.55). */
export async function insertComputation(
  db: Db,
  objectId: string,
  kind: ComputationKind,
  values: Record<string, unknown>,
  o: { confidence?: number; createdAt?: Date; outputs?: Record<string, unknown> } = {},
): Promise<{ computationId: string; factIds: string[] }> {
  const createdAt = o.createdAt ?? new Date("2026-10-01T10:00:00Z");
  const [c] = await db
    .insert(computations)
    .values({ geoObjectId: objectId, kind, inputs: values, inputsHash: newId(), outputs: o.outputs ?? {}, rulesVersion: "test", createdAt })
    .returning({ id: computations.id });
  const rows = await db
    .insert(facts)
    .values(
      Object.entries(values).map(([attribute, value]) => ({
        geoObjectId: objectId,
        attribute,
        value,
        computationId: c!.id,
        observedAt: createdAt.toISOString().slice(0, 10),
        confidence: o.confidence ?? 0.55,
        factSchemaVersion: ACTIVE_SCHEMA,
      })),
    )
    .returning({ id: facts.id });
  return { computationId: c!.id, factIds: rows.map((r) => r.id) };
}

/** A provenance entry of `origin` (confidence 0.8, class medium, nothing cited) with `patch` applied. */
export function provenanceEntry(origin: ProvenanceOrigin, patch: Partial<AttributeProvenance> = {}): AttributeProvenance {
  return {
    origin,
    rule: origin === "gazetteer" ? "identity" : origin === "derived" ? "derived" : "default",
    confidence: 0.8,
    confidenceClass: "medium",
    observedAt: null,
    lastConfirmedAt: null,
    factIds: [],
    sourceKeys: [],
    computationIds: [],
    poiIds: [],
    expired: false,
    onlyGoneSources: false,
    conflictKey: null,
    observedMonths: [],
    ...patch,
  };
}
