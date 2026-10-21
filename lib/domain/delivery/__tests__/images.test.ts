import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import type { Archive } from "@/lib/adapters/s3";
import type { Manifest, SpotsFile } from "@/contract";
import { getConfig, type ImagesConfig } from "@/lib/config";
import { deliveries, placeImages } from "@/lib/db/schema";
import { imageAttributionTexts, imageBlockedBy, imageSources } from "@/lib/domain/images/delivery-gate";
import { withRollback } from "@/test/db";
import { breakPackage, SPOT_A, validPackage, PREVIOUS } from "@/test/fixtures/delivery/package";
import { seedImage } from "@/test/fixtures/delivery/images";
import { seedDeliverySubdivision, type DeliveryFixture } from "@/test/fixtures/delivery/subdivision";
import { memoryArchive } from "@/test/s3";
import { buildDelivery } from "../build";
import { loadPlaceImages } from "../load";
import { deliveryFiles } from "../read";
import { sha256Hex } from "../serialize";
import type { DeliveryPackage } from "../types";
import { validatePackage, type ValidationDeps } from "../validate";
import { deliveryDetail } from "../view";

/*
 * Title images in the package (spec 13, contract 2.1) on the synthetic fixture subdivision: delivered behind the
 * per-source delivery switch, as files `images/<public id>-<slot>.jpg` under the package prefix, with their camera.
 */

const NOW = new Date("2040-06-01T08:00:00Z");
const TODAY = "2040-06-01";
const imagesCfg = getConfig().images;
/** The cadastre's switch flipped on (the licence confirmed). */
const cadastreOn: ImagesConfig = { ...imagesCfg, delivery: { ...imagesCfg.delivery, ktimatologio: true } };
const prefixOf = (f: DeliveryFixture, dataVersion: number) => `deliveries/${f.subdivisionKey}/${dataVersion}/`;
const bytesOf = (text: string) => new TextEncoder().encode(text);

async function readJson<T>(archive: Archive, key: string): Promise<T> {
  const bytes = await archive.get(key);
  if (bytes === null) throw new Error(`no object ${key}`);
  return JSON.parse(new TextDecoder().decode(bytes)) as T;
}

const spotA = (spots: SpotsFile, f: DeliveryFixture) => spots.spots.find((s) => s.id === f.places.A.publicId)!;

describe("images in the package", () => {
  it("approved image with ktimatologio is not delivered while the switch is off", () =>
    withRollback(async (tx) => {
      const archive = memoryArchive();
      const f = await seedDeliverySubdivision(tx);
      await seedImage(tx, f, archive, { sources: ["ktimatologio", "sentinel2", "copernicus_dem"] });
      const result = await buildDelivery(tx, archive, f.subdivisionId, { now: NOW, inCallerTransaction: true });
      expect(result).toMatchObject({ status: "valid", dataVersion: 1 });
      const spots = await readJson<SpotsFile>(archive, `${prefixOf(f, 1)}spots.json`);
      expect(spotA(spots, f)).not.toHaveProperty("images");
      expect(archive.keys().filter((k) => k.includes("/images/"))).toEqual([]);
      const manifest = await readJson<Manifest>(archive, `${prefixOf(f, 1)}manifest.json`);
      expect(manifest.files.some((x) => x.name.startsWith("images/"))).toBe(false);
      expect(await loadPlaceImages(tx, [f.places.A.geoObjectId], TODAY, imagesCfg)).toEqual(new Map());
    }));

  it("flipping the switch delivers the image and raises profileVersion once", () =>
    withRollback(async (tx) => {
      const archive = memoryArchive();
      const f = await seedDeliverySubdivision(tx);
      await seedImage(tx, f, archive, { sources: ["ktimatologio", "sentinel2", "copernicus_dem"] });
      const first = await buildDelivery(tx, archive, f.subdivisionId, { now: NOW, inCallerTransaction: true });
      expect(first).toMatchObject({ status: "valid", dataVersion: 1 });
      const before = spotA(await readJson<SpotsFile>(archive, `${prefixOf(f, 1)}spots.json`), f);

      const flipped = await buildDelivery(tx, archive, f.subdivisionId, { now: NOW, inCallerTransaction: true, imagesCfg: cadastreOn });
      expect(flipped).toMatchObject({ status: "valid", dataVersion: 2 });
      expect(flipped.report.checks.filter((c) => !c.ok)).toEqual([]);
      const after = spotA(await readJson<SpotsFile>(archive, `${prefixOf(f, 2)}spots.json`), f);
      expect(after.images).toHaveLength(1);
      expect(after.profileVersion).toBe(before.profileVersion + 1);

      // the second build after the flip changes nothing
      const again = await buildDelivery(tx, archive, f.subdivisionId, { now: NOW, inCallerTransaction: true, imagesCfg: cadastreOn });
      expect(again).toMatchObject({ status: "unchanged", dataVersion: null });
      const [last] = await tx.select().from(deliveries).where(eq(deliveries.id, again.deliveryId));
      expect(last!.status).toBe("unchanged");
    }));

  it("image file is in file_hashes with its sha256", () =>
    withRollback(async (tx) => {
      const archive = memoryArchive();
      const f = await seedDeliverySubdivision(tx);
      const image = await seedImage(tx, f, archive, { content: "the jpeg bytes" });
      const result = await buildDelivery(tx, archive, f.subdivisionId, { now: NOW, inCallerTransaction: true });
      expect(result.report.checks.filter((c) => !c.ok)).toEqual([]);
      expect(result.status).toBe("valid");
      const file = `images/${f.places.A.publicId}-title.jpg`;
      const key = `${prefixOf(f, 1)}${file}`;
      const stored = (await archive.get(key))!;
      expect(new TextDecoder().decode(stored)).toBe("the jpeg bytes");
      expect(archive.contentType(key)).toBe("image/jpeg");
      const [row] = await tx.select().from(deliveries).where(eq(deliveries.id, result.deliveryId));
      expect(row!.fileHashes[file]).toEqual({ sha256: sha256Hex(stored), bytes: stored.byteLength });
      // the package lists it after the contract files: the API links it, the admin page offers its download
      expect(deliveryFiles(row!)).toEqual(["manifest.json", "spots.json", "highlights.json", "regions.json", "coast.geojson", "weather-points.json", file]);
      const detail = await deliveryDetail(tx, archive, row!.id);
      expect(detail!.files.at(-1)).toEqual({ name: file, sha256: sha256Hex(stored), bytes: stored.byteLength });
      const manifest = await readJson<Manifest>(archive, `${prefixOf(f, 1)}manifest.json`);
      expect(manifest.files.at(-1)).toEqual({ name: file, sha256: sha256Hex(stored), bytes: stored.byteLength });
      expect(manifest.schemaVersion).toBe("2.1");
      expect(manifest.licenses.map((l) => l.name)).toEqual(expect.arrayContaining(["CC-BY-3.0", "CC-BY-4.0", "Copernicus-DEM"]));
      // the object: schema order, camera from the columns
      const spot = spotA(await readJson<SpotsFile>(archive, `${prefixOf(f, 1)}spots.json`), f);
      expect(spot.images).toEqual([
        {
          kind: "ai_illustration",
          slot: "title",
          file,
          width: 1536,
          height: 1024,
          alt: { de: "KI-Illustration: Bucht mit Hängen" },
          light: "midday",
          observedAt: "2016-07-01",
          license: "periplus",
          attribution: image.attribution,
          sourceUrl: null,
          camera: { position: [21.0449, 35.1201], heightM: 260, viewBearingDeg: 281.5, tiltDeg: 18.2, fovDeg: 50 },
        },
      ]);
    }));

  it("a new picture for the same slot is a new package even when the image object is the same", () =>
    withRollback(async (tx) => {
      const archive = memoryArchive();
      const f = await seedDeliverySubdivision(tx);
      const image = await seedImage(tx, f, archive, { content: "one" });
      expect(await buildDelivery(tx, archive, f.subdivisionId, { now: NOW, inCallerTransaction: true })).toMatchObject({ status: "valid", dataVersion: 1 });
      await archive.put(image.fileKey, bytesOf("two"), "image/jpeg");
      expect(await buildDelivery(tx, archive, f.subdivisionId, { now: NOW, inCallerTransaction: true })).toMatchObject({ status: "valid", dataVersion: 2 });
      expect(new TextDecoder().decode((await archive.get(`${prefixOf(f, 2)}images/${f.places.A.publicId}-title.jpg`))!)).toBe("two");
    }));

  it("lists several images by rank, then sort order, then slot", () =>
    withRollback(async (tx) => {
      const archive = memoryArchive();
      const f = await seedDeliverySubdivision(tx);
      await seedImage(tx, f, archive, { slot: "view-2", rank: 3, sortOrder: 2 });
      await seedImage(tx, f, archive, { slot: "title", rank: 3, sortOrder: 0 });
      await seedImage(tx, f, archive, { slot: "view-1", rank: 3, sortOrder: 1 });
      await seedImage(tx, f, archive, { slot: "view-3", rank: 1, sortOrder: 9 });
      const images = (await loadPlaceImages(tx, [f.places.A.geoObjectId], TODAY, imagesCfg)).get(f.places.A.geoObjectId)!;
      expect(images.map((i) => i.slot)).toEqual(["view-3", "title", "view-1", "view-2"]);
      const result = await buildDelivery(tx, archive, f.subdivisionId, { now: NOW, inCallerTransaction: true });
      expect(result.status).toBe("valid");
      const spot = spotA(await readJson<SpotsFile>(archive, `${prefixOf(f, 1)}spots.json`), f);
      expect(spot.images!.map((i) => i.file)).toEqual(["view-3", "title", "view-1", "view-2"].map((s) => `images/${f.places.A.publicId}-${s}.jpg`));
      expect(archive.keys().filter((k) => k.includes("/images/"))).toHaveLength(4);
    }));

  it("a blank tile is no source; an ended image is not delivered", () =>
    withRollback(async (tx) => {
      const archive = memoryArchive();
      const f = await seedDeliverySubdivision(tx);
      // the cadastre answered white (no coverage): the render does not rest on it
      const covered = await seedImage(tx, f, archive, { sources: ["ktimatologio", "sentinel2", "copernicus_dem"], blank: ["ktimatologio"], slot: "title" });
      const ended = await seedImage(tx, f, archive, { slot: "view-1" });
      await tx.update(placeImages).set({ validTo: "2040-05-01" }).where(eq(placeImages.id, ended.id));
      const sources = await imageSources(tx, [covered.id, ended.id]);
      expect(sources.get(covered.id)).toEqual(["copernicus_dem", "sentinel2"]);
      const images = (await loadPlaceImages(tx, [f.places.A.geoObjectId], TODAY, imagesCfg)).get(f.places.A.geoObjectId)!;
      expect(images.map((i) => i.slot)).toEqual(["title"]);
    }));
});

describe("imageBlockedBy", () => {
  it("returns the sources whose switch is off, in input order and without repeats", () => {
    const delivery = { ktimatologio: false, sentinel2: true, copernicus_dem: true };
    expect(imageBlockedBy(["sentinel2", "ktimatologio", "copernicus_dem", "ktimatologio"], delivery)).toEqual(["ktimatologio"]);
    expect(imageBlockedBy(["sentinel2", "copernicus_dem"], delivery)).toEqual([]);
    expect(imageBlockedBy([], delivery)).toEqual([]);
    // a source without a switch is off
    expect(imageBlockedBy(["pnoa", "ktimatologio", "pnoa"], delivery)).toEqual(["pnoa", "ktimatologio"]);
  });
});

describe("image validation", () => {
  const imageAttribution = imageAttributionTexts(imagesCfg);
  const validate = (pkg: DeliveryPackage, deps: Partial<ValidationDeps> = {}) =>
    validatePackage(pkg, {
      previous: PREVIOUS,
      findCopies: async () => 0,
      forbiddenSources: [],
      cfg: getConfig().delivery,
      radiusNm: getConfig().consolidation.importance.radiusNm,
      imageAttribution,
      ...deps,
    });
  const image = (attribution: string, alt = "KI-Illustration: Bucht") => ({
    kind: "ai_illustration" as const,
    slot: "title",
    file: `images/${SPOT_A}-title.jpg`,
    width: 1536,
    height: 1024,
    alt: { de: alt },
    light: "midday" as const,
    observedAt: null,
    license: "periplus",
    attribution,
    sourceUrl: null,
    camera: null,
  });
  const withImage = (img: ReturnType<typeof image>) => breakPackage(validPackage(), (p) => void (p.files["spots.json"].spots[0]!.images = [img]));
  const failedNames = (r: Awaited<ReturnType<typeof validate>>) => r.checks.filter((c) => !c.ok).map((c) => c.name);

  it("an attribution naming aerial and terrain source passes", async () => {
    const full = [imagesCfg.sources.sentinel2.attribution, imagesCfg.sources.copernicus_dem.attribution, imagesCfg.output.credit].join(" · ");
    expect(failedNames(await validate(withImage(image(full))))).toEqual([]);
  });

  it("attribution without terrain source fails validation", async () => {
    const report = await validate(withImage(image(`${imagesCfg.sources.sentinel2.attribution} · ${imagesCfg.output.credit}`)));
    expect(failedNames(report)).toEqual(["image_attribution"]);
    expect(report.checks.find((c) => c.name === "image_attribution")!.findings).toEqual([
      expect.objectContaining({ file: "spots.json", objectId: SPOT_A, path: "/spots/0/images/0/attribution" }),
    ]);
    const noAerial = await validate(withImage(image(`${imagesCfg.sources.copernicus_dem.attribution} · ${imagesCfg.output.credit}`)));
    expect(failedNames(noAerial)).toEqual(["image_attribution"]);
  });

  it("alt with 16 copied words fails verbatim_text", async () => {
    const full = [imagesCfg.sources.sentinel2.attribution, imagesCfg.sources.copernicus_dem.attribution].join(" · ");
    const report = await validate(withImage(image(full, "KI-Illustration: eine wörtlich kopierte Passage")), { findCopies: async (text) => (text.includes("kopierte") ? 16 : 0) });
    expect(failedNames(report)).toEqual(["verbatim_text"]);
    expect(report.checks.find((c) => c.name === "verbatim_text")!.findings).toEqual([
      expect.objectContaining({ file: "spots.json", objectId: SPOT_A, path: "/spots/0/images/0/alt/de" }),
    ]);
  });
});
