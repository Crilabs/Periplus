import { describe, expect, it } from "vitest";
import type { Archive } from "@/lib/adapters/s3";
import type { Db } from "@/lib/db/client";
import { profileSummaries, textShingles } from "@/lib/db/schema";
import { shingleHashes } from "@/lib/domain/documents/shingles";
import { newId } from "@/lib/domain/ids";
import { latestDeliveries } from "@/lib/domain/overview";
import { insertProfile, provenanceEntry } from "@/test/consolidation";
import { withRollback } from "@/test/db";
import { seedDeliveryArea, SPOT_A_ATTRIBUTES, SPOT_A_SUMMARY, spotAProvenance, type DeliveryFixture } from "@/test/fixtures/delivery/area";
import { memoryArchive } from "@/test/s3";
import { insertTestVersion } from "@/test/text";
import { buildDelivery } from "../build";
import { deliveryDetail, deliveryDownload, listDeliveries } from "../view";

/*
 * The admin's view of deliveries (plan Task 13) on packages built by `buildDelivery` on the fixture area (rolled back).
 * Build dates lie in the future: the fixture's geo rows are valid from the database's `current_date`.
 */

const day = (d: string) => new Date(`${d}T08:00:00Z`);
const build = (tx: Db, archive: Archive, f: DeliveryFixture, date: string) =>
  buildDelivery(tx, archive, f.areaId, { now: day(date), inCallerTransaction: true });

/** A second profile version of A with a changed east shelter. */
async function changeA(tx: Db, f: DeliveryFixture, profileVersion = 2, summary = SPOT_A_SUMMARY): Promise<void> {
  await insertProfile(
    tx,
    f.places.A.geoObjectId,
    { ...SPOT_A_ATTRIBUTES, anchor_position: { lon: 21.1301, lat: 35.1445 }, "place.position": { lon: f.positions.A[0], lat: f.positions.A[1] }, "shelter.E": 0.8 },
    { ...spotAProvenance(f.factId), "place.position": provenanceEntry("gazetteer", { confidence: 1 }) },
    { version: profileVersion, sourcesCount: 3, documentsCount: 1, confidence: 0.72 },
  );
  await tx.insert(profileSummaries).values({ geoObjectId: f.places.A.geoObjectId, profileVersion, text: summary, status: "ok", attempts: 1, model: "test", promptVersion: 1 });
}

/** A 16-word run of a freshly archived text (its shingles stored): as A's summary it fails `verbatim_text`. */
async function copiedText(tx: Db): Promise<string> {
  const salt = newId().replace(/-/g, "").replace(/\d/g, (d) => "ghijklmnop"[Number(d)]!);
  const words = Array.from({ length: 30 }, (_, i) => `${salt}${"abcdefghijklmnopqrstuvwxyz"[i % 26]}`);
  const v = await insertTestVersion(tx, [words.join(" ")]);
  await tx.insert(textShingles).values(shingleHashes(words.join(" "), 15).map((shingleHash) => ({ shingleHash, chunkId: v.chunkIds[0]! })));
  return `Die Bucht: ${words.slice(2, 18).join(" ")}.`;
}

describe("listDeliveries", () => {
  it("listDeliveries shows each area with its current version and rows newest first", () =>
    withRollback(async (tx) => {
      const archive = memoryArchive();
      const f = await seedDeliveryArea(tx);
      const before = await listDeliveries(tx, { areaId: f.areaId, page: 1 });
      expect(before.areas.find((a) => a.geoObjectId === f.areaId)).toEqual({ geoObjectId: f.areaId, key: f.areaKey, name: "Testrevier", current: null });
      expect(before).toMatchObject({ rows: [], total: 0 });

      const v1 = await build(tx, archive, f, "2040-06-01");
      await changeA(tx, f);
      const v2 = await build(tx, archive, f, "2040-06-02");
      const same = await build(tx, archive, f, "2040-06-03");
      expect([v1.status, v2.status, same.status]).toEqual(["valid", "valid", "unchanged"]);

      const { areas, rows, total } = await listDeliveries(tx, { areaId: f.areaId, page: 1 });
      expect(areas.find((a) => a.geoObjectId === f.areaId)!.current).toEqual({ dataVersion: 2, generatedAt: day("2040-06-02") });
      expect(total).toBe(3);
      expect(rows.map((r) => [r.id, r.status, r.dataVersion])).toEqual([
        [same.deliveryId, "unchanged", null],
        [v2.deliveryId, "valid", 2],
        [v1.deliveryId, "valid", 1],
      ]);
      expect(rows[1]).toMatchObject({ areaName: "Testrevier", failedChecks: [], runId: null, generatedAt: day("2040-06-02") });
      expect(rows[1]!.objectCounts).toMatchObject({ spots: expect.any(Number), changes: 1 });
      // the second page of this area is empty; the list of all areas starts with these rows: every other delivery row
      // is older (the only test that commits deliveries, delivery-run.test, runs before or after this file in the
      // sequential project delivery-fixture, never beside it)
      expect((await listDeliveries(tx, { areaId: f.areaId, page: 2 })).rows).toEqual([]);
      const all = await listDeliveries(tx, { page: 1 });
      expect(all.rows.slice(0, 3).map((r) => r.id)).toEqual([same.deliveryId, v2.deliveryId, v1.deliveryId]);
      const latest = await latestDeliveries(tx, 3);
      expect(latest.map((d) => d.id)).toEqual([same.deliveryId, v2.deliveryId, v1.deliveryId]);
      expect(latest[1]).toEqual({
        id: v2.deliveryId,
        areaName: "Testrevier",
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
      const f = await seedDeliveryArea(tx);
      await build(tx, archive, f, "2040-06-01");
      await changeA(tx, f, 2, await copiedText(tx));
      const rejected = await build(tx, archive, f, "2040-06-02");
      expect(rejected.status).toBe("rejected");

      const detail = (await deliveryDetail(tx, archive, rejected.deliveryId))!;
      expect(detail).toMatchObject({ areaName: "Testrevier", areaPublicId: f.areaPublicId });
      const failed = detail.report.checks.filter((c) => !c.ok);
      expect(failed.map((c) => c.name)).toEqual(["verbatim_text"]);
      expect(failed[0]!.findings[0]).toMatchObject({ file: "spots.json", objectId: f.places.A.publicId });
      expect(detail.objectLinks[f.places.A.publicId!]).toBe(`/places/${f.places.A.placeId}`);
      // the rejected package's changes: its diff to the valid previous package
      expect(detail.changes?.find((c) => c.objectId === f.places.A.publicId)).toMatchObject({ event: "updated", severity: "safety" });
      expect(detail.files.map((x) => x.name)).toEqual(["manifest.json", "spots.json", "highlights.json", "regions.json", "coast.geojson", "weather-points.json", "changes.json"]);
      expect(detail.files[1]).toEqual({ name: "spots.json", ...detail.row.fileHashes["spots.json"]! });

      // a rejected package's file is a download for diagnosis
      const file = (await deliveryDownload(tx, archive, rejected.deliveryId, "spots.json"))!;
      expect(file.filename).toBe(`${f.areaPublicId}-rejected-spots.json`);
      expect(file.bytes).toEqual(await archive.get(`deliveries/${f.areaPublicId}/rejected/${rejected.deliveryId}/spots.json`));
      expect(await deliveryDetail(tx, archive, newId())).toBeNull();
    }));

  it("a first package has no changes, an unchanged build no files", () =>
    withRollback(async (tx) => {
      const archive = memoryArchive();
      const f = await seedDeliveryArea(tx);
      const v1 = await build(tx, archive, f, "2040-06-01");
      const same = await build(tx, archive, f, "2040-06-02");
      expect((await deliveryDetail(tx, archive, v1.deliveryId))!.changes).toBeNull();
      expect((await deliveryDownload(tx, archive, v1.deliveryId, "coast.geojson"))!).toMatchObject({
        filename: `${f.areaPublicId}-1-coast.geojson`,
        contentType: "application/geo+json",
      });
      expect(await deliveryDownload(tx, archive, v1.deliveryId, "changes.json")).toBeNull();
      const unchanged = (await deliveryDetail(tx, archive, same.deliveryId))!;
      expect(unchanged).toMatchObject({ changes: null, files: [] });
      expect(unchanged.report.ok).toBe(true);
      expect(await deliveryDownload(tx, archive, same.deliveryId, "spots.json")).toBeNull();
    }));

  it("a package file lost in S3 does not hide the report", () =>
    withRollback(async (tx) => {
      const archive = memoryArchive();
      const f = await seedDeliveryArea(tx);
      await build(tx, archive, f, "2040-06-01");
      await changeA(tx, f);
      const v2 = await build(tx, archive, f, "2040-06-02");
      const empty = memoryArchive();
      const detail = (await deliveryDetail(tx, empty, v2.deliveryId))!;
      expect(detail).toMatchObject({ changes: null, archiveError: expect.stringMatching(/changes.json .* is missing/) });
      expect(detail.report.ok).toBe(true);
      expect(detail.files).toHaveLength(7);
      expect((await deliveryDetail(tx, archive, v2.deliveryId))!.archiveError).toBeNull();
    }));
});
