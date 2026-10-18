import { defineConfig, devices } from "@playwright/test";

const PORT = 3100;
const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL || "postgres://periplus:periplus@localhost:5434/periplus_test";

// Shared with e2e/global-setup.ts and e2e/login.spec.ts via the environment.
process.env.E2E_EMAIL ??= "e2e-admin@example.invalid";
process.env.E2E_PASSWORD ??= "e2e-correct-horse-battery-staple";

// Dev defaults (dev S3, test DB); process.env is what globalSetup and the app server inherit.
const defaults: Record<string, string> = {
  TEST_DATABASE_URL,
  S3_ENDPOINT: "http://localhost:8333",
  S3_REGION: "us-east-1",
  S3_BUCKET: "periplus-test",
  S3_ACCESS_KEY_ID: "periplus",
  S3_SECRET_ACCESS_KEY: "periplus-dev-secret",
  SESSION_SECRET: "e2e-session-secret-0123456789-abcdefghijklmnopqrstuv",
  CONTACT_EMAIL: "e2e@example.invalid",
  LOG_LEVEL: "silent",
};
for (const [key, value] of Object.entries(defaults)) process.env[key] ||= value;

export default defineConfig({
  testDir: "./e2e",
  globalSetup: "./e2e/global-setup.ts",
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  use: { baseURL: `http://localhost:${PORT}`, ...devices["Desktop Chrome"] },
  webServer: {
    command: "npm run build && npm start",
    url: `http://localhost:${PORT}/healthz`,
    timeout: 240_000,
    reuseExistingServer: false,
    env: {
      PORT: String(PORT),
      DATABASE_URL: TEST_DATABASE_URL,
      TEST_DATABASE_URL,
      S3_ENDPOINT: process.env.S3_ENDPOINT!,
      S3_REGION: process.env.S3_REGION!,
      S3_BUCKET: process.env.S3_BUCKET!,
      S3_ACCESS_KEY_ID: process.env.S3_ACCESS_KEY_ID!,
      S3_SECRET_ACCESS_KEY: process.env.S3_SECRET_ACCESS_KEY!,
      SESSION_SECRET: process.env.SESSION_SECRET!,
      CONTACT_EMAIL: process.env.CONTACT_EMAIL!,
      LOG_LEVEL: process.env.LOG_LEVEL!,
    },
  },
});
