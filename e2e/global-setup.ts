import { execFileSync } from "node:child_process";
import { and, desc, eq, isNull, like, sql } from "drizzle-orm";
import sharp from "sharp";
import { createArchive } from "../lib/adapters/s3";
import { createDb, type Db } from "../lib/db/client";
import { geomFromGeoJson } from "../lib/db/geometry";
import { loadConfig } from "../lib/config";
import {
  chunks,
  deliveries,
  documents,
  documentVersions,
  extractionRuns,
  extractionUnits,
  facts,
  geoNames,
  geoObjects,
  mentions,
  imageryTiles,
  placeImages,
  placeRenders,
  places,
  profiles,
  runs,
  sources,
  subdivisions,
} from "../lib/db/schema";
import { consolidateGeo } from "../lib/domain/consolidation/store";
import { buildDelivery } from "../lib/domain/delivery/build";
import { failedChecksSummary } from "../lib/domain/delivery/validate";
import { deliveryFiles, readStoredFile } from "../lib/domain/delivery/read";
import type { AttributeProvenance } from "../lib/domain/consolidation/types";
import { profileEntryKey } from "../lib/domain/profile-view";
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

/**
 * The text of the e2e fact scene; the holding fact quotes `FACT_QUOTE` from it, the two `shelter.N` facts
 * `SHELTER_QUOTE` (version 1 of the profile) and `SHELTER_LATER_QUOTE` (version 2).
 */
const FACT_TEXT =
  "The bay is calm in the evening. Holding is good in sand at five metres, well sheltered from the north. In strong northerlies a swell works in.";
const FACT_QUOTE = "Holding is good in sand at five metres";
const SHELTER_QUOTE = "well sheltered from the north";
const SHELTER_LATER_QUOTE = "In strong northerlies a swell works in";

/** Today (UTC) plus `n` days, `YYYY-MM-DD`. */
const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
/** The run date of the scene's profile version 1; version 2 is consolidated today. */
const PROFILE_V1_DATE = day(-10);

/**
 * A bay with a place and verified text facts (holding, `shelter.N` „gut geschützt“) of a finished, active extraction
 * run, quoted from a document of a proposed `*.e2e.test.invalid` source, unique per run (all these rows are
 * append-only or stable, so every run adds one). Open sea outside the pilot box. The geo object is valid from 30 days
 * ago, so a profile version can be dated before today. The document is `gone`, so no text run, pending selection or
 * model comparison sample of another test ever takes it in. Returns the place id, the geo object id and `later`,
 * which adds the second `shelter.N` fact.
 */
async function createFactScene(db: Db): Promise<{ placeId: string; geoObjectId: string; later: () => Promise<unknown> }> {
  const cfg = loadConfig("config");
  const task = cfg.models.tasks["extract-facts"]!;
  const name = `E2E Fact Bay ${new Date().toISOString()}`;
  const geom = sql`${geomFromGeoJson({ type: "Point", coordinates: [27.93, 34.93] })}`;
  return db.transaction(async (tx) => {
    const validFrom = day(-30);
    const [object] = await tx.insert(geoObjects).values({ type: "bay", origin: "manual", geom, validFrom }).returning({ id: geoObjects.id });
    await tx
      .insert(geoNames)
      .values({ geoObjectId: object!.id, name, nameNormalized: name.toLowerCase(), language: "en", script: "latin", origin: "manual", validFrom });
    const [place] = await tx.insert(places).values({ geoObjectId: object!.id, kind: "anchorage", position: geom, validFrom }).returning({ id: places.id });
    const domain = `${Date.now()}.facts${E2E_SOURCE_SUFFIX}`;
    const [source] = await tx
      .insert(sources)
      .values({ domain, name: domain, type: "pilot_guide", weight: 0.9, status: "proposed", crawlRules: {}, origin: "manual" })
      .returning({ id: sources.id });
    const url = `https://${domain}/bay`;
    const [doc] = await tx.insert(documents).values({ sourceId: source!.id, url, urlNormalized: url, docType: "pilot_guide", status: "gone" }).returning({ id: documents.id });
    const [version] = await tx
      .insert(documentVersions)
      .values({
        documentId: doc!.id,
        fetchedAt: new Date(),
        contentHash: `e2e-${Date.now()}`,
        rawHash: "e2e",
        rawKey: `archive/${doc!.id}/e2e.raw.html`,
        mdKey: `archive/${doc!.id}/e2e.md`,
        observedAt: new Date().toISOString().slice(0, 10),
        observedAtBasis: "fetched",
        docType: "pilot_guide",
        converter: "local",
        charCount: FACT_TEXT.length,
      })
      .returning({ id: documentVersions.id });
    await tx.update(documents).set({ currentVersionId: version!.id }).where(eq(documents.id, doc!.id));
    const [chunk] = await tx
      .insert(chunks)
      .values({ documentVersionId: version!.id, ordinal: 0, text: FACT_TEXT, textNormalized: FACT_TEXT, textHash: "e2e", charStart: 0, charEnd: FACT_TEXT.length, wordCount: 19 })
      .returning({ id: chunks.id });
    const [mention] = await tx
      .insert(mentions)
      .values({ documentVersionId: version!.id, chunkId: chunk!.id, geoObjectId: object!.id, surface: "The bay", charStart: 0, charEnd: 7, observedAt: new Date().toISOString().slice(0, 10), confidence: 1, matchKind: "deterministic", extractionStatus: "done" })
      .returning({ id: mentions.id });
    const [run] = await tx.insert(runs).values({ kind: "stage", scopeType: "system", scopeId: "e2e", triggeredBy: "e2e", status: "finished" }).returning({ id: runs.id });
    const [er] = await tx
      .insert(extractionRuns)
      .values({
        task: "extract-facts",
        model: task.model,
        promptVersion: task.promptVersion,
        factSchemaVersion: cfg.factSchema.version,
        purpose: "regular",
        runId: run!.id,
        status: "finished",
        quoteCheck: { facts: 3, verified: 3, ratio: 1, failures: [] },
        finishedAt: new Date(),
      })
      .returning({ id: extractionRuns.id });
    await tx.insert(extractionUnits).values({ extractionRunId: er!.id, documentVersionId: version!.id, geoObjectId: object!.id, part: 0, level: "place", mentionIds: [mention!.id], chunkIds: [chunk!.id], status: "done" });
    const fact = (attribute: string, value: unknown, quote: string, observedAt: string, mentionId = mention!.id) => {
      const start = FACT_TEXT.indexOf(quote);
      return {
        geoObjectId: object!.id,
        attribute,
        value,
        mentionId,
        quote,
        quoteVerified: true,
        quoteChunkId: chunk!.id,
        quoteStart: start,
        quoteEnd: start + quote.length,
        observedAt,
        confidence: 0.9,
        extractionRunId: er!.id,
        factSchemaVersion: cfg.factSchema.version,
      };
    };
    await tx.insert(facts).values([
      fact("holding", "good", FACT_QUOTE, new Date().toISOString().slice(0, 10)),
      fact("shelter.N", 0.9, SHELTER_QUOTE, PROFILE_V1_DATE),
    ]);
    // inserted after profile version 1: the worse text value lowers shelter.N from 0.9 to 0.5 in version 2; a second
    // mention of the same chunk and run (one fact per mention, attribute and run) in a second unit of the run
    const later = () =>
      db.transaction(async (t2) => {
        const today = new Date().toISOString().slice(0, 10);
        const at = FACT_TEXT.indexOf(SHELTER_LATER_QUOTE);
        const [second] = await t2
          .insert(mentions)
          .values({ documentVersionId: version!.id, chunkId: chunk!.id, geoObjectId: object!.id, surface: "northerlies", charStart: at + 10, charEnd: at + 21, observedAt: today, confidence: 1, matchKind: "deterministic", extractionStatus: "done" })
          .returning({ id: mentions.id });
        await t2.insert(extractionUnits).values({ extractionRunId: er!.id, documentVersionId: version!.id, geoObjectId: object!.id, part: 1, level: "place", mentionIds: [second!.id], chunkIds: [chunk!.id], status: "done" });
        await t2.insert(facts).values(fact("shelter.N", 0.5, SHELTER_LATER_QUOTE, today, second!.id));
      });
    return { placeId: place!.id, geoObjectId: object!.id, later };
  });
}

/** The hazard of the removal scene: a profile entry „Eintrag entfernen“ can remove. */
const REMOVAL_HAZARD = { kind: "rock", name: "E2E Xera" };

/**
 * A confirmed bay whose profile (version 1, written directly: no fact is needed to show an entry) lists one hazard,
 * for the two-step „Eintrag entfernen“. Its own object per run, at the e2e coordinate of the fact scene (outside the
 * pilot box), so the fact scene's versions stay untouched. Returns the place id.
 */
async function createRemovalScene(db: Db): Promise<string> {
  const cfg = loadConfig("config").consolidation;
  const name = `E2E Removal Bay ${new Date().toISOString()}`;
  const geom = sql`${geomFromGeoJson({ type: "Point", coordinates: [27.93, 34.93] })}`;
  const key = profileEntryKey("hazards", REMOVAL_HAZARD, cfg);
  const hazards: AttributeProvenance = {
    origin: "text", rule: "union", confidence: 0.6, confidenceClass: "medium", observedAt: null, lastConfirmedAt: null,
    factIds: [], sourceKeys: [], computationIds: [], poiIds: [], expired: false, onlyGoneSources: false, conflictKey: null,
    observedMonths: [], entryFactIds: { [key]: [] },
  };
  return db.transaction(async (tx) => {
    const [object] = await tx.insert(geoObjects).values({ type: "bay", origin: "manual", geom }).returning({ id: geoObjects.id });
    await tx.insert(geoNames).values({ geoObjectId: object!.id, name, nameNormalized: name.toLowerCase(), language: "en", script: "latin", origin: "manual" });
    const [place] = await tx.insert(places).values({ geoObjectId: object!.id, kind: "anchorage", status: "confirmed", position: geom }).returning({ id: places.id });
    await tx.insert(profiles).values({
      geoObjectId: object!.id,
      version: 1,
      validFrom: new Date().toISOString().slice(0, 10),
      attributes: { hazards: [REMOVAL_HAZARD] },
      provenance: { hazards },
      sourcesCount: 1,
      documentsCount: 1,
      contentHash: `e2e-removal-${object!.id}`,
      factSchemaVersion: loadConfig("config").factSchema.version,
      rulesVersion: cfg.version,
    });
    return place!.id;
  });
}

/** Domain suffix of the sources the e2e run proposes (never a real domain). */
const E2E_SOURCE_SUFFIX = ".e2e.test.invalid";

/**
 * A proposed source with an open `source_approval` task, unique per run (sources are never deleted). Sources an
 * earlier, aborted run left approved are paused first: committed test sources must never stay approved (ruling
 * M3-P11). Returns the domain and the task id.
 */
async function createSourceProposal(db: Db): Promise<{ domain: string; taskId: string }> {
  const domain = `${Date.now()}${E2E_SOURCE_SUFFIX}`;
  return db.transaction(async (tx) => {
    await tx
      .update(sources)
      .set({ status: "paused", statusReason: "e2e" })
      .where(and(eq(sources.status, "approved"), like(sources.domain, `%${E2E_SOURCE_SUFFIX}`)));
    const [source] = await tx
      .insert(sources)
      .values({ domain, name: domain, type: "trip_report", weight: 0.6, status: "proposed", crawlRules: {}, origin: "serp" })
      .returning({ id: sources.id });
    const task = await createReviewTask(tx, {
      kind: "source_approval",
      subjectType: "source",
      subjectId: source!.id,
      context: { hits: [], hitCount: 0, linkingSources: 0, languages: ["de"], robots: null },
      priority: REVIEW_PRIORITY,
    });
    return { domain, taskId: task.id };
  });
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
 * A place whose title image is approved (tab „Titelbild“): a render of the cadastre imagery (source `ktimatologio`, not
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
 * Creates the e2e admin in the TEST database unless it already exists (idempotent) and a fresh place candidate
 * for the review test; its name is passed to the tests as E2E_REVIEW_PLACE. A proposed source for the sources test
 * (E2E_SOURCE_DOMAIN, task E2E_SOURCE_TASK). The synthetic delivery subdivision with its valid package (E2E_DELIVERY_SUBDIVISION).
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
    const proposal = await createSourceProposal(db);
    process.env.E2E_SOURCE_DOMAIN = proposal.domain;
    process.env.E2E_SOURCE_TASK = proposal.taskId;
    const scene = await createFactScene(db);
    process.env.E2E_FACT_PLACE = scene.placeId;
    // the fact scene's profile for the profile and timeline tabs (append-only, one scene per run): version 1 ten days
    // ago with shelter.N 0.9, version 2 today with shelter.N 0.5 after a worse text fact
    const v1 = await consolidateGeo(db, scene.geoObjectId, { today: PROFILE_V1_DATE });
    await scene.later();
    const v2 = await consolidateGeo(db, scene.geoObjectId);
    if (v1.version !== 1 || v2.status !== "created" || v2.version !== 2) {
      throw new Error(`e2e fact scene: expected profile versions 1 and 2, got ${JSON.stringify([v1, v2])}`);
    }
    process.env.E2E_IMAGE_TASK = (await createPlaceImageScene(db)).taskId;
    process.env.E2E_IMAGE_PLACE = await createApprovedImageScene(db);
    process.env.E2E_REMOVAL_PLACE = await createRemovalScene(db);
    process.env.E2E_FACT_QUOTE = FACT_QUOTE;
    process.env.E2E_SHELTER_QUOTE = SHELTER_LATER_QUOTE;
    process.env.E2E_DELIVERY_SUBDIVISION = await ensureDeliverySubdivision(db);
    await ensureE2eSubdivision(db);
  } finally {
    await close();
  }
}
