import { sql } from "drizzle-orm";
import type { PgInsertValue } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { geomFromGeoJson } from "@/lib/db/geometry";
import { computations, facts, geoObjects, reviewDecisions, reviewTasks } from "@/lib/db/schema";
import { newId } from "@/lib/domain/ids";
import type { Db } from "@/lib/db/client";
import { withRollback } from "@/test/db";
import { insertTestMention } from "@/test/text";

/** drizzle wraps driver errors ("Failed query"); the Postgres message lives on `cause`. */
async function rejectionMessage(tx: Db, run: (tx: Db) => Promise<unknown>): Promise<string> {
  try {
    // savepoint, so the surrounding transaction survives the expected failure
    await tx.transaction(async (sp) => {
      await run(sp);
    });
  } catch (e) {
    const err = e as Error;
    return `${err.message} ${(err.cause as Error | undefined)?.message ?? ""}`;
  }
  throw new Error("expected promise to reject");
}

// Synthetic data outside the pilot box (23.0-23.75 E x 37.0-38.0 N).
async function insertGeoObject(tx: Db): Promise<string> {
  const [row] = await tx
    .insert(geoObjects)
    .values({ type: "bay", origin: "osm", geom: geomFromGeoJson({ type: "Point", coordinates: [21.0, 35.2] }) })
    .returning({ id: geoObjects.id });
  return row!.id;
}

async function insertComputation(tx: Db, geoObjectId: string): Promise<string> {
  const [row] = await tx
    .insert(computations)
    .values({ geoObjectId, kind: "fetch", inputs: { a: 1 }, inputsHash: "h", rulesVersion: "1" })
    .returning({ id: computations.id });
  return row!.id;
}

async function insertReviewDecision(tx: Db): Promise<string> {
  const [task] = await tx
    .insert(reviewTasks)
    .values({ kind: "conflict", subjectType: "place", subjectId: newId(), context: {} })
    .returning({ id: reviewTasks.id });
  const [decision] = await tx
    .insert(reviewDecisions)
    .values({ taskId: task!.id, decision: { ok: true }, decidedBy: "t" })
    .returning({ id: reviewDecisions.id });
  return decision!.id;
}

function factValues(geoObjectId: string, values: Partial<PgInsertValue<typeof facts>>): PgInsertValue<typeof facts> {
  return {
    geoObjectId,
    attribute: "fetch.N",
    value: 1200,
    observedAt: "2026-10-19",
    confidence: 0.8,
    factSchemaVersion: "1",
    ...values,
  };
}

async function insertFact(tx: Db, values: PgInsertValue<typeof facts>): Promise<string> {
  const [row] = await tx.insert(facts).values(values).returning({ id: facts.id });
  return row!.id;
}

describe("computations and facts", () => {
  it.each(["computations", "facts"])("%s rejects UPDATE and DELETE", async (table) => {
    await withRollback(async (tx) => {
      const geoObjectId = await insertGeoObject(tx);
      const computationId = await insertComputation(tx, geoObjectId);
      const id =
        table === "computations"
          ? computationId
          : await insertFact(tx, factValues(geoObjectId, { computationId }));

      const update = await rejectionMessage(tx, (sp) =>
        sp.execute(sql`update ${sql.identifier(table)} set created_at = now() - interval '1 day' where id = ${id}`),
      );
      expect(update).toMatch(new RegExp(`${table} is append-only`));
      const del = await rejectionMessage(tx, (sp) =>
        sp.execute(sql`delete from ${sql.identifier(table)} where id = ${id}`),
      );
      expect(del).toMatch(new RegExp(`${table} is append-only`));
    });
  });

  it("a fact needs exactly one basis", async () => {
    await withRollback(async (tx) => {
      const geoObjectId = await insertGeoObject(tx);
      const computationId = await insertComputation(tx, geoObjectId);
      const reviewDecisionId = await insertReviewDecision(tx);

      const none = await rejectionMessage(tx, (sp) => insertFact(sp, factValues(geoObjectId, {})));
      expect(none).toMatch(/facts_one_basis/);
      const two = await rejectionMessage(tx, (sp) =>
        insertFact(sp, factValues(geoObjectId, { computationId, reviewDecisionId })),
      );
      expect(two).toMatch(/facts_one_basis/);

      await expect(insertFact(tx, factValues(geoObjectId, { reviewDecisionId }))).resolves.toBeTruthy();
    });
  });

  it("a fact from a mention needs a quote", async () => {
    await withRollback(async (tx) => {
      const { mentionId, geoObjectId, chunkId } = await insertTestMention(tx);

      const message = await rejectionMessage(tx, (sp) => insertFact(sp, factValues(geoObjectId, { mentionId })));
      expect(message).toMatch(/facts_quote_for_mention/);

      await expect(
        insertFact(
          tx,
          factValues(geoObjectId, { mentionId, quote: "Good holding in sand", quoteVerified: true, quoteChunkId: chunkId }),
        ),
      ).resolves.toBeTruthy();
    });
  });

  it("a confidence outside 0..1 is rejected", async () => {
    await withRollback(async (tx) => {
      const geoObjectId = await insertGeoObject(tx);
      const computationId = await insertComputation(tx, geoObjectId);
      const message = await rejectionMessage(tx, (sp) =>
        insertFact(sp, factValues(geoObjectId, { computationId, confidence: 1.5 })),
      );
      expect(message).toMatch(/facts_confidence_range/);
    });
  });

  it("(computation_id, attribute) is unique", async () => {
    await withRollback(async (tx) => {
      const geoObjectId = await insertGeoObject(tx);
      const computationId = await insertComputation(tx, geoObjectId);
      await insertFact(tx, factValues(geoObjectId, { computationId, attribute: "fetch.N" }));
      await insertFact(tx, factValues(geoObjectId, { computationId, attribute: "fetch.NE" }));

      const message = await rejectionMessage(tx, (sp) =>
        insertFact(sp, factValues(geoObjectId, { computationId, attribute: "fetch.N" })),
      );
      expect(message).toMatch(/facts_computation_attribute_unique/);
    });
  });

  it("(review_decision_id, attribute) is unique", async () => {
    await withRollback(async (tx) => {
      const geoObjectId = await insertGeoObject(tx);
      const reviewDecisionId = await insertReviewDecision(tx);
      await insertFact(tx, factValues(geoObjectId, { reviewDecisionId, attribute: "anchor_position" }));

      const message = await rejectionMessage(tx, (sp) =>
        insertFact(sp, factValues(geoObjectId, { reviewDecisionId, attribute: "anchor_position" })),
      );
      expect(message).toMatch(/facts_review_decision_attribute_unique/);
    });
  });

  // (mention_id, attribute, extraction_run_id) uniqueness: lib/db/__tests__/text-schema.test.ts
});
