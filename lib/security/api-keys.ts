import { createHash, randomBytes } from "node:crypto";

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const KEY_BODY_LENGTH = 43;

function toBase62(bytes: Buffer): string {
  let n = BigInt("0x" + bytes.toString("hex"));
  let out = "";
  while (n > 0n) {
    out = BASE62[Number(n % 62n)] + out;
    n /= 62n;
  }
  return out;
}

export function hashApiKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

/** Key `pk_` + 43 base62 chars (32 random bytes, ~256 bits). Only the SHA-256 hash is stored. */
export function generateApiKey(): { key: string; hash: string } {
  const body = toBase62(randomBytes(32)).padStart(KEY_BODY_LENGTH, "0");
  const key = `pk_${body}`;
  return { key, hash: hashApiKey(key) };
}
