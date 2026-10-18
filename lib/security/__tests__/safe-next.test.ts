import { describe, expect, it } from "vitest";
import { safeNext } from "../safe-next";

describe("safeNext", () => {
  it.each(["/runs", "/runs/abc?x=1", "/", "/map#top"])("keeps %s", (value) => {
    expect(safeNext(value)).toBe(value);
  });

  it.each([
    null,
    undefined,
    "",
    "runs",
    "//evil.example",
    "/\\evil.example",
    "/ok\\path",
    "https://evil.example",
    "http://evil.example/x",
    "javascript:alert(1)",
    "/a\nb",
    "/a\u0000b",
    "/a\u007fb",
    "///evil.example",
  ])("falls back to / for %j", (value) => {
    expect(safeNext(value)).toBe("/");
  });
});
