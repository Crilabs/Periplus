import { execFileSync } from "node:child_process";
import { and, eq, like, sql } from "drizzle-orm";
import { createDb, type Db } from "../lib/db/client";
import { geomFromGeoJson } from "../lib/db/geometry";
import { loadConfig } from "../lib/config";
import {
  chunks,
  documents,
  documentVersions,
  extractionRuns,
  extractionUnits,
  facts,
  geoNames,
  geoObjects,
  mentions,
  places,
  runs,
  sources,
} from "../lib/db/schema";
import { consolidateGeo } from "../lib/domain/consolidation/store";
import { createReviewTask } from "../lib/domain/review";
import { createUser } from "../lib/domain/users";

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

/**
 * Creates the e2e admin in the TEST database unless it already exists (idempotent) and a fresh place candidate
 * for the review test; its name is passed to the tests as E2E_REVIEW_PLACE. A proposed source for the sources test
 * (E2E_SOURCE_DOMAIN, task E2E_SOURCE_TASK).
 */
export default async function globalSetup(): Promise<void> {
  const url = process.env.TEST_DATABASE_URL ?? "postgres://periplus:periplus@localhost:5434/periplus_test";
  const dbName = decodeURIComponent(new URL(url).pathname.replace(/^\//, ""));
  if (!dbName.endsWith("_test")) throw new Error(`Refusing to run e2e: database "${dbName}" must end with "_test"`);

  // The e2e run may be the first thing to touch the test database, so make sure it is migrated.
  execFileSync("npx", ["tsx", "scripts/migrate.ts"], { env: { ...process.env, DATABASE_URL: url }, stdio: "ignore" });
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
    process.env.E2E_FACT_QUOTE = FACT_QUOTE;
    process.env.E2E_SHELTER_QUOTE = SHELTER_LATER_QUOTE;
    // Pilot-area tests roll back, so the test database normally has no saronic area object (like a fresh
    // installation before its first gazetteer run); the quality spec checks the page for either state.
    const { rows } = await db.execute(
      sql`select 1 from geo_objects where type = 'area' and config_key = 'saronic' and valid_to is null`,
    );
    process.env.E2E_SARONIC_AREA = rows.length > 0 ? "created" : "missing";
  } finally {
    await close();
  }
}
