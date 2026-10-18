import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL(".", import.meta.url)) },
  },
  test: {
    environment: "node",
    include: ["**/__tests__/**/*.test.ts", "test/**/*.test.ts"],
    exclude: ["node_modules/**", ".next/**"],
    globalSetup: ["test/global-setup.ts"],
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
    },
  },
});
