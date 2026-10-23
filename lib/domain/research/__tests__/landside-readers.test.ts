import { describe, expect, it } from "vitest";
import { getConfig, getConsolidationConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { berthFacts, berthSignals, documents, landingHints, researchHits, documentVersions, serpQueries, serpResults } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { activeExtractor, loadEvidence } from "@/lib/domain/research/confirmation";
import { landingPoints } from "@/lib/domain/research/landing";
import { coreInputs } from "@/lib/domain/research/state-core";
import { freeFacts, standingFacts } from "@/lib/domain/research/state-facts";
import { researchView } from "@/lib/domain/research/view";
import { insertPlace } from "@/test/consolidation";
import { withRollback } from "@/test/db";
import { seedPage, seedStatement } from "@/test/research-state";

/*
 * A landside unit (plan N4b task 3) is never evidence of a berth: the readers of signals, core values and landing hints
 * count units of kind `berth` only, while the free facts of both kinds reach the berth state.
 */

const config = getConfig();
const rules = getConsolidationConfig(config.consolidation.version);
// a landside unit that carries the berth extractor's model and prompt version: only its kind keeps it out of the berth readers
const asBerth = { kind: "landside" as const, promptVersion: activeExtractor(config).promptVersion, model: activeExtractor(config).model };
const quote = { quote: "synthetic quote text", quoteStart: 0, quoteEnd: 20 };

type Page = { unitId: string; versionId: string };
async function signal(tx: Db, placeId: string, p: Page) {
  await tx.insert(berthSignals).values({ ...quote, unitId: p.unitId, placeId, documentVersionId: p.versionId, kind: "anchored", firstHand: true, confidence: 0.95, observedAt: "2025-06-15", observedAtBasis: "explicit" });
}
async function core(tx: Db, placeId: string, p: Page) {
  await tx.insert(berthFacts).values({ ...quote, unitId: p.unitId, placeId, documentVersionId: p.versionId, attribute: "holding", value: "good", observedAt: "2025-06-15", observedAtBasis: "explicit" });
}
async function hint(tx: Db, placeId: string, p: Page, description: string) {
  await tx.insert(landingHints).values({ ...quote, unitId: p.unitId, placeId, documentVersionId: p.versionId, description, observedAt: "2025-06-15" });
}

describe("landside units and berth evidence", () => {
  it("a signal under a landside unit is no evidence, the same signal under a berth unit is", () =>
    withRollback(async (tx) => {
      const { placeId } = await insertPlace(tx, { status: "candidate" });
      const landside = await seedPage(tx, config, placeId, asBerth);
      await signal(tx, placeId, landside);
      expect((await loadEvidence(tx, [placeId], config)).get(placeId) ?? []).toEqual([]);
      const berth = await seedPage(tx, config, placeId, { domain: "other.example" });
      await signal(tx, placeId, berth);
      expect((await loadEvidence(tx, [placeId], config)).get(placeId)).toHaveLength(1);
    }));

  it("core values and landing hints of a landside unit are ignored", () =>
    withRollback(async (tx) => {
      const { placeId } = await insertPlace(tx, { status: "confirmed" });
      const landside = await seedPage(tx, config, placeId, asBerth);
      await core(tx, placeId, landside);
      await hint(tx, placeId, landside, "pier of the taverna");
      expect(await coreInputs(tx, placeId, config, rules)).toEqual([]);
      expect((await landingPoints(tx, placeId, config)).filter((l) => l.kind === "text")).toEqual([]);

      const berth = await seedPage(tx, config, placeId, { domain: "other.example" });
      await core(tx, placeId, berth);
      await hint(tx, placeId, berth, "beach landing");
      expect(await coreInputs(tx, placeId, config, rules)).toHaveLength(1);
      expect((await landingPoints(tx, placeId, config)).filter((l) => l.kind === "text").map((l) => l.description)).toEqual(["beach landing"]);
    }));

  it("the free facts of both kinds count, a landside unit of another model does not", () =>
    withRollback(async (tx) => {
      const { placeId } = await insertPlace(tx, { status: "confirmed" });
      const landside = await seedPage(tx, config, placeId, { kind: "landside" });
      const berth = await seedPage(tx, config, placeId, { domain: "other.example" });
      const stale = await seedPage(tx, config, placeId, { kind: "landside", model: "old-model" });
      const a = await seedStatement(tx, placeId, landside, { statement: "Taverna by the beach", subjectName: "Taverna Kyma", subjectCategory: "restaurant", observedAt: "2025-05-15" });
      const b = await seedStatement(tx, placeId, berth, { statement: "Quiet at night", observedAt: "2025-06-15" });
      await seedStatement(tx, placeId, stale, { statement: "stale landside" });
      expect((await freeFacts(tx, placeId, config)).map((f) => [f.id, f.subject])).toEqual([[a, "landside"], [b, "berth"]]);
      expect((await standingFacts(tx, placeId, config)).map((f) => f.factId).sort()).toEqual([a, b].sort());
    }));

  it("the research view shows the landside facts of a page but no berth signal from it", () =>
    withRollback(async (tx) => {
      const { placeId, objectId } = await insertPlace(tx, { status: "confirmed" });
      const landside = await seedPage(tx, config, placeId, { kind: "landside" });
      await seedStatement(tx, placeId, landside, { statement: "Taverna by the beach", subjectName: "Taverna Kyma", subjectCategory: "restaurant" });
      await signal(tx, placeId, landside);
      const [doc] = await tx
        .select({ url: documents.urlNormalized, geo: documents.id })
        .from(documentVersions)
        .innerJoin(documents, eq(documents.id, documentVersions.documentId))
        .where(eq(documentVersions.id, landside.versionId));
      const [q] = await tx
        .insert(serpQueries)
        .values({ keyword: "k", languageCode: "en", locationCode: 2300, depth: 10, level: "place", scopeId: objectId, rawKey: "serp/x/landside.json", fetchedAt: new Date() })
        .returning({ id: serpQueries.id });
      const [r] = await tx.insert(serpResults).values({ serpQueryId: q!.id, rank: 1, url: doc!.url, urlNormalized: doc!.url, domain: "guide.example", title: "t", snippet: "s" }).returning({ id: serpResults.id });
      await tx.insert(researchHits).values({ placeId, geoObjectId: objectId, serpQueryId: q!.id, serpResultId: r!.id, urlNormalized: doc!.url, domain: "guide.example", rank: 1, purpose: "landside" });
      const row = (await researchView(tx, placeId)).rows.find((r) => r.url === doc!.url);
      expect(row?.factCount).toBe(1);
      expect(row?.signals).toEqual([]);
      expect(row?.signalCount).toBe(0);
    }));
});
