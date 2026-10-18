import { describe, expect, it } from "vitest";
import { hashPassword, MAX_PASSWORD_LENGTH, verifyPassword } from "../password";

describe("password", () => {
  it("hashes with argon2id and verifies", async () => {
    const hash = await hashPassword("correct horse battery");
    expect(hash.startsWith("$argon2id$")).toBe(true);
    expect(await verifyPassword(hash, "correct horse battery")).toBe(true);
    expect(await verifyPassword(hash, "wrong horse battery")).toBe(false);
  });

  it("rejects passwords shorter than 12 characters", async () => {
    await expect(hashPassword("short-pw-11")).rejects.toThrow("password_too_short");
  });

  it("returns false for a malformed hash instead of throwing", async () => {
    expect(await verifyPassword("not-a-hash", "whatever-password")).toBe(false);
  });

  it("password longer than 1024 chars is rejected without hashing", async () => {
    const long = "a".repeat(MAX_PASSWORD_LENGTH + 1);
    await expect(hashPassword(long)).rejects.toThrow("password_too_long");
    const hash = await hashPassword("a".repeat(MAX_PASSWORD_LENGTH));
    expect(await verifyPassword(hash, long)).toBe(false);
    expect(await verifyPassword("not-a-hash", long)).toBe(false);
  });
});
