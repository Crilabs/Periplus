import { afterEach, describe, expect, it, vi } from "vitest";
import { parseEnv } from "../env";

const validSource = {
  DATABASE_URL: "postgres://u:p@localhost:5432/db",
  SESSION_SECRET: "x".repeat(40),
  S3_ENDPOINT: "http://localhost:8333",
  S3_REGION: "us-east-1",
  S3_BUCKET: "bucket",
  S3_ACCESS_KEY_ID: "id",
  S3_SECRET_ACCESS_KEY: "secret",
  CONTACT_EMAIL: "ops@example.invalid",
};

afterEach(() => vi.unstubAllEnvs());

describe("parseEnv", () => {
  it("parses a complete env and defaults LOG_LEVEL to info", () => {
    expect(parseEnv(validSource).LOG_LEVEL).toBe("info");
  });

  it("defaults NODE_ENV to development and keeps ANTHROPIC_API_KEY optional", () => {
    const env = parseEnv(validSource);
    expect(env.NODE_ENV).toBe("development");
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it("rejects a SESSION_SECRET shorter than 32 chars without echoing the value", () => {
    expect(() => parseEnv({ ...validSource, SESSION_SECRET: "short-secret-value" })).toThrow(
      /SESSION_SECRET/,
    );
    try {
      parseEnv({ ...validSource, SESSION_SECRET: "short-secret-value" });
    } catch (e) {
      expect(String(e)).not.toContain("short-secret-value");
    }
  });

  it("defaults PERIPLUS_RENDERER to playwright and accepts off only besides it", () => {
    expect(parseEnv(validSource).PERIPLUS_RENDERER).toBe("playwright");
    expect(parseEnv({ ...validSource, PERIPLUS_RENDERER: "off" }).PERIPLUS_RENDERER).toBe("off");
    expect(() => parseEnv({ ...validSource, PERIPLUS_RENDERER: "chrome" })).toThrow(/PERIPLUS_RENDERER/);
  });

  it("names missing variables", () => {
    const { DATABASE_URL: _omit, ...rest } = validSource;
    void _omit;
    expect(() => parseEnv(rest)).toThrow(/DATABASE_URL/);
  });

  it("does not read process.env at import time", async () => {
    vi.stubEnv("DATABASE_URL", "");
    await expect(import("../env")).resolves.toBeDefined();
  });
});
