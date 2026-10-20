import { describe, expect, it } from "vitest";
import type { SpotsFile } from "@/contract";
import { profileSummaries } from "@/lib/db/schema";
import { insertProfile, provenanceEntry } from "@/test/consolidation";
import { withRollback } from "@/test/db";
import { seedDeliveryArea, SPOT_A_ATTRIBUTES, SPOT_A_SUMMARY, spotAProvenance } from "@/test/fixtures/delivery/area";
import { memoryArchive } from "@/test/s3";
import { buildDelivery } from "../build";
import { placeDelivery } from "../view";

/*
 * The place page's delivery tab (plan Task 14): the delivered spot, the preview of the next package from the build's
 * own assembly (`draftArea`, ruling M6-P27) and the contract versions. Built today: the fixture's geo rows are valid
 * from the database's `current_date`, and the preview is drafted on the same day.
 */

const now = new Date();
const today = now.toISOString().slice(0, 10);

describe("placeDelivery", () => {
  it("shows the delivered spot and no difference right after a build", () =>
    withRollback(async (tx) => {
      const archive = memoryArchive();
      const f = await seedDeliveryArea(tx);
      const built = await buildDelivery(tx, archive, f.areaId, { now, inCallerTransaction: true });
      expect(built).toMatchObject({ status: "valid", dataVersion: 1 });
      const stored = JSON.parse(new TextDecoder().decode((await archive.get(`deliveries/${f.areaPublicId}/1/spots.json`))!)) as SpotsFile;
      const a = stored.spots.find((s) => s.id === f.places.A.publicId)!;

      const tab = await placeDelivery(tx, archive, f.places.A.placeId, { today });
      expect(tab.delivered).toEqual({ spot: a, dataVersion: 1, deliveryId: built.deliveryId });
      const body: Record<string, unknown> = { ...a };
      delete body.profileVersion;
      delete body.validFrom;
      expect(tab.preview).toEqual({ spot: body, differs: false });
      expect(tab.history).toEqual([{ profileVersion: 1, validFrom: today, removed: false, deliveryId: built.deliveryId }]);
    }));

  it("a newer profile shows a differing preview", () =>
    withRollback(async (tx) => {
      const archive = memoryArchive();
      const f = await seedDeliveryArea(tx);
      await buildDelivery(tx, archive, f.areaId, { now, inCallerTransaction: true });
      await insertProfile(
        tx,
        f.places.A.geoObjectId,
        { ...SPOT_A_ATTRIBUTES, anchor_position: { lon: 21.1301, lat: 35.1445 }, "place.position": { lon: f.positions.A[0], lat: f.positions.A[1] }, "shelter.E": 0.8 },
        { ...spotAProvenance(f.factId), "place.position": provenanceEntry("gazetteer", { confidence: 1 }) },
        { version: 2, sourcesCount: 3, documentsCount: 1, confidence: 0.72 },
      );
      await tx.insert(profileSummaries).values({ geoObjectId: f.places.A.geoObjectId, profileVersion: 2, text: SPOT_A_SUMMARY, status: "ok", attempts: 1, model: "test", promptVersion: 1 });

      const tab = await placeDelivery(tx, archive, f.places.A.placeId, { today });
      expect(tab.delivered?.spot.shelter.sectors.E).toBe(0.4);
      expect(tab.preview).toMatchObject({ differs: true, spot: { id: f.places.A.publicId, shelter: { sectors: { E: 0.8 } } } });
      // nothing was built: still the one version
      expect(tab.history).toHaveLength(1);
      // the marina M did not change
      expect((await placeDelivery(tx, archive, f.places.M.placeId, { today })).preview).toMatchObject({ differs: false });
    }));

  it("a candidate without public id has no delivery tab content", () =>
    withRollback(async (tx) => {
      const archive = memoryArchive();
      const f = await seedDeliveryArea(tx);
      await buildDelivery(tx, archive, f.areaId, { now, inCallerTransaction: true });
      expect(await placeDelivery(tx, archive, f.places.K.placeId, { today })).toEqual({ delivered: null, preview: null, history: [] });
      // a confirmed place the package leaves out, and one whose tile belongs to no area
      expect(await placeDelivery(tx, archive, f.places.B.placeId, { today })).toEqual({ delivered: null, preview: { omitted: "shelter_incomplete" }, history: [] });
      expect(await placeDelivery(tx, archive, f.places.O.placeId, { today })).toEqual({ delivered: null, preview: { omitted: "no_area" }, history: [] });
    }));

  it("before the first package the preview is new", () =>
    withRollback(async (tx) => {
      const archive = memoryArchive();
      const f = await seedDeliveryArea(tx);
      const tab = await placeDelivery(tx, archive, f.places.A.placeId, { today });
      expect(tab).toMatchObject({ delivered: null, preview: { differs: true, spot: { id: f.places.A.publicId } }, history: [] });
    }));
});
