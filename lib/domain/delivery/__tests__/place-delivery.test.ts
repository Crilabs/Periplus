import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import type { SpotsFile } from "@/contract";
import { tiles } from "@/lib/db/schema";
import { mergePlaceInto } from "@/lib/domain/place-merge";
import { withRollback } from "@/test/db";
import { changeBerthCore, seedDeliverySubdivision } from "@/test/fixtures/delivery/subdivision";
import { memoryArchive } from "@/test/s3";
import { buildDelivery } from "../build";
import { placeDelivery } from "../view";

/*
 * The place page's delivery tab (plan Task 14): the delivered spot, the preview of the next package from the build's
 * own assembly (`draftArea`, ruling M6-P27) and the object versions. Built today: the fixture's geo rows are valid
 * from the database's `current_date`, and the preview is drafted on the same day.
 */

const now = new Date();
const today = now.toISOString().slice(0, 10);

describe("placeDelivery", () => {
  it("shows the delivered spot and no difference right after a build", () =>
    withRollback(async (tx) => {
      const archive = memoryArchive();
      const f = await seedDeliverySubdivision(tx);
      const built = await buildDelivery(tx, archive, f.subdivisionId, { now, inCallerTransaction: true });
      expect(built).toMatchObject({ status: "valid", dataVersion: 1 });
      const stored = JSON.parse(new TextDecoder().decode((await archive.get(`deliveries/${f.subdivisionKey}/1/spots.json`))!)) as SpotsFile;
      const a = stored.spots.find((s) => s.id === f.places.A.publicId)!;

      const tab = await placeDelivery(tx, archive, f.places.A.placeId, { today });
      expect(tab.delivered).toEqual({ spot: a, dataVersion: 1, deliveryId: built.deliveryId });
      // the preview is the body: the spot without its state date
      const { asOf, ...body } = a;
      expect(asOf).toBe("2026-10-20");
      expect(tab.preview).toEqual({ spot: body, differs: false });
      expect(tab.history).toEqual([{ profileVersion: 1, validFrom: today, removed: false, deliveryId: built.deliveryId }]);
    }));

  it("a newer berth state shows a differing preview", () =>
    withRollback(async (tx) => {
      const archive = memoryArchive();
      const f = await seedDeliverySubdivision(tx);
      await buildDelivery(tx, archive, f.subdivisionId, { now, inCallerTransaction: true });
      await changeBerthCore(tx, f.places.A.placeId, { "shelter.E": 0.8 }, new Date("2026-10-23T08:00:00Z"));

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
      const f = await seedDeliverySubdivision(tx);
      await buildDelivery(tx, archive, f.subdivisionId, { now, inCallerTransaction: true });
      expect(await placeDelivery(tx, archive, f.places.K.placeId, { today })).toEqual({ delivered: null, preview: null, history: [] });
      // a confirmed place the package leaves out, and one that belongs to no subdivision
      expect(await placeDelivery(tx, archive, f.places.B.placeId, { today })).toEqual({ delivered: null, preview: { omitted: "incomplete_core" }, history: [] });
      expect(await placeDelivery(tx, archive, f.places.O.placeId, { today })).toEqual({ delivered: null, preview: { omitted: "no_subdivision" }, history: [] });
    }));

  it("before the first package the preview is new", () =>
    withRollback(async (tx) => {
      const archive = memoryArchive();
      const f = await seedDeliverySubdivision(tx);
      const tab = await placeDelivery(tx, archive, f.places.A.placeId, { today });
      expect(tab).toMatchObject({ delivered: null, preview: { differs: true, spot: { id: f.places.A.publicId } }, history: [] });
    }));

  it("a merged place: carried with mergedInto when its target is in the package, else removed (ruling M6-P14, review minor 4)", () =>
    withRollback(async (tx) => {
      const archive = memoryArchive();
      const f = await seedDeliverySubdivision(tx);
      const { A, M, O } = f.places;
      // A and M belong to the fixture's subdivision (a merge within it needs no confirmation), O to none
      await buildDelivery(tx, archive, f.subdivisionId, { now, inCallerTransaction: true });
      await mergePlaceInto(tx, { placeId: A.placeId, intoPlaceId: M.placeId, decidedBy: "admin@test.invalid" });
      expect((await placeDelivery(tx, archive, A.placeId, { today })).preview).toEqual({ omitted: "merged", mergedInto: M.publicId });
      // M merged on into O, a place of no subdivision: the package does not deliver the final target
      await mergePlaceInto(tx, { placeId: M.placeId, intoPlaceId: O.placeId, decidedBy: "admin@test.invalid", confirmAcrossSubdivisions: true });
      expect((await placeDelivery(tx, archive, A.placeId, { today })).preview).toEqual({ omitted: "merged_removed", mergedInto: O.publicId });
    }));

  it("without a date it drafts on the database's date, not the UTC date (review minor 6)", () =>
    withRollback(async (tx) => {
      // a session time zone whose date differs from the UTC date right now
      const hour = new Date().getUTCHours();
      await tx.execute(sql.raw(`set local timezone = '${hour >= 10 ? "Pacific/Kiritimati" : "Etc/GMT+12"}'`));
      const { rows } = await tx.execute<{ d: string }>(sql`select current_date::text as d`);
      expect(rows[0]!.d).not.toBe(new Date().toISOString().slice(0, 10));
      const archive = memoryArchive();
      const f = await seedDeliverySubdivision(tx);
      // the subdivision's rows are valid on the database's date only
      for (const id of f.tileIds) await tx.update(tiles).set({ validTo: sql`current_date + 1` }).where(eq(tiles.id, id));
      const tab = await placeDelivery(tx, archive, f.places.A.placeId);
      expect(tab.preview).toMatchObject({ differs: true, spot: { id: f.places.A.publicId } });
    }));
});
