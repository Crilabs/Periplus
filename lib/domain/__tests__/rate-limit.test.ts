import { describe, expect, it } from "vitest";
import { testDb } from "@/test/db";
import { newId } from "@/lib/domain/ids";
import { takeToken } from "@/lib/domain/rate-limit";

const db = testDb();

describe("takeToken", () => {
  it("allows ratePerMinute calls then returns retryAfterMs > 0", async () => {
    const key = `t:${newId()}`;
    const now = new Date("2030-01-01T00:00:00Z");
    for (let i = 0; i < 3; i++) expect(await takeToken(db, key, 3, now)).toEqual({ ok: true });
    const res = await takeToken(db, key, 3, now);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.retryAfterMs).toBeGreaterThan(0);
  });

  it("refills over time", async () => {
    const key = `t:${newId()}`;
    const now = new Date("2030-01-01T00:00:00Z");
    for (let i = 0; i < 3; i++) await takeToken(db, key, 3, now);
    expect((await takeToken(db, key, 3, now)).ok).toBe(false);
    const later = new Date(now.getTime() + 20_000);
    expect(await takeToken(db, key, 3, later)).toEqual({ ok: true });
    expect((await takeToken(db, key, 3, later)).ok).toBe(false);
  });

  it("never grants more than capacity under concurrency", async () => {
    const key = `t:${newId()}`;
    const now = new Date("2030-01-01T00:00:00Z");
    const results = await Promise.all(Array.from({ length: 10 }, () => takeToken(db, key, 4, now)));
    expect(results.filter((r) => r.ok)).toHaveLength(4);
  });

  it("a burst of 1 spaces the calls: 60 per minute is one per second, even after a long pause", async () => {
    const key = `t:${newId()}`;
    const now = new Date("2030-01-01T00:00:00Z");
    expect(await takeToken(db, key, 60, now, 1)).toEqual({ ok: true });
    const next = await takeToken(db, key, 60, now, 1);
    expect(next).toEqual({ ok: false, retryAfterMs: 1000 });
    const idle = new Date(now.getTime() + 600_000);
    expect(await takeToken(db, key, 60, idle, 1)).toEqual({ ok: true });
    expect((await takeToken(db, key, 60, idle, 1)).ok).toBe(false);
  });
});
