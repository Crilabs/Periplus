import pino from "pino";
import { getEnv } from "./env";

export const REDACT_PATHS = [
  "password",
  "passwordHash",
  "apiKey",
  "key",
  "token",
  "*.password",
  "*.apiKey",
  "headers.authorization",
  "headers.cookie",
  "authorization",
  "cookie",
];

function resolveSettings(): { level: string; pretty: boolean } {
  try {
    const env = getEnv();
    return { level: env.LOG_LEVEL, pretty: env.NODE_ENV === "development" };
  } catch {
    // Invalid or incomplete env (e.g. in tests): fall back to safe defaults.
    return { level: "info", pretty: false };
  }
}

export function createLogger(module: string): pino.Logger {
  const { level, pretty } = resolveSettings();
  return pino({
    level,
    redact: REDACT_PATHS,
    base: { module },
    ...(pretty ? { transport: { target: "pino-pretty" } } : {}),
  });
}
