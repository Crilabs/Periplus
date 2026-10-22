import { sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { getConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import type { PlaceKind } from "@/lib/db/schema";
import { consolidationConfigFor } from "@/lib/domain/consolidation/active-rules";
import { loadInputs } from "@/lib/domain/consolidation/inputs";
import { attributeIn } from "@/lib/domain/consolidation/weights";
import { getFactSchema } from "@/lib/domain/facts/schema";
import { berthEvidence } from "@/lib/domain/places/evidence";
import { factFrom, pageFact, placeOf, routeStopOf } from "@/test/confirmation";
import { insertSource } from "@/test/consolidation";
import { testDb, withRollback } from "@/test/db";

/* The evidence rule per place kind (spec 17 „Belegregel je Ortsart“), on inputs loaded as the consolidation loads them. */

let today = "";
beforeAll(async () => {
  const { rows } = await testDb().execute<{ today: string }>(sql`select current_date::text as today`);
  today = rows[0]!.today;
});

async function evidenceOf(tx: Db, place: { objectId: string; placeId: string }, kind: PlaceKind = "anchorage", tags: Record<string, string> = {}) {
  const cfg = getConfig();
  const rules = await consolidationConfigFor(tx);
  const { inputs } = await loadInputs(tx, place.objectId, { cfg: rules, schemaVersion: cfg.factSchema.version, appConfig: cfg, today });
  return berthEvidence(tx, { geoObjectId: place.objectId, placeId: place.placeId, kind, tags, today }, inputs, cfg);
}

describe("berthEvidence", () => {
  it("lists only berth attributes that exist on the place level of the active fact schema", () => {
    const keys = getFactSchema(getConfig().factSchema.version).levels.place.map((d) => d.key);
    for (const pattern of getConfig().delivery.confirmation.berthAttributes) {
      expect(keys.some((k) => attributeIn(k, [pattern])), pattern).toBe(true);
    }
  });

  it("one pilot guide with an anchoring fact confirms alone", () =>
    withRollback(async (tx) => {
      const place = await placeOf(tx);
      const f = await factFrom(tx, place.objectId, { docType: "pilot_guide" });
      expect(await evidenceOf(tx, place)).toEqual({ rule: "alone", factIds: [f.factId], documentIds: [f.documentId], routeStopIds: [] });
    }));

  it("one trip report is not enough; two on two domains are a pair; two on one domain are not", () =>
    withRollback(async (tx) => {
      const one = await placeOf(tx);
      await factFrom(tx, one.objectId);
      expect(await evidenceOf(tx, one)).toBeNull();

      const sameDomain = await placeOf(tx);
      const source = await insertSource(tx, "trip_report", 0.6);
      await factFrom(tx, sameDomain.objectId, { sourceId: source });
      await factFrom(tx, sameDomain.objectId, { sourceId: source, attribute: "seabed", value: "sand" });
      expect(await evidenceOf(tx, sameDomain)).toBeNull();

      const pair = await placeOf(tx);
      const a = await factFrom(tx, pair.objectId);
      const b = await factFrom(tx, pair.objectId, { docType: "forum", attribute: "mooring.types", value: ["anchor"] });
      expect(await evidenceOf(tx, pair)).toEqual({
        rule: "pair",
        factIds: [a.factId, b.factId].sort(),
        documentIds: [a.documentId, b.documentId].sort(),
        routeStopIds: [],
      });
    }));

  it("a mention without a berth fact does not count (Review Focus 3)", () =>
    withRollback(async (tx) => {
      const place = await placeOf(tx);
      await factFrom(tx, place.objectId, { docType: "pilot_guide", attribute: "services.water", value: true });
      await factFrom(tx, place.objectId, { docType: "trip_report", attribute: "highlight.beach", value: { present: true, names: [] } });
      expect(await evidenceOf(tx, place)).toBeNull();
    }));

  it("a dataset and a marina page bound elsewhere never count; a false berthable is no berth evidence", () =>
    withRollback(async (tx) => {
      const place = await placeOf(tx, { kind: "mooring_field" });
      await factFrom(tx, place.objectId, { docType: "dataset" });
      await factFrom(tx, place.objectId, { docType: "marina" });
      // „private moorings only“
      await factFrom(tx, place.objectId, { docType: "pilot_guide", attribute: "berthable", value: false });
      expect(await evidenceOf(tx, place, "mooring_field")).toBeNull();
    }));

  it("a route stop counts when its unit has an active extraction run, not when only a v2 run extracted it (Review Focus 5)", () =>
    withRollback(async (tx) => {
      const active = await placeOf(tx);
      const fact = await factFrom(tx, active.objectId);
      const stop = await routeStopOf(tx, active.objectId);
      expect(await evidenceOf(tx, active)).toEqual({
        rule: "pair",
        factIds: [fact.factId],
        documentIds: [fact.documentId, stop.documentId].sort(),
        routeStopIds: [stop.stopId],
      });

      const old = await placeOf(tx);
      await factFrom(tx, old.objectId);
      await routeStopOf(tx, old.objectId, { factSchema: "v2" });
      expect(await evidenceOf(tx, old)).toBeNull();
    }));

  it("a marina is confirmed by berthable from a page bound to it, not from an unbound page (Review Focus 2)", () =>
    withRollback(async (tx) => {
      const bound = await placeOf(tx, { kind: "marina" });
      const f = await pageFact(tx, bound.objectId, { bound: true });
      expect(await evidenceOf(tx, bound, "marina")).toEqual({ rule: "own_website", factIds: [f.factId], documentIds: [f.documentId], routeStopIds: [] });

      const municipality = await placeOf(tx, { kind: "marina" });
      await pageFact(tx, municipality.objectId, { bound: false });
      expect(await evidenceOf(tx, municipality, "marina")).toBeNull();

      // its own website saying „no visitors“ (berthable false) does not confirm it
      const noVisitors = await placeOf(tx, { kind: "marina" });
      await pageFact(tx, noVisitors.objectId, { bound: true, value: false });
      expect(await evidenceOf(tx, noVisitors, "marina")).toBeNull();
    }));

  it("a marina is also confirmed by berth evidence from sources", () =>
    withRollback(async (tx) => {
      const place = await placeOf(tx, { kind: "marina" });
      const f = await factFrom(tx, place.objectId, { docType: "pilot_guide", attribute: "berthable", value: true });
      expect(await evidenceOf(tx, place, "marina")).toMatchObject({ rule: "alone", factIds: [f.factId] });
    }));

  it("a port is confirmed by kind evidence port, berthable false or clearly commercial OSM tags", () =>
    withRollback(async (tx) => {
      const byKind = await placeOf(tx, { kind: "port" });
      const k = await factFrom(tx, byKind.objectId, { attribute: "place.kind_evidence", value: "port" });
      expect(await evidenceOf(tx, byKind, "port")).toEqual({ rule: "commercial_port", factIds: [k.factId], documentIds: [k.documentId], routeStopIds: [] });

      const byBerth = await placeOf(tx, { kind: "port" });
      const b = await factFrom(tx, byBerth.objectId, { attribute: "berthable", value: false });
      expect(await evidenceOf(tx, byBerth, "port")).toMatchObject({ rule: "commercial_port", factIds: [b.factId] });

      const fishing = await placeOf(tx, { kind: "port" });
      expect(await evidenceOf(tx, fishing, "port", { "harbour:category": "fishing" })).toEqual({ rule: "osm_commercial", factIds: [], documentIds: [], routeStopIds: [] });
      expect(await evidenceOf(tx, fishing, "port", { "seamark:harbour:category": "ferry_terminal" })).toMatchObject({ rule: "osm_commercial" });
      expect(await evidenceOf(tx, fishing, "port", { "harbour:category": "fishing", leisure: "marina" })).toBeNull();
      expect(await evidenceOf(tx, fishing, "port", { "harbour:category": "marina" })).toBeNull();
      // anchoring facts say nothing about a port
      await factFrom(tx, fishing.objectId, { docType: "pilot_guide" });
      expect(await evidenceOf(tx, fishing, "port")).toBeNull();
    }));
});
