import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { loadConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { geoNames, geoObjects, highlightSelections, placeWebsites, places, subdivisions, tileGeoObjects, tiles } from "@/lib/db/schema";
import { addNames } from "@/lib/domain/gazetteer/names";
import { osmNames } from "@/lib/domain/gazetteer/osm-classify";
import { newPublicId } from "@/lib/domain/ids";
import { withRollback } from "@/test/db";
import { getConfig } from "@/lib/config";
import { signalPage } from "@/test/research-signals";
import { seedDeliverySubdivision } from "@/test/fixtures/delivery/subdivision";
import { spotSchema } from "@/contract/v2";
import { insertNamedObject, insertTestSubdivision } from "@/test/text";
import { SubdivisionNotFound, arrayParam, loadSubdivisionScope } from "../load";
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

describe("loadSubdivisionScope", () => {
  it("ended area is neither searched nor delivered", async () => {
    await withRollback(async (tx) => {
      const f = await seedDeliverySubdivision(tx);
      await tx.execute(sql`update geo_objects set valid_from = current_date - 5, valid_to = current_date - 1 where id = ${f.areaId}`);
      const scope = await loadSubdivisionScope(tx, f.subdivisionId, cfg, await dbToday(tx));
      expect(scope.areas).toEqual([]);
    });
  });

  it("loads the delivered places of the subdivision and leaves out candidates and places of no subdivision", async () => {
    await withRollback(async (tx) => {
      const f = await seedDeliverySubdivision(tx);
      const scope = await loadSubdivisionScope(tx, f.subdivisionId, cfg, await dbToday(tx));
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
        anchor: { lon: f.positions.A[0] + 0.0001, lat: f.positions.A[1] - 0.0005, confidence: 0.3 },
      });
      expect(a.state!.core["shelter.NW"]).toMatchObject({ value: 0.95, origin: "computed" });
      expect(a.state!.core["shelter.N"]).toMatchObject({ value: 0.9, origin: "text", factIds: [f.factId] });
      expect(a.state!.updatedAt.toISOString()).toBe("2026-10-20T08:00:00.000Z");
      // the places without a state: the excluded one
      expect(scope.spots.find((s) => s.publicId === C.publicId)!.state).toBeNull();
      // popularity on the build date: A has the most sources of the confirmed places within the 50 nm neighbourhood
      expect(a.popularity).toBe(1);
      const c = scope.spots.find((s) => s.publicId === C.publicId)!;
      expect(c).toMatchObject({ status: "no_anchoring", statusReason: `restricted:military:${f.restrictedAreaId}`, popularity: null });
      expect(scope.subdivision).toMatchObject({ id: f.subdivisionId, publicId: f.subdivisionPublicId, key: "XT-DELIVERY", name: "Testlandesteil" });
      expect(scope.subdivision.names).toEqual([
        { lang: "de", name: "Testlandesteil" },
        { lang: "en", name: "Test Subdivision" },
      ]);
      expect(scope.subdivision.polygon.type).toBe("MultiPolygon");
      // the sailing area linked to the scope tiles
      expect(scope.areas).toEqual([
        {
          publicId: f.areaPublicId,
          key: "xt-delivery-waters",
          names: [
            { lang: "de", name: "Testrevier" },
            { lang: "en", name: "Test Waters" },
          ],
        },
      ]);
      expect(scope.tiles).toEqual([
        { id: f.tileIds[0], lastRunAt: null, statesAsOf: "2026-10-20" },
        { id: f.tileIds[1], lastRunAt: null, statesAsOf: "2026-10-19" },
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

  it("the state's nearby entries come with the public id, names and position of their geo objects; one without a public id is still loaded", async () => {
    await withRollback(async (tx) => {
      const f = await seedDeliverySubdivision(tx);
      const { A } = f.places;
      const scope = await loadSubdivisionScope(tx, f.subdivisionId, cfg, await dbToday(tx));
      const a = scope.spots.find((s) => s.publicId === A.publicId)!;
      expect(a.nearbyObjects).toEqual([
        { geoObjectId: f.poiId, publicId: f.poiPublicId, name: "Taverna Vathi", names: expect.any(Array), position: { lon: f.positions.T[0], lat: f.positions.T[1] } },
      ]);
      await tx.update(geoObjects).set({ publicId: null }).where(eq(geoObjects.id, f.poiId));
      const without = (await loadSubdivisionScope(tx, f.subdivisionId, cfg, await dbToday(tx))).spots.find((s) => s.publicId === A.publicId)!;
      expect(without.nearbyObjects).toEqual([expect.objectContaining({ geoObjectId: f.poiId, publicId: null })]);
      // an ended object is not loaded at all
      await tx.execute(sql`update geo_objects set valid_from = current_date - 5, valid_to = current_date - 1 where id = ${f.poiId}`);
      const ended = (await loadSubdivisionScope(tx, f.subdivisionId, cfg, await dbToday(tx))).spots.find((s) => s.publicId === A.publicId)!;
      expect(ended.nearbyObjects).toEqual([]);
    });
  });

  it("ownWebsiteDomain is the registrable domain of the newest place website, only when it is bound (F1)", async () => {
    await withRollback(async (tx) => {
      const f = await seedDeliverySubdivision(tx);
      const { A, M } = f.places;
      const domains = async () => {
        const scope = await loadSubdivisionScope(tx, f.subdivisionId, cfg, await dbToday(tx));
        return [A, M].map((p) => scope.spots.find((s) => s.publicId === p.publicId)!.ownWebsiteDomain);
      };
      expect(await domains()).toEqual([null, null]);
      const site = (p: typeof A, url: string, bound: boolean, createdAt: string) =>
        tx.insert(placeWebsites).values({ placeId: p.placeId, geoObjectId: p.geoObjectId, url, urlNormalized: url, origin: "osm", bound, createdAt: new Date(createdAt) });
      await site(A, "https://www.marina-a.example/en/", true, "2026-10-01T08:00:00Z");
      await site(M, "https://marina-m.example/", false, "2026-10-01T08:00:00Z");
      expect(await domains()).toEqual(["marina-a.example", null]);
      // the newest row counts: a later unbound one withdraws the binding
      await site(A, "https://other.example/", false, "2026-10-02T08:00:00Z");
      expect(await domains()).toEqual([null, null]);
    });
  });

  it("independentSources counts the confirmation's sources: two pages of one domain are one", async () => {
    await withRollback(async (tx) => {
      const f = await seedDeliverySubdivision(tx);
      const { A, M } = f.places;
      const config = getConfig();
      const place = { placeId: A.placeId, objectId: A.geoObjectId };
      await signalPage(tx, config, place, { domain: "guide-one.example", quote: "We anchored in the northern corner of the bay overnight" });
      await signalPage(tx, config, place, { domain: "guide-one.example", quote: "Another crew dropped the hook near the beach at sunset" });
      const count = async () => {
        const scope = await loadSubdivisionScope(tx, f.subdivisionId, cfg, await dbToday(tx));
        return [A, M].map((p) => scope.spots.find((s) => s.publicId === p.publicId)!.independentSources);
      };
      expect(await count()).toEqual([1, 0]);
      await signalPage(tx, config, place, { domain: "guide-two.example", quote: "Completely different words about a quiet night at anchor" });
      expect(await count()).toEqual([2, 0]);
    });
  });

  it("the fixture's spots map to contract spots: A complete, B incomplete, C excluded as military", async () => {
    await withRollback(async (tx) => {
      const f = await seedDeliverySubdivision(tx);
      const scope = await loadSubdivisionScope(tx, f.subdivisionId, cfg, await dbToday(tx));
      const results = new Map(scope.spots.map((s) => [s.publicId, mapSpot(s, { regionId: null, cfg })]));
      const spot = (id: string | null) => {
        const r = results.get(id!)!;
        if (!("spot" in r)) throw new Error(`omitted ${r.omitted}`);
        return r.spot;
      };
      expect(results.get(f.places.B.publicId!)).toEqual({ omitted: "incomplete_core" });
      expect(spot(f.places.C.publicId).exclude).toEqual({ excluded: true, reason: "military", detail: "Militärisches Sperrgebiet (ausgeschlossen – keine Schutzwerte)" });
      expect(spot(f.places.M.publicId)).toMatchObject({ kind: "marina", berth: { status: "seasonFull", months: [7, 8] } });
      const a = spot(f.places.A.publicId);
      expect(a.nearby).toEqual([expect.objectContaining({ id: f.poiPublicId, category: "food", distanceM: 1852, access: "foot" })]);
      expect(a.services?.taverna).toBe("seasonal");
      for (const id of [f.places.A, f.places.C, f.places.M].map((p) => p.publicId)) {
        const r = results.get(id!)!;
        if (!("spot" in r)) throw new Error("omitted");
        expect(spotSchema.safeParse({ ...r.spot, asOf: r.asOf }).error?.issues, id!).toBeUndefined();
      }
      expect((results.get(f.places.A.publicId!) as { asOf: string }).asOf).toBe("2026-10-20");
      expect((results.get(f.places.C.publicId!) as { asOf: string | null }).asOf).toBeNull();
    });
  });

  it("a place that ended is not delivered", async () => {
    await withRollback(async (tx) => {
      const f = await seedDeliverySubdivision(tx);
      const today = await dbToday(tx);
      await tx.update(places).set({ validTo: today }).where(eq(places.id, f.places.B.placeId));
      const scope = await loadSubdivisionScope(tx, f.subdivisionId, cfg, today);
      expect(scope.spots.map((s) => s.publicId)).not.toContain(f.places.B.publicId);
    });
  });

  it("delivers a place by its subdivision, not by the tile label: a neighbour's label keeps it here (Kastellorizo)", async () => {
    await withRollback(async (tx) => {
      const f = await seedDeliverySubdivision(tx);
      const today = await dbToday(tx);
      // the east tile is labelled with a neighbour (more of its coast there); M stays on the land of this subdivision
      const neighbour = await insertTestSubdivision(tx, "XT-NEIGHBOUR", [21.25, 35.25, 21.75, 35.5], { country: "XU" });
      await tx.update(tiles).set({ subdivisionId: neighbour.id }).where(eq(tiles.id, f.tileIds[1]));
      const scope = await loadSubdivisionScope(tx, f.subdivisionId, cfg, today);
      expect(scope.spots.map((s) => s.publicId)).toContain(f.places.M.publicId);
      expect(scope.tiles.map((t) => t.id)).toEqual(f.tileIds);
      // the neighbour's package does not take it, though the tile carries its label
      expect((await loadSubdivisionScope(tx, neighbour.id, cfg, today)).spots).toEqual([]);
      // a place reassigned to the neighbour leaves this package and enters the neighbour's
      await tx.update(geoObjects).set({ subdivisionId: neighbour.id }).where(eq(geoObjects.id, f.places.M.geoObjectId));
      expect((await loadSubdivisionScope(tx, f.subdivisionId, cfg, today)).spots.map((s) => s.publicId)).not.toContain(f.places.M.publicId);
      expect((await loadSubdivisionScope(tx, neighbour.id, cfg, today)).spots.map((s) => s.publicId)).toEqual([f.places.M.publicId]);
    });
  });

  it("a partly built subdivision lists every scope tile, the ones without a run with an empty state", async () => {
    await withRollback(async (tx) => {
      const f = await seedDeliverySubdivision(tx);
      const ranAt = new Date("2026-10-18T06:00:00Z");
      await tx.update(tiles).set({ lastRunAt: ranAt }).where(eq(tiles.id, f.tileIds[0]));
      // the east tile is not processed yet: its places are still candidates
      for (const p of [f.places.M, f.places.C]) await tx.update(places).set({ status: "candidate", publicId: null }).where(eq(places.id, p.placeId));
      const scope = await loadSubdivisionScope(tx, f.subdivisionId, cfg, await dbToday(tx));
      expect(scope.tiles).toEqual([
        { id: f.tileIds[0], lastRunAt: ranAt.toISOString(), statesAsOf: "2026-10-20" },
        { id: f.tileIds[1], lastRunAt: null, statesAsOf: null },
      ]);
      expect(scope.spots.map((s) => s.publicId)).toEqual([f.places.A.publicId, f.places.B.publicId].sort());
    });
  });

  it("bbox is the extent of the subdivision's scope tiles", async () => {
    await withRollback(async (tx) => {
      const f = await seedDeliverySubdivision(tx);
      const scope = await loadSubdivisionScope(tx, f.subdivisionId, cfg, await dbToday(tx));
      expect(scope.subdivision.bbox).toEqual([21, 35, 21.5, 35.25]);
    });
  });

  it("a merged place is listed in merged with its target's public id", async () => {
    await withRollback(async (tx) => {
      const f = await seedDeliverySubdivision(tx);
      const { A, B, M } = f.places;
      // B merged into M, M merged into A: B's final target is A (ruling M6-P14)
      await tx.update(places).set({ mergedIntoId: M.placeId, status: "rejected", statusReason: "merged" }).where(eq(places.id, B.placeId));
      await tx.update(places).set({ mergedIntoId: A.placeId, status: "rejected", statusReason: "merged" }).where(eq(places.id, M.placeId));
      const scope = await loadSubdivisionScope(tx, f.subdivisionId, cfg, await dbToday(tx));
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

  it("regions carry centre, radius in nm and the ancestor chain", async () => {
    await withRollback(async (tx) => {
      const f = await seedDeliverySubdivision(tx);
      const scope = await loadSubdivisionScope(tx, f.subdivisionId, cfg, await dbToday(tx));
      expect(scope.regions.map((r) => r.publicId)).toEqual([f.islandPublicId, f.archipelagoPublicId].sort());
      const island = scope.regions.find((r) => r.publicId === f.islandPublicId)!;
      expect(island).toMatchObject({ geoObjectId: f.islandId, type: "island", name: "Nisida", names: [{ lang: "en", name: "Nisida" }] });
      expect(island.parentGeoObjectIds).toEqual([f.archipelagoId, f.regionId]);
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
      expect(archipelago).toMatchObject({ polygon: null, radiusNm: cfg.regions.pointRadiusNm, areaKm2: null, parentGeoObjectIds: [f.regionId], profile: null });
    });
  });

  it("names exclude fallbacks and carry the transliteration as el-Latn (DAT-1)", async () => {
    await withRollback(async (tx) => {
      const f = await seedDeliverySubdivision(tx);
      const names = await tx.execute<{ origin: string }>(sql`select origin from geo_names where geo_object_id = ${f.places.A.geoObjectId}`);
      expect(names.rows.map((r) => r.origin).sort()).toEqual(["fallback", "osm", "osm", "transliteration"]);
      const scope = await loadSubdivisionScope(tx, f.subdivisionId, cfg, await dbToday(tx));
      expect(scope.spots.find((s) => s.publicId === f.places.A.publicId)!.names).toEqual([
        { lang: "el", name: "Όρμος Βαθύ", script: "greek" },
        { lang: "el-Latn", name: "Ormos Vathy", script: "latin" },
        { lang: "en", name: "Vathi Bay", script: "latin" },
      ]);
    });
  });

  it("a transliteration equal to a source name is not delivered twice (DAT-1)", async () => {
    await withRollback(async (tx) => {
      const f = await seedDeliverySubdivision(tx);
      await tx.insert(geoNames).values({
        geoObjectId: f.places.A.geoObjectId, name: "Ormos Vathy", nameNormalized: "ormos vathy", language: "en", script: "latin", origin: "osm",
      });
      const scope = await loadSubdivisionScope(tx, f.subdivisionId, cfg, await dbToday(tx));
      expect(scope.spots.find((s) => s.publicId === f.places.A.publicId)!.names.map((n) => `${n.lang}:${n.name}`)).toEqual([
        "el:Όρμος Βαθύ",
        "en:Ormos Vathy",
        "en:Vathi Bay",
      ]);
    });
  });

  it("a Greek-only spot and island are delivered with their Latin transliteration as name, both scripts in names (DAT-1)", async () => {
    await withRollback(async (tx) => {
      const f = await seedDeliverySubdivision(tx);
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

      const scope = await loadSubdivisionScope(tx, f.subdivisionId, cfg, today);
      const a = scope.spots.find((s) => s.publicId === f.places.A.publicId)!;
      expect(a.name).toBe(transliteration);
      expect(a.names).toEqual([
        { lang: "el", name: "Όρμος Βαθύ", script: "greek" },
        { lang: "el-Latn", name: transliteration, script: "latin" },
      ]);
      const mapped = mapSpot(a, { regionId: null, cfg });
      if (!("spot" in mapped)) throw new Error(`omitted ${mapped.omitted}`);
      expect(spotSchema.safeParse({ ...mapped.spot, asOf: mapped.asOf }).error?.issues).toBeUndefined();
      const island = scope.regions.find((r) => r.publicId === f.islandPublicId)!;
      expect(island.name).toBe("Nisida");
      expect(island.names).toEqual([
        { lang: "el", name: "Νησίδα" },
        { lang: "el-Latn", name: "Nisida" },
      ]);
    });
  });

  it("an object with several Greek names is delivered with the transliteration of its preferred one, a Latin source name ahead of a derived one (W3-I-1)", async () => {
    await withRollback(async (tx) => {
      const f = await seedDeliverySubdivision(tx);
      const today = await dbToday(tx);
      const rename = async (geoObjectId: string, tags: Record<string, string>) => {
        await tx.update(geoNames).set({ validTo: today }).where(eq(geoNames.geoObjectId, geoObjectId));
        await addNames(tx, geoObjectId, osmNames(tags));
      };
      // a: OSM `name` plus an `old_name`, both Greek
      await rename(f.places.A.geoObjectId, { name: "Όρμος Φτερό", old_name: "Αγία Μαρίνα" });
      // b: a Latin OSM `name` plus `name:el`
      await rename(f.places.C.geoObjectId, { name: "Vathi", "name:el": "Βαθύ" });
      // c: OSM `name` plus an `alt_name`, both Greek
      await rename(f.islandId, { name: "Όρμος Φτερό", alt_name: "Άγιος Νικόλαος" });

      const scope = await loadSubdivisionScope(tx, f.subdivisionId, cfg, today);
      const a = scope.spots.find((s) => s.publicId === f.places.A.publicId)!;
      expect.soft(a.name).toBe("Ormos Ftero");
      // the old name's transliteration stays in names
      expect(a.names.map((n) => `${n.lang}:${n.name}`)).toEqual(["el:Αγία Μαρίνα", "el:Όρμος Φτερό", "el-Latn:Agia Marina", "el-Latn:Ormos Ftero"]);
      expect.soft(scope.spots.find((s) => s.publicId === f.places.C.publicId)!.name).toBe("Vathi");
      expect.soft(scope.regions.find((r) => r.publicId === f.islandPublicId)!.name).toBe("Ormos Ftero");
    });
  });

  it("a German or English name stays ahead of a Latin transliteration (DAT-1)", async () => {
    await withRollback(async (tx) => {
      const f = await seedDeliverySubdivision(tx);
      const scope = await loadSubdivisionScope(tx, f.subdivisionId, cfg, await dbToday(tx));
      expect(scope.spots.find((s) => s.publicId === f.places.A.publicId)!.name).toBe("Vathi Bay");
    });
  });

  it("leaves out rejected and abandoned places (a later step reports them as removed)", async () => {
    await withRollback(async (tx) => {
      const f = await seedDeliverySubdivision(tx);
      await tx.update(places).set({ status: "rejected" }).where(eq(places.id, f.places.B.placeId));
      await tx.update(places).set({ status: "abandoned" }).where(eq(places.id, f.places.M.placeId));
      const scope = await loadSubdivisionScope(tx, f.subdivisionId, cfg, await dbToday(tx));
      expect(scope.spots.map((s) => s.publicId)).toEqual([f.places.A, f.places.C].map((p) => p.publicId).sort());
      expect(scope.merged).toEqual([]);
    });
  });

  it("throws SubdivisionNotFound for an unknown id, a geo object id and an ended subdivision", async () => {
    await withRollback(async (tx) => {
      const f = await seedDeliverySubdivision(tx);
      const today = await dbToday(tx);
      await expect(loadSubdivisionScope(tx, "01a15602-0000-7000-8000-0000000000ee", cfg, today)).rejects.toBeInstanceOf(SubdivisionNotFound);
      await expect(loadSubdivisionScope(tx, f.regionId, cfg, today)).rejects.toBeInstanceOf(SubdivisionNotFound);
      await tx.update(subdivisions).set({ validTo: today }).where(eq(subdivisions.id, f.subdivisionId));
      await expect(loadSubdivisionScope(tx, f.subdivisionId, cfg, today)).rejects.toBeInstanceOf(SubdivisionNotFound);
    });
  });

  it("leaves out a POI of no subdivision, even one linked to a scope tile", async () => {
    await withRollback(async (tx) => {
      const f = await seedDeliverySubdivision(tx);
      const outside = await insertNamedObject(tx, { type: "poi", names: [{ name: "Taverna Fern" }], lon: 21.6, lat: 35.1, category: "food", tiles: [f.outsideTileId] });
      await tx.update(geoObjects).set({ publicId: newPublicId("hl") }).where(eq(geoObjects.id, outside));
      // linked to a scope tile, but it belongs to no subdivision (`subdivision_id` null); A even selects it
      await tx.insert(tileGeoObjects).values({ tileId: f.tileIds[1], geoObjectId: outside });
      await tx.insert(highlightSelections).values({ placeGeoObjectId: f.places.A.geoObjectId, poiGeoObjectId: outside, category: "food", rank: 2, distanceKm: 40, profileVersion: 1 });
      const scope = await loadSubdivisionScope(tx, f.subdivisionId, cfg, await dbToday(tx));
      expect(scope.pois.map((p) => p.geoObjectId)).toEqual([f.poiId]);
    });
  });

  it("loads only the POIs a counting place of the subdivision selected, with the selecting places (spec 16)", async () => {
    await withRollback(async (tx) => {
      const f = await seedDeliverySubdivision(tx);
      const today = await dbToday(tx);
      const [lon, lat] = f.positions.T;
      const poi = async (name: string) => {
        const id = await insertNamedObject(tx, { type: "poi", names: [{ name }], lon, lat: lat - 0.01, category: "culture", tiles: [f.tileIds[0]], subdivisionId: f.subdivisionId });
        await tx.update(geoObjects).set({ publicId: newPublicId("hl") }).where(eq(geoObjects.id, id));
        return id;
      };
      const unselected = await poi("Kastro");
      const byRejected = await poi("Moni");
      await tx.insert(highlightSelections).values({ placeGeoObjectId: f.places.B.geoObjectId, poiGeoObjectId: byRejected, category: "culture", rank: 1, distanceKm: 3, profileVersion: 1 });
      await tx.update(places).set({ status: "rejected" }).where(eq(places.id, f.places.B.placeId));

      const scope = await loadSubdivisionScope(tx, f.subdivisionId, cfg, today);
      expect(scope.pois.map((p) => p.geoObjectId)).toEqual([f.poiId]);
      expect(scope.pois.map((p) => p.geoObjectId)).not.toContain(unselected);
      const selectedBy = [...scope.pois[0]!.selectedBy].sort((a, b) => a.distanceKm - b.distanceKm);
      expect(selectedBy.map((s) => s.placeGeoObjectId)).toEqual([f.places.A.geoObjectId, f.places.M.geoObjectId]);
      expect(selectedBy[0]!.distanceKm).toBeCloseTo(1.85, 1);
    });
  });

  it("follows a merge to a target of no subdivision or one that ended (Task 9 checks it is delivered)", async () => {
    await withRollback(async (tx) => {
      const f = await seedDeliverySubdivision(tx);
      const { A, B, M, O } = f.places;
      const merge = (from: string, into: string) =>
        tx.update(places).set({ mergedIntoId: into, status: "rejected", statusReason: "merged" }).where(eq(places.id, from));
      await merge(B.placeId, O.placeId);
      await merge(M.placeId, A.placeId);
      const today = await dbToday(tx);
      await tx.update(places).set({ validTo: today }).where(eq(places.id, A.placeId));
      const scope = await loadSubdivisionScope(tx, f.subdivisionId, cfg, today);
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
      const f = await seedDeliverySubdivision(tx);
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
      const a = (await loadSubdivisionScope(tx, f.subdivisionId, cfg, tomorrow)).spots.find((s) => s.publicId === f.places.A.publicId)!;
      expect(a.name).toBe("Vathi-Bucht");
      expect(a.names).toContainEqual({ lang: "de", name: "Vathi-Bucht", script: "latin" });
      const now = (await loadSubdivisionScope(tx, f.subdivisionId, cfg, await dbToday(tx))).spots.find((s) => s.publicId === f.places.A.publicId)!;
      expect(now.name).toBe("Vathi Bay");
    });
  });

  it("radiusNm is measured on the simplified polygon", async () => {
    await withRollback(async (tx) => {
      const f = await seedDeliverySubdivision(tx);
      const publicId = newPublicId("rg");
      // A 660 m × 3814 m island (UTM 34N) with a 45 m bump at each end: within the 50 m simplification tolerance, so the
      // simplified polygon keeps the four corners (1.046 nm from the centre, radius 1.0), while the bumps lie 1.055 nm
      // out (radius 1.1 on the full geometry). Its east side starts at ±500 m, which centres ST_PointOnSurface.
      const { rows } = await tx.execute<{ id: string }>(sql`
        with c as (select ST_Transform(ST_SetSRID(ST_MakePoint(21.4, 35.12), 4326), 32634) as p)
        insert into geo_objects (id, type, origin, geom, public_id, subdivision_id)
        select gen_random_uuid(), 'island', 'osm', ST_Transform(ST_Translate(ST_GeomFromText(
          'POLYGON((330 -500, 330 500, 330 1907, 0 1952, -330 1907, -330 -1907, 0 -1952, 330 -1907, 330 -500))', 32634), ST_X(c.p), ST_Y(c.p)), 4326), ${publicId},
          ${f.subdivisionId}
        from c returning id`);
      const id = rows[0]!.id;
      await tx.insert(geoNames).values({ geoObjectId: id, name: "Makri", nameNormalized: "makri", language: "en", script: "latin", origin: "osm" });
      await tx.insert(tileGeoObjects).values({ tileId: f.tileIds[1], geoObjectId: id });
      const region = (await loadSubdivisionScope(tx, f.subdivisionId, cfg, await dbToday(tx))).regions.find((r) => r.publicId === publicId)!;
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
