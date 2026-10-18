import { describe, expect, it } from "vitest";
import { isPublicId, newId, newPublicId } from "@/lib/domain/ids";

describe("ids", () => {
  it("newId is a UUIDv7 and sorts by creation time", () => {
    const a = newId();
    const b = newId();
    expect(a < b).toBe(true);
    expect(a[14]).toBe("7");
  });
  it("newPublicId has prefix and 26-char ULID", () => {
    expect(newPublicId("sp")).toMatch(/^sp_[0-9A-HJKMNP-TV-Z]{26}$/);
  });
  it("isPublicId accepts the right prefix and rejects the wrong one", () => {
    expect(isPublicId(newPublicId("sp"), "sp")).toBe(true);
    expect(isPublicId(newPublicId("hl"), "sp")).toBe(false);
  });
});
