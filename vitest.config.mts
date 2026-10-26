import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * Tests that run whole gazetteer, dataset or geometry passes over the pilot area in one long transaction, and every
 * other file that seeds the aegina-west subdivision (`insertAeginaWest`): its key is unique among valid rows, so two
 * such transactions in parallel wait on each other beyond the test timeout. One worker runs these files in turn.
 */
const PILOT_RUN_TESTS = [
  "app/(admin)/__tests__/actions.test.ts",
  "lib/pipeline/__tests__/gazetteer-run.test.ts",
  "lib/pipeline/__tests__/datasets.test.ts",
  "lib/pipeline/__tests__/geometry-golden.test.ts",
];

/**
 * Tests that seed the delivery fixture subdivision (`test/fixtures/delivery/subdivision.ts`). Its fixed tiles, subdivision key and public
 * ids are unique keys, so two of these transactions wait on each other's uncommitted rows, beyond the test timeout
 * under full parallel load. One worker runs these files one after another, beside the default project.
 * `seedDeliverySubdivision` refuses to run outside this project.
 */
const DELIVERY_FIXTURE_TESTS = [
  "app/__tests__/api-changes-spots.test.ts",
  "app/__tests__/api-package.test.ts",
  "app/__tests__/api-radius.test.ts",
  "app/(admin)/__tests__/delivery-actions.test.ts",
  "app/(admin)/__tests__/radius-actions.test.ts",
  "app/(admin)/__tests__/place-actions.test.ts",
  "lib/domain/__tests__/place-merge.test.ts",
  "lib/domain/__tests__/place-status.test.ts",
  "lib/domain/delivery/__tests__/build.test.ts",
  "lib/domain/delivery/__tests__/coast.test.ts",
  "lib/domain/delivery/__tests__/images.test.ts",
  "lib/domain/delivery/__tests__/load.test.ts",
  "lib/domain/delivery/__tests__/map-region.test.ts",
  "lib/domain/delivery/__tests__/map-spot.test.ts",
  "lib/domain/delivery/__tests__/place-delivery.test.ts",
  "lib/domain/delivery/__tests__/read.test.ts",
  "lib/domain/delivery/__tests__/validate.test.ts",
  "lib/domain/delivery/__tests__/view.test.ts",
  "lib/domain/delivery/__tests__/weather-points.test.ts",
  "lib/domain/delivery/radius/__tests__/build.test.ts",
  "lib/domain/delivery/radius/__tests__/changes.test.ts",
  "lib/domain/delivery/radius/__tests__/view.test.ts",
  "lib/pipeline/__tests__/delivery-run.test.ts",
  "scripts/__tests__/delivery-consume.test.ts",
  "scripts/__tests__/migrate-subdivisions.test.ts",
];

/**
 * Tests that seed the revisit fixture area (`test/revisit/fixture/area.ts`): its fixed tile, source domains and public
 * ids are unique keys like the delivery fixture's, so these files run one after another, beside the default project.
 */
const REVISIT_FIXTURE_TESTS = ["lib/pipeline/__tests__/revisit-run.test.ts", "scripts/__tests__/draft-scenario.test.ts"];

/**
 * Tests that run the imagery fetch (`ensureImagery`, via `generatePlaceImage` or the images stage) inside a `withRollback`
 * transaction. Their tiles have fixed keys (the same WMS cells and the same 1° DEM tile for every test spot) and
 * `httpCall` takes its rate token from the bucket rows `http:ktimatologio`, `http:sentinel2` and `http:copernicus_dem`:
 * the transaction keeps those rows and the unique tile keys locked until the test ends, so two such tests in parallel
 * wait on each other, beyond the test timeout when the runner is slow. One worker runs these files in turn.
 */
const IMAGERY_TESTS = [
  "app/(admin)/__tests__/place-image-actions.test.ts",
  "app/(admin)/__tests__/review-place-image.test.ts",
  "lib/domain/images/__tests__/approve.test.ts",
  "lib/pipeline/images/__tests__/generate.test.ts",
  "lib/pipeline/images/__tests__/imagery.test.ts",
  "lib/pipeline/images/__tests__/model.test.ts",
  "lib/pipeline/images/__tests__/stage.test.ts",
];

/** Fallback is the shared test database; a session with its own database pair sets TEST_DATABASE_URL (docker/compose.isolated.yml). */
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgres://periplus:periplus@localhost:5434/periplus_test";

/**
 * Tests that seed the text test tile `tileIdFor(21.0, 35.2)` (`insertTestTile`) inside a `withRollback` transaction. The
 * tile id is the primary key, so a second transaction's insert waits until the first one ends; across files in parallel
 * these waits chain beyond the 5 s test timeout when the runner is slow. One worker runs these files in turn.
 */
const TEXT_TILE_TESTS = [
  "lib/domain/extraction/__tests__/facts.test.ts",
  "lib/domain/extraction/__tests__/routes.test.ts",
  "lib/domain/places/__tests__/auto-status.test.ts",
  "lib/pipeline/__tests__/extract.test.ts",
  "lib/pipeline/__tests__/routes.test.ts",
];

export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL(".", import.meta.url)) },
  },
  test: {
    environment: "node",
    // All files share one test Postgres; beyond 8 workers they only wait on each other and hit the 5 s timeout.
    maxWorkers: 8,
    // Even at 8 workers a database test sometimes waits longer than 5 s on a busy runner and fails although it
    // passes on its own; 15 s keeps CI green without hiding a hang.
    testTimeout: 15_000,
    projects: [
      {
        extends: true,
        test: {
          name: "default",
          include: ["**/__tests__/**/*.test.{ts,tsx}", "test/**/*.test.ts"],
          exclude: ["node_modules/**", ".next/**", ".claude/**", ...PILOT_RUN_TESTS, ...DELIVERY_FIXTURE_TESTS, ...REVISIT_FIXTURE_TESTS, ...IMAGERY_TESTS, ...TEXT_TILE_TESTS],
        },
      },
      {
        extends: true,
        test: { name: "delivery-fixture", include: DELIVERY_FIXTURE_TESTS, fileParallelism: false, env: { PERIPLUS_TEST_PROJECT: "delivery-fixture" } },
      },
      { extends: true, test: { name: "imagery", include: IMAGERY_TESTS, fileParallelism: false } },
      { extends: true, test: { name: "text-tile", include: TEXT_TILE_TESTS, fileParallelism: false } },
      { extends: true, test: { name: "revisit-fixture", include: REVISIT_FIXTURE_TESTS, fileParallelism: false } },
      // Long pilot-area runs hold rows (pilot tiles, configured areas) other test files write too:
      // run them after everything else instead of beside it.
      { extends: true, test: { name: "pilot-run", include: PILOT_RUN_TESTS, fileParallelism: false, sequence: { groupOrder: 1 } } },
    ],
    globalSetup: ["test/global-setup.ts"],
    setupFiles: ["test/setup.ts"],
    // Non-secret test defaults so tests run without a local .env file.
    env: {
      NODE_ENV: "test",
      LOG_LEVEL: "silent",
      TEST_DATABASE_URL: TEST_DATABASE_URL,
      DATABASE_URL: TEST_DATABASE_URL,
      S3_ENDPOINT: "http://localhost:8333",
      S3_REGION: "us-east-1",
      S3_BUCKET: "periplus-test",
      S3_TEST_BUCKET: "periplus-test",
      S3_ACCESS_KEY_ID: "periplus",
      S3_SECRET_ACCESS_KEY: "periplus-dev-secret",
      SESSION_SECRET: "test-session-secret-0123456789-abcdefghijklmnopqrst",
      CONTACT_EMAIL: "test@example.invalid",
      // Fixture replay ignores request headers; any Basic-Auth pair will do.
      DATAFORSEO_LOGIN: "test@example.invalid",
      DATAFORSEO_PASSWORD: "test-password",
      JINA_API_KEY: "test-jina-key",
      FIRECRAWL_API_KEY: "test-firecrawl-key",
      VOYAGE_API_KEY: "test-voyage-key",
    },
  },
});
