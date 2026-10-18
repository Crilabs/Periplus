import { afterEach, describe, expect, it, vi } from "vitest";

const ping = vi.fn<() => Promise<boolean>>();
const execute = vi.fn<() => Promise<unknown>>();

vi.mock("@/lib/adapters/s3", () => ({ getArchive: () => ({ ping }) }));
vi.mock("@/lib/db/client", () => ({ getDb: () => ({ execute }) }));
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  connection: async () => {},
}));

import { GET as healthz } from "../healthz/route";
import { GET as readyz } from "../readyz/route";

afterEach(() => {
  vi.useRealTimers();
  vi.resetAllMocks();
});

describe("healthz", () => {
  it("returns 200 ok without touching dependencies", async () => {
    const res = await healthz();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
    expect(execute).not.toHaveBeenCalled();
    expect(ping).not.toHaveBeenCalled();
  });
});

describe("readyz", () => {
  it("returns 200 when database and archive are reachable", async () => {
    execute.mockResolvedValue([]);
    ping.mockResolvedValue(true);
    const res = await readyz();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  it("returns 503 without details when the archive is unreachable", async () => {
    execute.mockResolvedValue([]);
    ping.mockResolvedValue(false);
    const res = await readyz();
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ status: "unavailable" });
  });

  it("returns 503 without details when the database throws", async () => {
    execute.mockRejectedValue(new Error("connect ECONNREFUSED secret-host:5432"));
    ping.mockResolvedValue(true);
    const res = await readyz();
    expect(res.status).toBe(503);
    expect(await res.text()).not.toContain("secret-host");
  });

  it("returns 503 when the database does not answer within 3 s", async () => {
    vi.useFakeTimers();
    execute.mockReturnValue(new Promise(() => {}));
    ping.mockResolvedValue(true);
    const pending = readyz();
    await vi.advanceTimersByTimeAsync(3001);
    const res = await pending;
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ status: "unavailable" });
  });
});
