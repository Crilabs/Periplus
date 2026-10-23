import { describe, expect, it } from "vitest";
import { buildDelivery } from "../../build";
import { withRollback } from "@/test/db";
import { seedDeliverySubdivision } from "@/test/fixtures/delivery/subdivision";
import { memoryArchive } from "@/test/s3";
import { getRadiusPackage, recordRadiusRequest } from "../build";
import { listRadiusPackages, previewRadius, radiusMapFeatures } from "../view";

/*
 * The admin view of radius packages (spec 18, Admin-UI): the preview with the sum of the file sizes, the cached
 * packages with their request counts, the map features of a manifest. The delivery fixture's package is built for real.
 */

const NOW = new Date("2041-03-01T08:00:00Z");

describe("radius view", () => {
  it("previewRadius sums the bytes of every file and returns the stored manifest", { timeout: 60_000 }, () =>
    withRollback(async (tx) => {
      const archive = memoryArchive();
      const f = await seedDeliverySubdivision(tx);
      expect((await buildDelivery(tx, archive, f.subdivisionId, { now: NOW, inCallerTransaction: true })).status).toBe("valid");
      const marina = f.places.M.publicId!;

      const preview = await previewRadius(tx, archive, marina, 2);
      if (typeof preview === "string") throw new Error(preview);
      expect(preview.totalBytes).toBe(Object.values(preview.row.fileHashes).reduce((sum, h) => sum + h.bytes, 0));
      expect(preview.totalBytes).toBeGreaterThan(0);
      expect(preview.manifest.scope).toMatchObject({ type: "radius", days: 2, radiusNm: 50 });

      const features = await radiusMapFeatures(tx, preview.manifest);
      expect(features.features.some((x) => x.properties?.role === "circle")).toBe(true);
      expect(features.features.some((x) => x.properties?.role === "delivered")).toBe(true);
      expect(features.features.some((x) => x.properties?.role === "marina")).toBe(true);

      expect(await previewRadius(tx, archive, marina, 0)).toBe("invalid_days");
      expect(await previewRadius(tx, archive, "sp_01J9ZZ00000000000000000000", 2)).toBe("marina_not_found");
    }),
  );

  it("listRadiusPackages counts the requests, newest package first", { timeout: 60_000 }, () =>
    withRollback(async (tx) => {
      const archive = memoryArchive();
      const f = await seedDeliverySubdivision(tx);
      await buildDelivery(tx, archive, f.subdivisionId, { now: NOW, inCallerTransaction: true });
      const marina = f.places.M.publicId!;
      const older = await getRadiusPackage(tx, archive, { marina, days: 1, now: new Date("2041-03-01T08:00:00Z") });
      const newer = await getRadiusPackage(tx, archive, { marina, days: 2, now: new Date("2041-03-02T08:00:00Z") });
      if (typeof older === "string" || typeof newer === "string") throw new Error("no package");
      await recordRadiusRequest(tx, newer.id, undefined, "file");
      await recordRadiusRequest(tx, newer.id, undefined, "changes");

      const list = (await listRadiusPackages(tx, 1)).filter((r) => [older.key, newer.key].includes(r.key));
      expect(list.map((r) => [r.key, r.marina, r.days, r.requests])).toEqual([
        [newer.key, marina, 2, 3],
        [older.key, marina, 1, 1],
      ]);
      expect(list[0]!.coverage).toEqual(newer.coverage);
      expect(list[0]!.generatedAt).toBe(newer.generatedAt.toISOString());
    }),
  );
});
