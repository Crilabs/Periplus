import { Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLogger } from "../logger";

type Line = Record<string, unknown> & { headers: Record<string, unknown> };

function captureLogs(fn: (log: ReturnType<typeof createLogger>) => void): Line[] {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      lines.push(...chunk.toString().split("\n").filter(Boolean));
      cb();
    },
  });
  fn(createLogger("test", stream));
  return lines.map((l) => JSON.parse(l));
}

afterEach(() => vi.unstubAllEnvs());

describe("logger", () => {
  it("redacts password, apiKey, authorization and cookie fields", () => {
    const [line] = captureLogs((log) =>
      log.info({ password: "p", apiKey: "k", headers: { authorization: "a", cookie: "c" } }, "x"),
    );
    expect(line.password).toBe("[Redacted]");
    expect(line.apiKey).toBe("[Redacted]");
    expect(line.headers.authorization).toBe("[Redacted]");
    expect(line.headers.cookie).toBe("[Redacted]");
  });

  it("redacts nested token, key, passwordHash, authorization and cookie", () => {
    const [line] = captureLogs((log) =>
      log.info(
        {
          user: { token: "t", key: "k", passwordHash: "h" },
          req: { authorization: "a", cookie: "c" },
          token: "t2",
          passwordHash: "h2",
        },
        "x",
      ),
    );
    expect(line.user).toEqual({ token: "[Redacted]", key: "[Redacted]", passwordHash: "[Redacted]" });
    expect(line.req).toEqual({ authorization: "[Redacted]", cookie: "[Redacted]" });
    expect(line.token).toBe("[Redacted]");
    expect(line.passwordHash).toBe("[Redacted]");
  });

  it("createLogger tags the module", () => {
    const log = createLogger("test-module");
    expect(log.bindings()).toMatchObject({ module: "test-module" });
  });

  it("surfaces an invalid env outside of tests instead of falling back", async () => {
    vi.resetModules();
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("SESSION_SECRET", "short");
    const fresh = await import("../logger");
    expect(() => fresh.createLogger("x")).toThrow(/SESSION_SECRET/);
  });
});
