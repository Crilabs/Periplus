import { execFileSync } from "node:child_process";
import { and, eq, like, sql } from "drizzle-orm";
import { createDb, type Db } from "../lib/db/client";
import { geomFromGeoJson } from "../lib/db/geometry";
import { geoNames, geoObjects, places, sources } from "../lib/db/schema";
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
