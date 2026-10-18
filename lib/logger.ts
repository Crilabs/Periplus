import pino from "pino";
import { getEnv } from "./env";

export const REDACT_PATHS = [
  "password",
  "passwordHash",
  "apiKey",
  "key",
  "token",
  "*.password",
  "*.passwordHash",
  "*.apiKey",
  "*.key",
  "*.token",
  "*.authorization",
  "*.cookie",
  "headers.authorization",
  "headers.cookie",
  "authorization",
  "cookie",
];

function resolveSettings(): { level: string; pretty: boolean } {
  try {
    const env = getEnv();
    return { level: env.LOG_LEVEL, pretty: env.NODE_ENV === "development" };
  } catch (error) {
    // Only tests may run with an incomplete env; everywhere else the env error must surface.
    if (process.env.NODE_ENV === "test") return { level: "info", pretty: false };
    throw error;
  }
}

export function createLogger(module: string, destination?: pino.DestinationStream): pino.Logger {
  const { level, pretty } = resolveSettings();
  const options: pino.LoggerOptions = { level, redact: REDACT_PATHS, base: { module } };
  if (destination) return pino(options, destination);
  return pino(pretty ? { ...options, transport: { target: "pino-pretty" } } : options);
}
