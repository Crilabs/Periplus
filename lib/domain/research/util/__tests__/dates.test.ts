import { describe, expect, it } from "vitest";
import { firstWords, plausibleDate } from "../dates";

describe("firstWords", () => {
  it("keeps the text up to the n-th word", () => {
    expect(firstWords("# Poros\n\nWir  ankerten vor Kolona.", 3)).toBe("# Poros\n\nWir");
    expect(firstWords("kurz", 1500)).toBe("kurz");
  });
});

describe("plausibleDate", () => {
  const fetched = new Date("2026-10-19T10:00:00Z");
  it("keeps a real day between the earliest date and the fetch date", () => {
    expect(plausibleDate("2024-05-07", fetched, "1990-01-01", false)).toBe("2024-05-07");
    expect(plausibleDate("2024-02-30", fetched, "1990-01-01", false)).toBeNull();
    expect(plausibleDate("2027-01-01", fetched, "1990-01-01", false)).toBeNull();
    expect(plausibleDate("1980-01-01", fetched, "1990-01-01", false)).toBeNull();
    expect(plausibleDate(null, fetched, "1990-01-01", false)).toBeNull();
  });
  it("places a month on day 15 only when allowed, clamped to the fetch date in the fetch month", () => {
    expect(plausibleDate("2024-05", fetched, "1990-01-01", true)).toBe("2024-05-15");
    expect(plausibleDate("2024-05", fetched, "1990-01-01", false)).toBeNull();
    expect(plausibleDate("2026-10", fetched, "1990-01-01", true)).toBe("2026-10-15");
    expect(plausibleDate("2026-10", new Date("2026-10-07T00:00:00Z"), "1990-01-01", true)).toBe("2026-10-07");
  });
});
