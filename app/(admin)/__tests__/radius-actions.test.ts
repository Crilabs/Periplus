import { unzipSync } from "fflate";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@/lib/db/client";
import { setDeliveryArchive } from "@/lib/domain/delivery/archive";
import { buildDelivery } from "@/lib/domain/delivery/build";
import { testDb, withRollback } from "@/test/db";
import { seedDeliverySubdivision } from "@/test/fixtures/delivery/subdivision";
import { memoryArchive } from "@/test/s3";

/* The admin's radius ZIP download (spec 18, Admin-UI): needs an admin session, packs every stored file of the package. */

let currentDb: Db = testDb();
const requireAdmin = vi.fn();

vi.mock("@/lib/security/require-admin", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/security/require-admin")>()),
  requireAdmin: () => requireAdmin(),
}));
vi.mock("@/lib/db/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db/client")>()),
  getDb: () => currentDb,
}));

const { downloadRadiusZip } = await import("../deliveries/radius/actions");

beforeEach(() => {
  requireAdmin.mockReset();
  setDeliveryArchive(null);
});

describe("downloadRadiusZip", () => {
  it("throws without an admin session and builds nothing", async () => {
    requireAdmin.mockRejectedValue(new Error("redirect:/login"));
    await expect(downloadRadiusZip("sp_01J9ZZ00000000000000000000", 3)).rejects.toThrow("redirect:/login");
  });

  it("returns a ZIP of every file of the package", { timeout: 60_000 }, () =>
    withRollback(async (tx) => {
      currentDb = tx;
      const archive = memoryArchive();
      setDeliveryArchive(archive);
      requireAdmin.mockResolvedValue({ sub: "u", email: "a@test.invalid" });
      const f = await seedDeliverySubdivision(tx);
      await buildDelivery(tx, archive, f.subdivisionId, { now: new Date("2041-03-01T08:00:00Z"), inCallerTransaction: true });

      const result = await downloadRadiusZip(f.places.M.publicId!, 2);
      if (typeof result === "string") throw new Error(result);
      expect(result.filename).toMatch(/^radius-sp_.*-2d\.zip$/);
      const files = unzipSync(result.zip);
      expect(Object.keys(files)).toEqual(expect.arrayContaining(["manifest.json", "spots.json", "coast.geojson"]));
      expect(JSON.parse(new TextDecoder().decode(files["manifest.json"]))).toMatchObject({ scope: { type: "radius", days: 2 } });

      expect(await downloadRadiusZip("sp_01J9ZZ00000000000000000000", 2)).toBe("marina_not_found");
      expect(await downloadRadiusZip(f.places.M.publicId!, 99)).toBe("invalid_days");
    }),
  );
});
