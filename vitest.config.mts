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
  "app/(admin)/__tests__/delivery-actions.test.ts",
  "app/(admin)/__tests__/place-actions.test.ts",
  "lib/domain/__tests__/place-merge.test.ts",
  "lib/domain/__tests__/place-status.test.ts",
  "lib/domain/delivery/__tests__/build.test.ts",
  "lib/domain/delivery/__tests__/coast.test.ts",
  "lib/domain/delivery/__tests__/load.test.ts",
  "lib/domain/delivery/__tests__/map-region.test.ts",
  "lib/domain/delivery/__tests__/map-spot.test.ts",
  "lib/domain/delivery/__tests__/place-delivery.test.ts",
  "lib/domain/delivery/__tests__/read.test.ts",
  "lib/domain/delivery/__tests__/validate.test.ts",
  "lib/domain/delivery/__tests__/view.test.ts",
  "lib/domain/delivery/__tests__/weather-points.test.ts",
  "lib/pipeline/__tests__/delivery-run.test.ts",
  "scripts/__tests__/delivery-consume.test.ts",
  "scripts/__tests__/migrate-subdivisions.test.ts",
];

/**
 * Tests that seed the revisit fixture area (`test/revisit/fixture/area.ts`): its fixed tile, source domains and public
 * ids are unique keys like the delivery fixture's, so these files run one after another, beside the default project.
 */
const REVISIT_FIXTURE_TESTS = ["lib/pipeline/__tests__/revisit-run.test.ts", "scripts/__tests__/draft-scenario.test.ts"];

export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL(".", import.meta.url)) },
  },
  test: {
    environment: "node",
    // All files share one test Postgres; beyond 8 workers they only wait on each other and hit the 5 s timeout.
    maxWorkers: 8,
    projects: [
      {
        extends: true,
        test: {
          name: "default",
          include: ["**/__tests__/**/*.test.{ts,tsx}", "test/**/*.test.ts"],
          exclude: ["node_modules/**", ".next/**", ".claude/**", ...PILOT_RUN_TESTS, ...DELIVERY_FIXTURE_TESTS, ...REVISIT_FIXTURE_TESTS],
        },
      },
      {
        extends: true,
        test: { name: "delivery-fixture", include: DELIVERY_FIXTURE_TESTS, fileParallelism: false, env: { PERIPLUS_TEST_PROJECT: "delivery-fixture" } },
      },
      { extends: true, test: { name: "revisit-fixture", include: REVISIT_FIXTURE_TESTS, fileParallelism: false } },
      // Long pilot-area runs hold rows (pilot tiles, configured areas) other test files write too:
      // run them after everything else instead of beside it.
      { extends: true, test: { name: "pilot-run", include: PILOT_RUN_TESTS, sequence: { groupOrder: 1 } } },
    ],
    globalSetup: ["test/global-setup.ts"],
    setupFiles: ["test/setup.ts"],
    // Non-secret test defaults so tests run without a local .env file.
    env: {
      NODE_ENV: "test",
      LOG_LEVEL: "silent",
      TEST_DATABASE_URL: "postgres://periplus:periplus@localhost:5434/periplus_test",
      DATABASE_URL: "postgres://periplus:periplus@localhost:5434/periplus_test",
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
