import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { loadConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { places } from "@/lib/db/schema";
import { insertMention, insertMentionFact, insertExtraction, insertProfile, provenanceEntry } from "@/test/consolidation";
import { withRollback } from "@/test/db";
import { seedDeliveryArea, spotAProvenance, SPOT_A_ATTRIBUTES } from "@/test/fixtures/delivery/area";
import { spotSchema } from "@/contract/v1";
import { loadAreaScope } from "../load";
import { mapSpot } from "../map-spot";

const cfg = loadConfig("config").delivery;

/** The database's date: fixture rows are valid from `current_date`. */
async function dbToday(tx: Db): Promise<string> {
  const { rows } = await tx.execute<{ today: string }>(sql`select current_date::text as today`);
  return rows[0]!.today;
}

describe("loadAreaScope", () => {
  it("loads the delivered places of the area's tiles and leaves out candidates and other areas", async () => {
    await withRollback(async (tx) => {
      const f = await seedDeliveryArea(tx);
      const scope = await loadAreaScope(tx, f.areaId, cfg, await dbToday(tx));
      const { A, M, B, C } = f.places;
      expect(scope.spots.map((s) => s.publicId)).toEqual([A, M, B, C].map((p) => p.publicId).sort());
      const a = scope.spots.find((s) => s.publicId === A.publicId)!;
      expect(a).toMatchObject({
        placeId: A.placeId,
        geoObjectId: A.geoObjectId,
        kind: "anchorage",
        status: "confirmed",
        statusReason: null,
        position: { lon: f.positions.A[0], lat: f.positions.A[1] },
        name: "Vathi Bay",
        osmId: "way/123456789",
        wikidataId: null,
        summary: "Tiefe Bucht mit gutem Schutz von West bis Nord, Sandgrund mit Seegras.",
      });
      expect(a.profile).toMatchObject({ version: 1, confidence: 0.72, sourcesCount: 3 });
      expect(a.profile!.attributes["shelter.NW"]).toBe(0.95);
      // popularity on the build date: A has the most sources of the area's confirmed places
      expect(a.popularity).toBe(1);
      const c = scope.spots.find((s) => s.publicId === C.publicId)!;
      expect(c).toMatchObject({ status: "no_anchoring", statusReason: `restricted:military:${f.restrictedAreaId}`, popularity: null });
      expect(scope.area).toMatchObject({ geoObjectId: f.areaId, publicId: f.areaPublicId, key: "delivery-test", name: "Testrevier" });
      expect(scope.area.names).toEqual([
        { lang: "de", name: "Testrevier" },
        { lang: "en", name: "Test Waters" },
      ]);
      expect(scope.area.polygon.type).toBe("Polygon");
      expect(scope.tiles).toEqual([
        { id: f.tileIds[0], lastRunAt: null, profilesAsOf: "2026-10-19" },
        { id: f.tileIds[1], lastRunAt: null, profilesAsOf: "2026-10-19" },
      ]);
      expect(scope.pois).toEqual([
        expect.objectContaining({ geoObjectId: f.poiId, publicId: f.poiPublicId, category: "food", name: "Taverna Vathi", sources: [] }),
      ]);
      expect(scope.pois[0]!.profile!.attributes["derived.importance"]).toBe(2);
      expect(scope.passages).toEqual([
        expect.objectContaining({ geoObjectId: f.capeId, type: "cape", name: "Akra Test", point: { lon: 21.2, lat: 35.15 } }),
      ]);
    });
  });

  it("the fixture's spots map to contract spots: A complete, B incomplete, C excluded as military", async () => {
    await withRollback(async (tx) => {
      const f = await seedDeliveryArea(tx);
      const scope = await loadAreaScope(tx, f.areaId, cfg, await dbToday(tx));
      const results = new Map(scope.spots.map((s) => [s.publicId, mapSpot(s, { regionId: null, highlightIds: [], cfg })]));
      const spot = (id: string | null) => {
        const r = results.get(id!)!;
        if (!("spot" in r)) throw new Error(`omitted ${r.omitted}`);
        return r.spot;
      };
      expect(results.get(f.places.B.publicId!)).toEqual({ omitted: "shelter_incomplete" });
      expect(spot(f.places.C.publicId).exclude).toEqual({ excluded: true, reason: "military", detail: "Militärisches Sperrgebiet" });
      expect(spot(f.places.M.publicId)).toMatchObject({ kind: "marina", berth: { status: "seasonFull", months: [7, 8] } });
      const a = spot(f.places.A.publicId);
      // the version of the fact was fetched (observed) on 2026-10-19
      expect(a.sources).toEqual([{ url: f.documentUrl, kind: "tripReport", observedAt: "2026-10-19" }]);
      for (const id of [f.places.A, f.places.C, f.places.M].map((p) => p.publicId)) {
        expect(spotSchema.safeParse({ ...spot(id), profileVersion: 1, validFrom: "2026-10-19" }).error?.issues, id!).toBeUndefined();
      }
    });
  });

  it("a place that ended is not delivered", async () => {
    await withRollback(async (tx) => {
      const f = await seedDeliveryArea(tx);
      const today = await dbToday(tx);
      await tx.update(places).set({ validTo: today }).where(eq(places.id, f.places.B.placeId));
      const scope = await loadAreaScope(tx, f.areaId, cfg, today);
      expect(scope.spots.map((s) => s.publicId)).not.toContain(f.places.B.publicId);
    });
  });

  it("bbox is the extent of the area's tiles", async () => {
    await withRollback(async (tx) => {
      const f = await seedDeliveryArea(tx);
      const scope = await loadAreaScope(tx, f.areaId, cfg, await dbToday(tx));
      expect(scope.area.bbox).toEqual([21, 35, 21.5, 35.25]);
    });
  });

  it("a merged place is listed in merged with its target's public id", async () => {
    await withRollback(async (tx) => {
      const f = await seedDeliveryArea(tx);
      const { A, B, M } = f.places;
      // B merged into M, M merged into A: B's final target is A (ruling M6-P14)
      await tx.update(places).set({ mergedIntoId: M.placeId, status: "rejected", statusReason: "merged" }).where(eq(places.id, B.placeId));
      await tx.update(places).set({ mergedIntoId: A.placeId, status: "rejected", statusReason: "merged" }).where(eq(places.id, M.placeId));
      const scope = await loadAreaScope(tx, f.areaId, cfg, await dbToday(tx));
      expect(scope.merged).toEqual(
        [
          { publicId: B.publicId, mergedIntoPublicId: A.publicId },
          { publicId: M.publicId, mergedIntoPublicId: A.publicId },
        ].sort((a, b) => (a.publicId! < b.publicId! ? -1 : 1)),
      );
      expect(scope.spots.map((s) => s.publicId)).not.toContain(B.publicId);
      expect(scope.spots.map((s) => s.publicId)).not.toContain(M.publicId);
    });
  });

  it("spot sources are the documents of the provenance facts, newest observation per url, no quote", async () => {
    await withRollback(async (tx) => {
      const f = await seedDeliveryArea(tx);
      const { A } = f.places;
      // The fact's version states 2025-06-10; a newer version of the same document is classified as a pilot guide.
      await tx.execute(sql`update document_versions v set classified_observed_at = '2025-06-10' from facts f join mentions m on m.id = f.mention_id where f.id = ${f.factId} and v.id = m.document_version_id`);
      const m = await insertMention(tx, A.geoObjectId, { documentId: f.documentId, observedAt: "2026-05-02" });
      await tx.execute(sql`update document_versions set classified_doc_type = 'pilot_guide', classified_observed_at = '2026-05-03' where id = ${m.versionId}`);
      const newer = await insertMentionFact(tx, A.geoObjectId, m, await insertExtraction(tx, A.geoObjectId, m), { attribute: "holding", value: "good" });
      // A fact of another document that no provenance cites stays out.
      const uncited = await insertMention(tx, A.geoObjectId, { observedAt: "2026-07-01" });
      await insertMentionFact(tx, A.geoObjectId, uncited, await insertExtraction(tx, A.geoObjectId, uncited));
      const provenance = spotAProvenance(f.factId);
      provenance["holding"] = provenanceEntry("text", { factIds: [newer], observedAt: "2026-05-03" });
      await insertProfile(tx, A.geoObjectId, SPOT_A_ATTRIBUTES, provenance, { version: 2 });

      const scope = await loadAreaScope(tx, f.areaId, cfg, await dbToday(tx));
      const a = scope.spots.find((s) => s.publicId === A.publicId)!;
      expect(a.profile!.version).toBe(2);
      expect(a.sources).toEqual([{ url: f.documentUrl, docType: "pilot_guide", observedAt: "2026-05-03" }]);
      expect(JSON.stringify(a.sources)).not.toMatch(/good holding in sand/);
      // the summary belongs to version 1, not to the latest version 2 (ruling M6-P9)
      expect(a.summary).toBeNull();
    });
  });

  it("regions carry centre, radius in nm and the ancestor chain", async () => {
    await withRollback(async (tx) => {
      const f = await seedDeliveryArea(tx);
      const scope = await loadAreaScope(tx, f.areaId, cfg, await dbToday(tx));
      expect(scope.regions.map((r) => r.publicId)).toEqual([f.islandPublicId, f.archipelagoPublicId].sort());
      const island = scope.regions.find((r) => r.publicId === f.islandPublicId)!;
      expect(island).toMatchObject({ geoObjectId: f.islandId, type: "island", name: "Nisida", names: [{ lang: "en", name: "Nisida" }] });
      expect(island.parentGeoObjectIds).toEqual([f.archipelagoId, f.areaId]);
      expect(island.polygon?.type).toBe("Polygon");
      const ring = (island.polygon as GeoJSON.Polygon).coordinates[0]!;
      for (const [lon, lat] of ring) {
        expect(Number(lon!.toFixed(5))).toBe(lon);
        expect(Number(lat!.toFixed(5))).toBe(lat);
      }
      // the centre lies on the surface; the farthest corner is ~5 nm away
      expect(island.center.lon).toBeGreaterThan(21.05);
      expect(island.center.lon).toBeLessThan(21.2);
      expect(island.radiusNm).toBeGreaterThan(4);
      expect(island.radiusNm).toBeLessThan(8);
      expect(Number(island.radiusNm.toFixed(1))).toBe(island.radiusNm);
      expect(island.areaKm2).toBeGreaterThan(100);
      expect(island.profile!.attributes).toMatchObject({ meltemi_exposure: 0.7, ferry_traffic: "high", charter_bases: ["X"] });
      const archipelago = scope.regions.find((r) => r.publicId === f.archipelagoPublicId)!;
      expect(archipelago).toMatchObject({ polygon: null, radiusNm: cfg.regions.pointRadiusNm, areaKm2: null, parentGeoObjectIds: [f.areaId], profile: null });
    });
  });

  it("names exclude transliterations and fallbacks", async () => {
    await withRollback(async (tx) => {
      const f = await seedDeliveryArea(tx);
      const names = await tx.execute<{ origin: string }>(sql`select origin from geo_names where geo_object_id = ${f.places.A.geoObjectId}`);
      expect(names.rows.map((r) => r.origin).sort()).toEqual(["fallback", "osm", "osm", "transliteration"]);
      const scope = await loadAreaScope(tx, f.areaId, cfg, await dbToday(tx));
      expect(scope.spots.find((s) => s.publicId === f.places.A.publicId)!.names).toEqual([
        { lang: "el", name: "Όρμος Βαθύ", script: "greek" },
        { lang: "en", name: "Vathi Bay", script: "latin" },
      ]);
    });
  });
});
