import { existsSync, mkdtempSync, readFileSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { clearReadyMarker, touchReadyMarker } from "@/lib/jobs/ready-marker";

describe("worker ready marker", () => {
  it("is written on start, refreshed on each beat and removed at the next start", () => {
    const path = join(mkdtempSync(join(tmpdir(), "ready-")), "marker");
    clearReadyMarker(path);
    expect(existsSync(path)).toBe(false);
    touchReadyMarker(path);
    expect(readFileSync(path, "utf8")).toBe(`${process.pid}\n`);
    const old = new Date(Date.now() - 600_000);
    utimesSync(path, old, old);
    touchReadyMarker(path);
    expect(statSync(path).mtimeMs).toBeGreaterThan(old.getTime() + 500_000);
    clearReadyMarker(path);
    expect(existsSync(path)).toBe(false);
  });
});
