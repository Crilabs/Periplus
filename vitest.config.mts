import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/** Tests that run whole gazetteer, dataset or geometry passes over the pilot area in one long transaction. */
const PILOT_RUN_TESTS = [
  "lib/pipeline/__tests__/gazetteer-run.test.ts",
  "lib/pipeline/__tests__/datasets.test.ts",
  "lib/pipeline/__tests__/geometry-golden.test.ts",
];

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
          exclude: ["node_modules/**", ".next/**", ...PILOT_RUN_TESTS],
        },
      },
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
