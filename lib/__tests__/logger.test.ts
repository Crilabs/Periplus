import { Writable } from "node:stream";
import pino from "pino";
import { describe, expect, it } from "vitest";
import { createLogger, REDACT_PATHS } from "../logger";

function captureLogs(fn: (log: pino.Logger) => void): string[] {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      lines.push(...chunk.toString().split("\n").filter(Boolean));
      cb();
    },
  });
  const log = pino({ level: "debug", redact: REDACT_PATHS }, stream);
  fn(log);
  return lines;
}

describe("logger", () => {
  it("redacts password, apiKey, authorization and cookie fields", () => {
    const lines = captureLogs((log) =>
      log.info({ password: "p", apiKey: "k", headers: { authorization: "a", cookie: "c" } }, "x"),
    );
    expect(lines[0]).not.toMatch(/"p"|"k"|"a"|"c"/);
    expect(lines[0]).toContain("[Redacted]");
  });

  it("createLogger tags the module", () => {
    const log = createLogger("test-module");
    expect(log.bindings()).toMatchObject({ module: "test-module" });
  });
});
