import { execFileSync } from "node:child_process";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import sharp from "sharp";
import { createArchive } from "../lib/adapters/s3";
import { createDb, type Db } from "../lib/db/client";
import { geomFromGeoJson } from "../lib/db/geometry";
import {
  areaEvidence,
  areaMembers,
  deliveries,
  geoNames,
  geoObjects,
  imageryTiles,
  placeImages,
  placeRenders,
  placeWebsites,
  places,
  runs,
  subdivisions,
  tileGeoObjects,
  tiles,
} from "../lib/db/schema";
import { buildDelivery } from "../lib/domain/delivery/build";
import { failedChecksSummary } from "../lib/domain/delivery/validate";
import { deliveryFiles, readStoredFile } from "../lib/domain/delivery/read";
import { createReviewTask } from "../lib/domain/review";
import { createUser } from "../lib/domain/users";
import { newPublicId } from "../lib/domain/ids";
import { E2E_DELIVERY_KEY, endE2eDeliverySubdivision, seedE2eDeliverySubdivision } from "../test/fixtures/delivery/subdivision";

/** Above the pipeline's priorities, so the e2e candidate is listed first on /review. */
const REVIEW_PRIORITY = 1_000_000_000;

/**
 * A place candidate with an open review task, named uniquely per run (places are never deleted, so every run
 * adds one). Open sea outside the pilot box 23.0-23.75 E x 37.0-38.0 N. Returns the name.
 */
async function createReviewCandidate(db: Db): Promise<string> {
  const name = `E2E Bay ${new Date().toISOString()}`;
  const geom = sql`${geomFromGeoJson({ type: "Point", coordinates: [27.91, 34.91] })}`;
  await db.transaction(async (tx) => {
    const [object] = await tx
      .insert(geoObjects)
      .values({ type: "bay", origin: "manual", geom })
      .returning({ id: geoObjects.id });
    await tx.insert(geoNames).values({
      geoObjectId: object!.id,
      name,
      nameNormalized: name.toLowerCase(),
      language: "en",
      script: "latin",
      origin: "manual",
    });
    const [place] = await tx
      .insert(places)
      .values({ geoObjectId: object!.id, kind: "anchorage", position: geom })
      .returning({ id: places.id });
    await createReviewTask(tx, {
      kind: "place_candidate",
      subjectType: "place",
      subjectId: place!.id,
      context: { geoObjectId: object!.id, kind: "anchorage", name },
      priority: REVIEW_PRIORITY,
    });
  });
  return name;
}

/** Key of the Greek subdivision of the subdivisions spec: named „Attika (E2E)“, committed once, outside every test box. */
export const E2E_SUBDIVISION_KEY = "GR-E2E";

/**
 * A place image task for the place-image review spec (spec 13), as the pipeline leaves it: a bay with a place, a
 * render row with its photo and mask in the archive, a candidate JPEG and the open `place_image` task. Unique per
 * run (places and renders are never deleted). Returns the task id and the place name.
 */
async function createPlaceImageScene(db: Db): Promise<{ taskId: string; name: string }> {
  const archive = createArchive({
    endpoint: process.env.S3_ENDPOINT!,
    region: process.env.S3_REGION!,
    bucket: process.env.S3_BUCKET!,
    accessKeyId: process.env.S3_ACCESS_KEY_ID!,
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY!,
  });
  await archive.ensureBucket();
  const blank = (channels: 3 | 4, color: { r: number; g: number; b: number }) =>
    sharp({ create: { width: 96, height: 64, channels, background: color } });
  const name = `E2E Image Bay ${new Date().toISOString()}`;
  const geom = sql`${geomFromGeoJson({ type: "Point", coordinates: [27.95, 34.95] })}`;
  return db.transaction(async (tx) => {
    const [object] = await tx.insert(geoObjects).values({ type: "bay", origin: "manual", geom }).returning({ id: geoObjects.id });
    await tx
      .insert(geoNames)
      .values({ geoObjectId: object!.id, name, nameNormalized: name.toLowerCase(), language: "en", script: "latin", origin: "manual" });
    await tx.insert(places).values({ geoObjectId: object!.id, kind: "anchorage", position: geom });
    const [run] = await tx.insert(runs).values({ kind: "stage", scopeType: "system", scopeId: "e2e", triggeredBy: "e2e", status: "finished" }).returning({ id: runs.id });
    const renderId = crypto.randomUUID();
    const photoKey = `imagery/renders/${object!.id}/${renderId}/photo.png`;
    const maskKey = `imagery/renders/${object!.id}/${renderId}/mask.png`;
    const candidateKey = `imagery/candidates/${object!.id}/${renderId}-1.jpg`;
    await archive.put(photoKey, await blank(3, { r: 40, g: 90, b: 140 }).png().toBuffer(), "image/png");
    await archive.put(maskKey, await blank(3, { r: 255, g: 255, b: 255 }).png().toBuffer(), "image/png");
    await archive.put(candidateKey, await blank(3, { r: 60, g: 120, b: 170 }).jpeg().toBuffer(), "image/jpeg");
    const camera = { position: [27.95, 34.94] as [number, number], heightM: 260, viewBearingDeg: 0, tiltDeg: 30, fovDeg: 50 };
    const key = `e2e-image-${renderId}`;
    await tx.insert(placeRenders).values({
      id: renderId,
      geoObjectId: object!.id,
      camera: { ...camera, target: [27.95, 34.95], azimuthDeg: 0, zoom: "z1" },
      zoom: "z1",
      imageryTileIds: [],
      demTileIds: [],
      photoKey,
      maskKey,
      rendererVersion: "e2e",
      generationKey: key,
      runId: run!.id,
    });
    const task = await createReviewTask(tx, {
      kind: "place_image",
      subjectType: "place_image",
      subjectId: `${object!.id}:title`,
      context: {
        key,
        slot: "title",
        azimuthOverride: null,
        camera,
        renderId,
        candidateKey,
        light: "midday",
        zoom: "z1",
        model: "e2e-model",
        promptVersion: 1,
        waterIoU: 0.9,
        passed: true,
        attempts: 1,
        watermarkVisible: false,
        alt: "KI-Illustration: E2E-Bucht",
        allowedZooms: ["z1", "z2", "z3"],
      },
      priority: REVIEW_PRIORITY,
    });
    return { taskId: task.id, name };
  });
}

/**

/**
 * A place whose title image is approved (tab „Bilder“): a render of the cadastre imagery (source `ktimatologio`, not
 * delivered while `images.delivery.ktimatologio` is false) and the current image, files in the test archive. Returns
 * the place id.
 */
async function createApprovedImageScene(db: Db): Promise<string> {
  const archive = createArchive({
    endpoint: process.env.S3_ENDPOINT!,
    region: process.env.S3_REGION!,
    bucket: process.env.S3_BUCKET!,
    accessKeyId: process.env.S3_ACCESS_KEY_ID!,
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY!,
  });
  await archive.ensureBucket();
  const blank = (color: { r: number; g: number; b: number }) => sharp({ create: { width: 96, height: 64, channels: 3, background: color } });
  const name = `E2E Titelbild Bay ${new Date().toISOString()}`;
  const geom = sql`${geomFromGeoJson({ type: "Point", coordinates: [27.97, 34.97] })}`;
  return db.transaction(async (tx) => {
    const [object] = await tx.insert(geoObjects).values({ type: "bay", origin: "manual", geom }).returning({ id: geoObjects.id });
    await tx
      .insert(geoNames)
      .values({ geoObjectId: object!.id, name, nameNormalized: name.toLowerCase(), language: "en", script: "latin", origin: "manual" });
    const [place] = await tx.insert(places).values({ geoObjectId: object!.id, kind: "anchorage", position: geom }).returning({ id: places.id });
    const [run] = await tx.insert(runs).values({ kind: "stage", scopeType: "system", scopeId: "e2e", triggeredBy: "e2e", status: "finished" }).returning({ id: runs.id });
    const tileId = crypto.randomUUID();
    await tx.insert(imageryTiles).values({
      id: tileId,
      source: "ktimatologio",
      tileKey: `e2e-${tileId}`,
      bbox: geomFromGeoJson({ type: "Polygon", coordinates: [[[27.96, 34.96], [27.98, 34.96], [27.98, 34.98], [27.96, 34.98], [27.96, 34.96]]] }),
      resolutionM: 0.5,
      acquiredAt: "2009-06-01",
      license: "CC-BY-3.0",
      attribution: "Luftbild © Hellenic Cadastre (CC BY 3.0)",
      fileKey: `imagery/tiles/e2e-${tileId}.jpg`,
      bytes: 1,
    });
    const renderId = crypto.randomUUID();
    const photoKey = `imagery/renders/${object!.id}/${renderId}/photo.png`;
    const maskKey = `imagery/renders/${object!.id}/${renderId}/mask.png`;
    const imageId = crypto.randomUUID();
    const fileKey = `images/places/${object!.id}/${imageId}.jpg`;
    await archive.put(photoKey, await blank({ r: 40, g: 90, b: 140 }).png().toBuffer(), "image/png");
    await archive.put(maskKey, await blank({ r: 255, g: 255, b: 255 }).png().toBuffer(), "image/png");
    await archive.put(fileKey, await blank({ r: 60, g: 120, b: 170 }).jpeg().toBuffer(), "image/jpeg");
    await tx.insert(placeRenders).values({
      id: renderId,
      geoObjectId: object!.id,
      camera: { position: [27.97, 34.96], heightM: 260, viewBearingDeg: 0, tiltDeg: 30, fovDeg: 50, target: [27.97, 34.97], azimuthDeg: 0, zoom: "z1" },
      zoom: "z1",
      imageryTileIds: [tileId],
      demTileIds: [],
      photoKey,
      maskKey,
      rendererVersion: "e2e",
      generationKey: `e2e-tab-${renderId}`,
      runId: run!.id,
    });
    await tx.insert(placeImages).values({
      id: imageId,
      geoObjectId: object!.id,
      kind: "ai_illustration",
      slot: "title",
      cameraPosition: sql`${geomFromGeoJson({ type: "Point", coordinates: [27.97, 34.96] })}`,
      cameraHeightM: 260,
      viewBearingDeg: 0,
      cameraTiltDeg: 30,
      cameraFovDeg: 50,
      renderId,
      light: "midday",
      waterIou: 0.9,
      fileKey,
      width: 96,
      height: 64,
      alt: "KI-Illustration: E2E-Bucht",
      generationKey: `e2e-tab-image-${imageId}`,
      attribution: "Luftbild © Hellenic Cadastre (CC BY 3.0) · Illustration: Periplus",
      license: "periplus",
      observedAt: "2009-06-01",
    });
    return place!.id;
  });
}

/**
 * The subdivisions spec needs a valid, never-built subdivision of Greece: `GR-E2E` „Attika (E2E)“ over 26.0–26.25 E ×
 * 40.0–40.25 N (outside the pilot box), with its admin region and German name. Committed once; it stays between runs
 * (subdivisions are never deleted).
 */
async function ensureE2eSubdivision(db: Db): Promise<void> {
  const [found] = await db.select({ id: subdivisions.id }).from(subdivisions).where(and(eq(subdivisions.key, E2E_SUBDIVISION_KEY), isNull(subdivisions.validTo)));
  if (found) return;
  await db.transaction(async (tx) => {
    const polygon = sql`ST_Multi(ST_MakeEnvelope(26.0, 40.0, 26.25, 40.25, 4326))`;
    const [region] = await tx
      .insert(geoObjects)
      .values({ type: "admin_region", origin: "manual", adminLevel: 4, tags: { country: "GR" }, geom: polygon })
      .returning({ id: geoObjects.id });
    await tx.insert(geoNames).values({ geoObjectId: region!.id, name: "Attika (E2E)", nameNormalized: "attika (e2e)", language: "de", script: "latin", origin: "manual" });
    await tx.insert(subdivisions).values({ publicId: newPublicId("sd"), key: E2E_SUBDIVISION_KEY, country: "GR", geoObjectId: region!.id, geom: polygon, landGeom: polygon });
  });
}

/** Key of the imported Revier of the areas spec, inside `GR-E2E`. */
export const E2E_AREA_KEY = "e2e-revier";
export const E2E_AREA_QUOTE = "Das Revier Attika (E2E) ist ein ruhiges Segelrevier.";

/**
 * The areas spec needs an imported Revier in the e2e subdivision: `e2e-revier` „E2E-Revier“ over 26.05–26.2 E × 40.05–40.2 N
 * (inside `GR-E2E`, outside the pilot box), with German and English names, one resolved member (a harbour), one open
 * member, a relation, evidence and a link to the subdivision's coast tile. Committed once (geo objects are never deleted).
 */
async function ensureE2eArea(db: Db): Promise<void> {
  const [found] = await db.select({ id: geoObjects.id }).from(geoObjects).where(and(eq(geoObjects.configKey, E2E_AREA_KEY), isNull(geoObjects.validTo)));
  if (found) return;
  const [sub] = await db.select({ id: subdivisions.id }).from(subdivisions).where(and(eq(subdivisions.key, E2E_SUBDIVISION_KEY), isNull(subdivisions.validTo)));
  await db.transaction(async (tx) => {
    const named = async (id: string, name: string, language: string, isPreferred: boolean) =>
      tx.insert(geoNames).values({ geoObjectId: id, name, nameNormalized: name.toLowerCase(), language, script: "latin", origin: "manual", isPreferred });
    const polygon = sql`ST_Multi(ST_MakeEnvelope(26.05, 40.05, 26.2, 40.2, 4326))`;
    const [harbour] = await tx
      .insert(geoObjects)
      .values({ type: "harbour", origin: "manual", geom: sql`ST_SetSRID(ST_MakePoint(26.1, 40.1), 4326)` })
      .returning({ id: geoObjects.id });
    await named(harbour!.id, "E2E-Hafen", "de", true);
    const [neighbour] = await tx
      .insert(geoObjects)
      .values({ type: "area", origin: "import", configKey: "e2e-nachbar", publicId: newPublicId("ar"), geom: sql`ST_Multi(ST_MakeEnvelope(26.15, 40.15, 26.24, 40.24, 4326))`, tags: { importCountry: "GR" } })
      .returning({ id: geoObjects.id });
    await named(neighbour!.id, "E2E-Nachbarrevier", "de", true);
    const [area] = await tx
      .insert(geoObjects)
      .values({
        type: "area",
        origin: "import",
        configKey: E2E_AREA_KEY,
        publicId: newPublicId("ar"),
        geom: polygon,
        tags: {
          boundary: "Von der Nordküste bis zur Südspitze.",
          notes: "Nur für den E2E-Test.",
          polygonOrigin: "hull",
          importCountry: "GR",
          unresolvedMembers: [{ name: "E2E-Geisterhafen", type: "harbour", role: "member" }],
          related: [{ key: "e2e-nachbar", relation: "overlaps" }],
        },
      })
      .returning({ id: geoObjects.id });
    await named(area!.id, "E2E-Revier", "de", true);
    await named(area!.id, "E2E Sailing Area", "en", true);
    await tx.insert(areaMembers).values({ areaId: area!.id, geoObjectId: harbour!.id, role: "member", name: "E2E Harbour" });
    await tx.insert(areaEvidence).values({ areaId: area!.id, url: "https://example.invalid/e2e-revier", publisher: "E2E-Verlag", language: "de", quote: E2E_AREA_QUOTE, fileGeneratedAt: "2026-10-20" });
    const tileId = "q025:824:520"; // 26.0-26.25 E x 40.0-40.25 N, the box of GR-E2E
    await tx.insert(tiles).values({ id: tileId, bbox: sql`ST_MakeEnvelope(26.0, 40.0, 26.25, 40.25, 4326)`, subdivisionId: sub!.id, hasCoast: true }).onConflictDoNothing();
    await tx.insert(tileGeoObjects).values([{ tileId, geoObjectId: area!.id }, { tileId, geoObjectId: neighbour!.id }]).onConflictDoNothing();
  });
}

/**
 * The synthetic delivery subdivision of the deliveries spec (ruling M6-P29): the delivery fixture's layout committed
 * once under key `XT-E2E-DELIVERY` (`E2E_SHIFT`, away from every other test box) and its package built here, only when
 * the subdivision has no valid delivery yet; later runs find it with version 1 („Gültig“). Places are never deleted. A
 * valid package whose files are gone from the test bucket (e.g. a wiped S3 volume) cannot be rebuilt (the same content
 * is „unverändert“ and stores nothing), so its box is ended and seeded afresh; so is the box of a database that still
 * holds the area layout of contract 1.0. Returns the subdivision's id.
 */
async function ensureDeliverySubdivision(db: Db): Promise<string> {
  const archive = createArchive({
    endpoint: process.env.S3_ENDPOINT!,
    region: process.env.S3_REGION!,
    bucket: process.env.S3_BUCKET!,
    accessKeyId: process.env.S3_ACCESS_KEY_ID!,
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY!,
  });
  await archive.ensureBucket();
  const [found] = await db
    .select({ id: subdivisions.id })
    .from(subdivisions)
    .where(and(eq(subdivisions.key, E2E_DELIVERY_KEY), isNull(subdivisions.validTo)));
  let subdivisionId: string | undefined = found?.id;
  if (subdivisionId) {
    const [row] = await db
      .select()
      .from(deliveries)
      .where(and(eq(deliveries.subdivisionId, subdivisionId), eq(deliveries.status, "valid")))
      .orderBy(desc(deliveries.dataVersion))
      .limit(1);
    if (row) {
      const stored = await Promise.all(
        deliveryFiles(row).map((f) => readStoredFile(archive, row, f).then(() => true, () => false)),
      );
      if (stored.every(Boolean)) return subdivisionId;
    }
  }
  if (!subdivisionId || (await db.select({ id: deliveries.id }).from(deliveries).where(eq(deliveries.subdivisionId, subdivisionId)).limit(1)).length > 0) {
    // no subdivision yet (a fresh database or one with the 1.0 area layout in the box), or a package whose files are gone
    await endE2eDeliverySubdivision(db);
    subdivisionId = (await db.transaction((tx) => seedE2eDeliverySubdivision(tx))).subdivisionId;
  }
  const built = await buildDelivery(db, archive, subdivisionId);
  if (built.status !== "valid") {
    throw new Error(
      `e2e delivery subdivision: package ${built.status} (delivery ${built.deliveryId}), failed checks: ${failedChecksSummary(built.report)}. ` +
        `Fix the fixture (test/fixtures/delivery/subdivision.ts) or end the subdivision ${E2E_DELIVERY_KEY} in the test database.`,
    );
  }
  return subdivisionId;
}

/**
 * A confirmed marina with an OSM website row, unique per run. Returns the place id.
 */
async function createAutoConfirmedScene(db: Db): Promise<string> {
  const name = `E2E Auto Marina ${new Date().toISOString()}`;
  const geom = sql`${geomFromGeoJson({ type: "Point", coordinates: [27.93, 34.93] })}`;
  return db.transaction(async (tx) => {
    const [object] = await tx.insert(geoObjects).values({ type: "bay", origin: "manual", geom }).returning({ id: geoObjects.id });
    await tx
      .insert(geoNames)
      .values({ geoObjectId: object!.id, name, nameNormalized: name.toLowerCase(), language: "en", script: "latin", origin: "manual" });
    const [place] = await tx
      .insert(places)
      .values({ geoObjectId: object!.id, kind: "marina", status: "confirmed", publicId: newPublicId("sp"), position: geom })
      .returning({ id: places.id });
    await tx.insert(placeWebsites).values({
      placeId: place!.id,
      geoObjectId: object!.id,
      url: "https://marina.e2e.test.invalid/",
      urlNormalized: "marina.e2e.test.invalid/",
      origin: "osm",
      bound: false,
    });
    return place!.id;
  });
}

/**
 * Creates the e2e admin in the TEST database unless it already exists (idempotent) and a fresh place candidate
 * for the review test; its name is passed to the tests as E2E_REVIEW_PLACE. The synthetic delivery subdivision with its valid package (E2E_DELIVERY_SUBDIVISION).
 */
export default async function globalSetup(): Promise<void> {
  const url = process.env.TEST_DATABASE_URL ?? "postgres://periplus:periplus@localhost:5434/periplus_test";
  const dbName = decodeURIComponent(new URL(url).pathname.replace(/^\//, ""));
  if (!dbName.endsWith("_test")) throw new Error(`Refusing to run e2e: database "${dbName}" must end with "_test"`);

  // The e2e run may be the first thing to touch the test database, so make sure it is migrated.
  // stdout ignored, stderr kept: a failed migration fails with its reason, not only "Command failed".
  try {
    execFileSync("npx", ["tsx", "scripts/migrate.ts"], { env: { ...process.env, DATABASE_URL: url }, stdio: ["ignore", "ignore", "pipe"] });
  } catch (error) {
    const stderr = String((error as { stderr?: Buffer }).stderr ?? "").trim();
    throw new Error(`e2e migration failed${stderr ? `: ${stderr}` : ""}`, { cause: error });
  }
  const { db, close } = createDb(url);
  try {
    try {
      await createUser(db, process.env.E2E_EMAIL!, process.env.E2E_PASSWORD!);
    } catch (error) {
      if (!/duplicate key|unique/i.test(String(error) + String((error as { cause?: unknown }).cause))) throw error;
    }
    process.env.E2E_REVIEW_PLACE = await createReviewCandidate(db);
    process.env.E2E_IMAGE_TASK = (await createPlaceImageScene(db)).taskId;
    process.env.E2E_IMAGE_PLACE = await createApprovedImageScene(db);
    process.env.E2E_AUTO_PLACE = await createAutoConfirmedScene(db);
    process.env.E2E_DELIVERY_SUBDIVISION = await ensureDeliverySubdivision(db);
    await ensureE2eSubdivision(db);
    await ensureE2eArea(db);
  } finally {
    await close();
  }
}
