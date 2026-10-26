import { describe, expect, it } from "vitest";
import type { Archive } from "@/lib/adapters/s3";
import type { Db } from "@/lib/db/client";
import { newId } from "@/lib/domain/ids";
import { latestDeliveries } from "@/lib/domain/overview";
import { withRollback } from "@/test/db";
import { changeBerthCore, seedDeliverySubdivision, type DeliveryFixture } from "@/test/fixtures/delivery/subdivision";
import { memoryArchive } from "@/test/s3";
import { buildDelivery } from "../build";
import { deliveryDetail, deliveryDownload, listDeliveries } from "../view";

/*
 * The admin's view of deliveries (plan Task 13) on packages built by `buildDelivery` on the fixture subdivision (rolled back).
 * Build dates lie in the future: the fixture's geo rows are valid from the database's `current_date`.
 */

const day = (d: string) => new Date(`${d}T08:00:00Z`);
const build = (tx: Db, archive: Archive, f: DeliveryFixture, date: string) =>
  buildDelivery(tx, archive, f.subdivisionId, { now: day(date), inCallerTransaction: true });

/** A's berth state rewritten with a changed east shelter. */
const changeA = (tx: Db, f: DeliveryFixture) => changeBerthCore(tx, f.places.A.placeId, { "shelter.E": 0.8 }, new Date("2026-10-23T08:00:00Z"));

describe("listDeliveries", () => {
  it("listDeliveries shows each subdivision with its current version and rows newest first", () =>
    withRollback(async (tx) => {
      const archive = memoryArchive();
      const f = await seedDeliverySubdivision(tx);
      const before = await listDeliveries(tx, { subdivisionId: f.subdivisionId, page: 1 });
      expect(before.subdivisions.find((s) => s.id === f.subdivisionId)).toEqual({ id: f.subdivisionId, key: f.subdivisionKey, name: "Testlandesteil", current: null });
      expect(before).toMatchObject({ rows: [], total: 0 });

      const v1 = await build(tx, archive, f, "2040-06-01");
      await changeA(tx, f);
      const v2 = await build(tx, archive, f, "2040-06-02");
      const same = await build(tx, archive, f, "2040-06-03");
      expect([v1.status, v2.status, same.status]).toEqual(["valid", "valid", "unchanged"]);

      const { subdivisions, rows, total } = await listDeliveries(tx, { subdivisionId: f.subdivisionId, page: 1 });
      expect(subdivisions.find((s) => s.id === f.subdivisionId)!.current).toEqual({ dataVersion: 2, generatedAt: day("2040-06-02") });
      expect(total).toBe(3);
      expect(rows.map((r) => [r.id, r.status, r.dataVersion])).toEqual([
        [same.deliveryId, "unchanged", null],
        [v2.deliveryId, "valid", 2],
        [v1.deliveryId, "valid", 1],
      ]);
      expect(rows[1]).toMatchObject({ scopeName: "Testlandesteil", failedChecks: [], runId: null, generatedAt: day("2040-06-02") });
      expect(rows[1]!.objectCounts).toEqual({ spots: 3, regions: 2, weatherPoints: 2, coastFeatures: expect.any(Number) });
      // the second page of this subdivision is empty; the list of all subdivisions starts with these rows: every other delivery row
      // is older (the only test that commits deliveries, delivery-run.test, runs before or after this file in the
      // sequential project delivery-fixture, never beside it)
      expect((await listDeliveries(tx, { subdivisionId: f.subdivisionId, page: 2 })).rows).toEqual([]);
      const all = await listDeliveries(tx, { page: 1 });
      expect(all.rows.slice(0, 3).map((r) => r.id)).toEqual([same.deliveryId, v2.deliveryId, v1.deliveryId]);
      const latest = await latestDeliveries(tx, 3);
      expect(latest.map((d) => d.id)).toEqual([same.deliveryId, v2.deliveryId, v1.deliveryId]);
      expect(latest[1]).toEqual({
        id: v2.deliveryId,
        scopeName: "Testlandesteil",
        status: "valid",
        dataVersion: 2,
        generatedAt: day("2040-06-02"),
      });
    }));
});

describe("deliveryDetail", () => {
  it("deliveryDetail links findings to the place page", () =>
    withRollback(async (tx) => {
      const archive = memoryArchive();
      const f = await seedDeliverySubdivision(tx);
      await build(tx, archive, f, "2040-06-01");
      // a name with a domain rejects the package (a copied fact would only be dropped, F3)
      const rejected = await buildDelivery(tx, archive, f.subdivisionId, {
        now: day("2040-06-02"),
        inCallerTransaction: true,
        scopeTransform: (scope) => ({ ...scope, spots: scope.spots.map((s) => (s.publicId === f.places.A.publicId ? { ...s, name: "Vathi Bay sailing-guide.example.com" } : s)) }),
      });
      expect(rejected.status).toBe("rejected");

      const detail = (await deliveryDetail(tx, rejected.deliveryId))!;
      expect(detail).toMatchObject({ scopeName: "Testlandesteil", scopePublicId: f.subdivisionPublicId });
      const failed = detail.report.checks.filter((c) => !c.ok);
      expect(failed.map((c) => c.name)).toEqual(["foreign_content"]);
      expect(failed[0]!.findings[0]).toMatchObject({ file: "spots.json", objectId: f.places.A.publicId });
      expect(detail.objectLinks[f.places.A.publicId!]).toBe(`/places/${f.places.A.placeId}`);
      expect(detail.files.map((x) => x.name)).toEqual(["manifest.json", "spots.json", "regions.json", "coast.geojson", "weather-points.json"]);
      expect(detail.files[1]).toEqual({ name: "spots.json", ...detail.row.fileHashes["spots.json"]! });

      // a rejected package's file is a download for diagnosis
      const file = (await deliveryDownload(tx, archive, rejected.deliveryId, "spots.json"))!;
      expect(file.filename).toBe(`${f.subdivisionPublicId}-rejected-spots.json`);
      expect(file.bytes).toEqual(await archive.get(`deliveries/${f.subdivisionKey}/rejected/${rejected.deliveryId}/spots.json`));
      expect(await deliveryDetail(tx, newId())).toBeNull();
    }));

  it("an unchanged build has no files, a valid one its contract files", () =>
    withRollback(async (tx) => {
      const archive = memoryArchive();
      const f = await seedDeliverySubdivision(tx);
      const v1 = await build(tx, archive, f, "2040-06-01");
      const same = await build(tx, archive, f, "2040-06-02");
      expect((await deliveryDetail(tx, v1.deliveryId))!.files.map((x) => x.name)).toEqual(["manifest.json", "spots.json", "regions.json", "coast.geojson", "weather-points.json"]);
      expect((await deliveryDownload(tx, archive, v1.deliveryId, "coast.geojson"))!).toMatchObject({
        filename: `${f.subdivisionPublicId}-1-coast.geojson`,
        contentType: "application/geo+json",
      });
      expect(await deliveryDownload(tx, archive, v1.deliveryId, "changes.json")).toBeNull();
      const unchanged = (await deliveryDetail(tx, same.deliveryId))!;
      expect(unchanged).toMatchObject({ files: [] });
      expect(unchanged.report.ok).toBe(true);
      expect(await deliveryDownload(tx, archive, same.deliveryId, "spots.json")).toBeNull();
    }));

  it("the detail comes from the delivery row, so a package file lost in S3 does not hide the report", () =>
    withRollback(async (tx) => {
      const archive = memoryArchive();
      const f = await seedDeliverySubdivision(tx);
      await build(tx, archive, f, "2040-06-01");
      await changeA(tx, f);
      const v2 = await build(tx, archive, f, "2040-06-02");
      const detail = (await deliveryDetail(tx, v2.deliveryId))!;
      expect(detail.report.ok).toBe(true);
      expect(detail.files).toHaveLength(5);
      // the download reads the archive: a lost file is an error there, never served as another one
      await expect(deliveryDownload(tx, memoryArchive(), v2.deliveryId, "spots.json")).rejects.toThrow(/is missing/);
    }));
});
