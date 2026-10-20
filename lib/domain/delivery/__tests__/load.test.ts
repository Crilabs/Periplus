import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { loadConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { documents, geoNames, geoObjects, places, profileSummaries, tileGeoObjects } from "@/lib/db/schema";
import { newPublicId } from "@/lib/domain/ids";
import { insertMention, insertMentionFact, insertExtraction, insertProfile, provenanceEntry } from "@/test/consolidation";
import { withRollback } from "@/test/db";
import { seedDeliveryArea, spotAProvenance, SPOT_A_ATTRIBUTES } from "@/test/fixtures/delivery/area";
import { spotSchema } from "@/contract/v1";
import { insertNamedObject, insertTestRun } from "@/test/text";
import { AreaNotFound, arrayParam, loadAreaScope } from "../load";
import { mapSpot } from "../map-spot";

const cfg = loadConfig("config").delivery;

/** The database's date: fixture rows are valid from `current_date`. */
async function dbToday(tx: Db): Promise<string> {
  const { rows } = await tx.execute<{ today: string }>(sql`select current_date::text as today`);
  return rows[0]!.today;
}

async function dbTomorrow(tx: Db): Promise<string> {
  const { rows } = await tx.execute<{ d: string }>(sql`select (current_date + 1)::text as d`);
  return rows[0]!.d;
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

  it("a regenerated ok summary of the same prompt version replaces the older one (ruling M6-H-R1)", async () => {
    await withRollback(async (tx) => {
      const f = await seedDeliveryArea(tx);
      const { A } = f.places;
      const [old] = await tx.select().from(profileSummaries).where(eq(profileSummaries.geoObjectId, A.geoObjectId));
      await tx.insert(profileSummaries).values({
        geoObjectId: A.geoObjectId,
        profileVersion: 1,
        text: "Neu geschriebene Zusammenfassung der Bucht.",
        status: "ok",
        attempts: 1,
        model: "test",
        promptVersion: old!.promptVersion,
        runId: await insertTestRun(tx),
        createdAt: new Date(old!.createdAt.getTime() + 60_000),
      });
      const scope = await loadAreaScope(tx, f.areaId, cfg, await dbToday(tx));
      expect(scope.spots.find((s) => s.publicId === A.publicId)!.summary).toBe("Neu geschriebene Zusammenfassung der Bucht.");
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

  it("names exclude fallbacks and carry the transliteration as el-Latn (DAT-1)", async () => {
    await withRollback(async (tx) => {
      const f = await seedDeliveryArea(tx);
      const names = await tx.execute<{ origin: string }>(sql`select origin from geo_names where geo_object_id = ${f.places.A.geoObjectId}`);
      expect(names.rows.map((r) => r.origin).sort()).toEqual(["fallback", "osm", "osm", "transliteration"]);
      const scope = await loadAreaScope(tx, f.areaId, cfg, await dbToday(tx));
      expect(scope.spots.find((s) => s.publicId === f.places.A.publicId)!.names).toEqual([
        { lang: "el", name: "Όρμος Βαθύ", script: "greek" },
        { lang: "el-Latn", name: "Ormos Vathy", script: "latin" },
        { lang: "en", name: "Vathi Bay", script: "latin" },
      ]);
    });
  });

  it("a transliteration equal to a source name is not delivered twice (DAT-1)", async () => {
    await withRollback(async (tx) => {
      const f = await seedDeliveryArea(tx);
      await tx.insert(geoNames).values({
        geoObjectId: f.places.A.geoObjectId, name: "Ormos Vathy", nameNormalized: "ormos vathy", language: "en", script: "latin", origin: "osm",
      });
      const scope = await loadAreaScope(tx, f.areaId, cfg, await dbToday(tx));
      expect(scope.spots.find((s) => s.publicId === f.places.A.publicId)!.names.map((n) => `${n.lang}:${n.name}`)).toEqual([
        "el:Όρμος Βαθύ",
        "en:Ormos Vathy",
        "en:Vathi Bay",
      ]);
    });
  });

  it("a Greek-only spot and island are delivered with their Latin transliteration as name, both scripts in names (DAT-1)", async () => {
    await withRollback(async (tx) => {
      const f = await seedDeliveryArea(tx);
      const today = await dbToday(tx);
      // A keeps only its Greek OSM name (and the transliteration written with it)
      await tx
        .update(geoNames)
        .set({ validTo: today })
        .where(sql`${geoNames.geoObjectId} = ${f.places.A.geoObjectId} and ${geoNames.language} in ('de', 'en')`);
      // the island has only a Greek name and its transliteration
      await tx.update(geoNames).set({ validTo: today }).where(eq(geoNames.geoObjectId, f.islandId));
      await tx.insert(geoNames).values([
        { geoObjectId: f.islandId, name: "Νησίδα", nameNormalized: "νησιδα", language: "el", script: "greek", origin: "osm", isPreferred: true },
        { geoObjectId: f.islandId, name: "Nisida", nameNormalized: "nisida", language: "el", script: "latin", origin: "transliteration" },
      ]);
      const { rows: tl } = await tx.execute<{ name: string }>(
        sql`select name from geo_names where geo_object_id = ${f.places.A.geoObjectId} and origin = 'transliteration'`,
      );
      const transliteration = tl[0]!.name;
      expect(transliteration).toMatch(/^Ormos /);

      const scope = await loadAreaScope(tx, f.areaId, cfg, today);
      const a = scope.spots.find((s) => s.publicId === f.places.A.publicId)!;
      expect(a.name).toBe(transliteration);
      expect(a.names).toEqual([
        { lang: "el", name: "Όρμος Βαθύ", script: "greek" },
        { lang: "el-Latn", name: transliteration, script: "latin" },
      ]);
      const mapped = mapSpot(a, { regionId: null, highlightIds: [], cfg });
      if (!("spot" in mapped)) throw new Error(`omitted ${mapped.omitted}`);
      expect(spotSchema.safeParse({ ...mapped.spot, profileVersion: 1, validFrom: "2026-10-19" }).error?.issues).toBeUndefined();
      const island = scope.regions.find((r) => r.publicId === f.islandPublicId)!;
      expect(island.name).toBe("Nisida");
      expect(island.names).toEqual([
        { lang: "el", name: "Νησίδα" },
        { lang: "el-Latn", name: "Nisida" },
      ]);
    });
  });

  it("a German or English name stays ahead of a Latin transliteration (DAT-1)", async () => {
    await withRollback(async (tx) => {
      const f = await seedDeliveryArea(tx);
      const scope = await loadAreaScope(tx, f.areaId, cfg, await dbToday(tx));
      expect(scope.spots.find((s) => s.publicId === f.places.A.publicId)!.name).toBe("Vathi Bay");
    });
  });

  it("leaves out rejected and abandoned places (a later step reports them as removed)", async () => {
    await withRollback(async (tx) => {
      const f = await seedDeliveryArea(tx);
      await tx.update(places).set({ status: "rejected" }).where(eq(places.id, f.places.B.placeId));
      await tx.update(places).set({ status: "abandoned" }).where(eq(places.id, f.places.M.placeId));
      const scope = await loadAreaScope(tx, f.areaId, cfg, await dbToday(tx));
      expect(scope.spots.map((s) => s.publicId)).toEqual([f.places.A, f.places.C].map((p) => p.publicId).sort());
      expect(scope.merged).toEqual([]);
    });
  });

  it("throws AreaNotFound for an unknown id, a non-area object and an area without public id", async () => {
    await withRollback(async (tx) => {
      const f = await seedDeliveryArea(tx);
      const today = await dbToday(tx);
      await expect(loadAreaScope(tx, "01a15602-0000-7000-8000-0000000000ee", cfg, today)).rejects.toBeInstanceOf(AreaNotFound);
      await expect(loadAreaScope(tx, f.islandId, cfg, today)).rejects.toBeInstanceOf(AreaNotFound);
      await tx.update(geoObjects).set({ publicId: null }).where(eq(geoObjects.id, f.areaId));
      await expect(loadAreaScope(tx, f.areaId, cfg, today)).rejects.toBeInstanceOf(AreaNotFound);
    });
  });

  it("leaves out a POI whose centroid lies outside the area's tiles", async () => {
    await withRollback(async (tx) => {
      const f = await seedDeliveryArea(tx);
      const outside = await insertNamedObject(tx, { type: "poi", names: [{ name: "Taverna Fern" }], lon: 21.6, lat: 35.1, category: "food", tiles: [f.outsideTileId] });
      await tx.update(geoObjects).set({ publicId: newPublicId("hl") }).where(eq(geoObjects.id, outside));
      // assigned to an area tile, but its centroid is in the tile of no area
      await tx.insert(tileGeoObjects).values({ tileId: f.tileIds[1], geoObjectId: outside });
      const scope = await loadAreaScope(tx, f.areaId, cfg, await dbToday(tx));
      expect(scope.pois.map((p) => p.geoObjectId)).toEqual([f.poiId]);
    });
  });

  it("follows a merge to a target in another area or one that ended (Task 9 checks it is delivered)", async () => {
    await withRollback(async (tx) => {
      const f = await seedDeliveryArea(tx);
      const { A, B, M, O } = f.places;
      const merge = (from: string, into: string) =>
        tx.update(places).set({ mergedIntoId: into, status: "rejected", statusReason: "merged" }).where(eq(places.id, from));
      await merge(B.placeId, O.placeId);
      await merge(M.placeId, A.placeId);
      const today = await dbToday(tx);
      await tx.update(places).set({ validTo: today }).where(eq(places.id, A.placeId));
      const scope = await loadAreaScope(tx, f.areaId, cfg, today);
      expect(scope.merged).toEqual(
        [
          { publicId: B.publicId, mergedIntoPublicId: O.publicId },
          { publicId: M.publicId, mergedIntoPublicId: A.publicId },
        ].sort((x, y) => (x.publicId! < y.publicId! ? -1 : 1)),
      );
      // neither target is delivered in this package
      expect(scope.spots.map((s) => s.publicId)).toEqual([f.places.C.publicId]);
    });
  });

  it("display names are taken on the build date, not the database date", async () => {
    await withRollback(async (tx) => {
      const f = await seedDeliveryArea(tx);
      const tomorrow = await dbTomorrow(tx);
      await tx.insert(geoNames).values({
        geoObjectId: f.places.A.geoObjectId,
        name: "Vathi-Bucht",
        nameNormalized: "vathi-bucht",
        language: "de",
        script: "latin",
        origin: "manual",
        isPreferred: true,
        validFrom: tomorrow,
      });
      const a = (await loadAreaScope(tx, f.areaId, cfg, tomorrow)).spots.find((s) => s.publicId === f.places.A.publicId)!;
      expect(a.name).toBe("Vathi-Bucht");
      expect(a.names).toContainEqual({ lang: "de", name: "Vathi-Bucht", script: "latin" });
      const now = (await loadAreaScope(tx, f.areaId, cfg, await dbToday(tx))).spots.find((s) => s.publicId === f.places.A.publicId)!;
      expect(now.name).toBe("Vathi Bay");
    });
  });

  it("list attributes cite the facts of their delivered entries only; gone documents are marked gone", async () => {
    await withRollback(async (tx) => {
      const f = await seedDeliveryArea(tx);
      const { A } = f.places;
      const fact = async (observedAt: string) => {
        const m = await insertMention(tx, A.geoObjectId, { observedAt });
        return { id: await insertMentionFact(tx, A.geoObjectId, m, await insertExtraction(tx, A.geoObjectId, m), { attribute: "hazards", value: [] }), documentId: m.documentId };
      };
      const kept = await fact("2026-03-01");
      const removed = await fact("2026-04-01");
      const provenance = spotAProvenance(f.factId);
      // the flat support still holds the fact of an entry a review removed
      provenance["hazards"] = provenanceEntry("text", {
        factIds: [kept.id, removed.id],
        entryFactIds: { rock: [kept.id, "computation:01a15602-0000-7000-8000-0000000000ff"] },
      });
      await insertProfile(tx, A.geoObjectId, SPOT_A_ATTRIBUTES, provenance, { version: 2 });
      const urls = async () => {
        const scope = await loadAreaScope(tx, f.areaId, cfg, await dbToday(tx));
        return scope.spots.find((s) => s.publicId === A.publicId)!.sources.map((s) => (s.gone ? `gone:${s.url}` : s.url)).sort();
      };
      const urlOf = async (documentId: string) => (await tx.select({ url: documents.url }).from(documents).where(eq(documents.id, documentId)))[0]!.url;
      expect(await urls()).toEqual([f.documentUrl, await urlOf(kept.documentId)].sort());
      await tx.update(documents).set({ status: "gone" }).where(eq(documents.id, f.documentId));
      // still loaded for the forbidden-domain check (final review M-1); mapSources never lists it
      expect(await urls()).toEqual([await urlOf(kept.documentId), `gone:${f.documentUrl}`].sort());
    });
  });

  it("radiusNm is measured on the simplified polygon", async () => {
    await withRollback(async (tx) => {
      const f = await seedDeliveryArea(tx);
      const publicId = newPublicId("rg");
      // A 660 m × 3814 m island (UTM 34N) with a 45 m bump at each end: within the 50 m simplification tolerance, so the
      // simplified polygon keeps the four corners (1.046 nm from the centre, radius 1.0), while the bumps lie 1.055 nm
      // out (radius 1.1 on the full geometry). Its east side starts at ±500 m, which centres ST_PointOnSurface.
      const { rows } = await tx.execute<{ id: string }>(sql`
        with c as (select ST_Transform(ST_SetSRID(ST_MakePoint(21.4, 35.12), 4326), 32634) as p)
        insert into geo_objects (id, type, origin, geom, public_id)
        select gen_random_uuid(), 'island', 'osm', ST_Transform(ST_Translate(ST_GeomFromText(
          'POLYGON((330 -500, 330 500, 330 1907, 0 1952, -330 1907, -330 -1907, 0 -1952, 330 -1907, 330 -500))', 32634), ST_X(c.p), ST_Y(c.p)), 4326), ${publicId}
        from c returning id`);
      const id = rows[0]!.id;
      await tx.insert(geoNames).values({ geoObjectId: id, name: "Makri", nameNormalized: "makri", language: "en", script: "latin", origin: "osm" });
      await tx.insert(tileGeoObjects).values({ tileId: f.tileIds[1], geoObjectId: id });
      const region = (await loadAreaScope(tx, f.areaId, cfg, await dbToday(tx))).regions.find((r) => r.publicId === publicId)!;
      // the bumps are gone: four corners, the ring start and its closing point
      expect((region.polygon as GeoJSON.Polygon).coordinates[0]).toHaveLength(6);
      expect(region.radiusNm).toBe(1);
    });
  });

  it("array parameters are bound whole: a comma, brace or quote never splits an element", async () => {
    await withRollback(async (tx) => {
      const values = ["a,b", "{c}", 'd"e', "f"];
      const { rows } = await tx.execute<{ n: number; second: string }>(
        sql`select array_length(${arrayParam(values, "text")}, 1) as n, (${arrayParam(values, "text")})[2] as second`,
      );
      expect(rows[0]).toEqual({ n: 4, second: "{c}" });
    });
  });
});
