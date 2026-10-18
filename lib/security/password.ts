import { hash, verify } from "@node-rs/argon2";

export const MIN_PASSWORD_LENGTH = 12;
/** Bounds Argon2 work per request; longer input is rejected before hashing. */
export const MAX_PASSWORD_LENGTH = 1024;

// OWASP-recommended argon2id parameters (19 MiB, t=2, p=1); algorithm 2 = Argon2id
// (the const enum is unusable under isolatedModules).
const OPTIONS = { algorithm: 2, memoryCost: 19456, timeCost: 2, parallelism: 1 } as const;

export async function hashPassword(password: string): Promise<string> {
  if (password.length < MIN_PASSWORD_LENGTH) throw new Error("password_too_short");
  if (password.length > MAX_PASSWORD_LENGTH) throw new Error("password_too_long");
  return hash(password, OPTIONS);
}

/** Never throws: a malformed hash or any verification error counts as a mismatch. */
export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  if (password.length > MAX_PASSWORD_LENGTH) return false;
  try {
    return await verify(passwordHash, password);
  } catch {
    return false;
  }
}
