import { createHash } from "node:crypto";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { getConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { computations, facts, type ComputationKind } from "@/lib/db/schema";
import { attributeDef, canonicalJson, validateFactValue } from "./schema";

export type ComputedFact = { attribute: string; value: unknown; confidence: number };

export type RecordComputationInput = {
  geoObjectId: string;
  kind: ComputationKind;
  inputs: Record<string, unknown>;
  /** Intermediate results; not part of the inputs hash. */
  outputs?: Record<string, unknown>;
  rulesVersion: string;
  facts: ComputedFact[];
  /** `YYYY-MM-DD` */
  observedAt: string;
  runId?: string;
};

export type StoredComputation = {
  id: string;
  kind: ComputationKind;
  inputs: Record<string, unknown>;
  outputs: Record<string, unknown>;
  rulesVersion: string;
  createdAt: Date;
  facts: Array<{ id: string; attribute: string; value: unknown; confidence: number; observedAt: string }>;
};

/** Hash over kind, rules version and inputs; outputs never count. */
function inputsHash(kind: ComputationKind, rulesVersion: string, inputs: Record<string, unknown>): string {
  return createHash("sha256").update(canonicalJson({ kind, rulesVersion, inputs })).digest("hex");
}

/** Newest first; the id (UUIDv7) breaks ties between rows of one transaction (same `now()`). */
const newestFirst = [desc(computations.createdAt), desc(computations.id)];

/**
 * Writes one computation row with one fact per attribute, unless the inputs equal those of the
 * newest row for this geo object and kind (then nothing is written). Every fact is validated against
 * the active fact schema before anything is written.
 */
export async function recordComputation(
  db: Db,
  input: RecordComputationInput,
): Promise<{ id: string; created: boolean }> {
  const hash = inputsHash(input.kind, input.rulesVersion, input.inputs);
  return db.transaction(async (tx) => {
    // Serialises concurrent writers for the same geo object and kind, so the hash check stays valid.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${input.geoObjectId} || ':' || ${input.kind}))`);

    const [latest] = await tx
      .select({ id: computations.id, inputsHash: computations.inputsHash })
      .from(computations)
      .where(and(eq(computations.geoObjectId, input.geoObjectId), eq(computations.kind, input.kind)))
      .orderBy(...newestFirst)
      .limit(1);
    if (latest?.inputsHash === hash) return { id: latest.id, created: false };

    const version = getConfig().factSchema.version;
    const values = input.facts.map((f) => {
      const def = attributeDef(f.attribute, version);
      if (!def.origins.includes("computed")) {
        throw new Error(`Fact attribute ${f.attribute} cannot be computed (origins: ${def.origins.join(", ")})`);
      }
      return { ...f, value: validateFactValue(f.attribute, f.value, version) };
    });

    const [row] = await tx
      .insert(computations)
      .values({
        geoObjectId: input.geoObjectId,
        kind: input.kind,
        inputs: input.inputs,
        inputsHash: hash,
        outputs: input.outputs ?? {},
        rulesVersion: input.rulesVersion,
        runId: input.runId,
      })
      .returning({ id: computations.id });
    const id = row!.id;

    if (values.length > 0) {
      await tx.insert(facts).values(
        values.map((f) => ({
          geoObjectId: input.geoObjectId,
          attribute: f.attribute,
          value: f.value,
          computationId: id,
          observedAt: input.observedAt,
          confidence: f.confidence,
          factSchemaVersion: version,
        })),
      );
    }
    return { id, created: true };
  });
}

/** The newest computation per kind for a geo object, with its facts (ordered by attribute). */
export async function latestComputations(
  db: Db,
  geoObjectId: string,
): Promise<Map<ComputationKind, StoredComputation>> {
  const rows = await db
    .selectDistinctOn([computations.kind], {
      id: computations.id,
      kind: computations.kind,
      inputs: computations.inputs,
      outputs: computations.outputs,
      rulesVersion: computations.rulesVersion,
      createdAt: computations.createdAt,
    })
    .from(computations)
    .where(eq(computations.geoObjectId, geoObjectId))
    .orderBy(asc(computations.kind), ...newestFirst);

  const result = new Map<ComputationKind, StoredComputation>();
  if (rows.length === 0) return result;

  const factRows = await db
    .select({
      id: facts.id,
      computationId: facts.computationId,
      attribute: facts.attribute,
      value: facts.value,
      confidence: facts.confidence,
      observedAt: facts.observedAt,
    })
    .from(facts)
    .where(inArray(facts.computationId, rows.map((r) => r.id)))
    .orderBy(asc(facts.attribute));

  for (const r of rows) {
    result.set(r.kind, {
      id: r.id,
      kind: r.kind,
      inputs: r.inputs as Record<string, unknown>,
      outputs: r.outputs as Record<string, unknown>,
      rulesVersion: r.rulesVersion,
      createdAt: r.createdAt,
      facts: factRows
        .filter((f) => f.computationId === r.id)
        .map(({ id, attribute, value, confidence, observedAt }) => ({ id, attribute, value, confidence, observedAt })),
    });
  }
  return result;
}
