import { afterEach, describe, expect, it, vi } from "vitest";

async function freshRegister() {
  vi.resetModules();
  return (await import("@/instrumentation")).register;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("instrumentation register", () => {
  it("exits the Node.js server process when SESSION_SECRET is missing", async () => {
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    vi.stubEnv("SESSION_SECRET", "");
    const exit = vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`exit ${code}`);
    });
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    await expect((await freshRegister())()).rejects.toThrow("exit 1");
    expect(exit).toHaveBeenCalledWith(1);
    expect(String(stderr.mock.calls[0][0])).toMatch(/startup validation failed.*SESSION_SECRET/s);
  });

  it("passes with a valid env and config", async () => {
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    const exit = vi.spyOn(process, "exit");
    await expect((await freshRegister())()).resolves.toBeUndefined();
    expect(exit).not.toHaveBeenCalled();
  });

  it("skips validation on the edge runtime and during next build", async () => {
    vi.stubEnv("SESSION_SECRET", "");
    const exit = vi.spyOn(process, "exit");
    vi.stubEnv("NEXT_RUNTIME", "edge");
    await expect((await freshRegister())()).resolves.toBeUndefined();
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    vi.stubEnv("NEXT_PHASE", "phase-production-build");
    await expect((await freshRegister())()).resolves.toBeUndefined();
    expect(exit).not.toHaveBeenCalled();
  });
});
