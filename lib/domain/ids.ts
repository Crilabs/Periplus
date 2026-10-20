import { ulid } from "ulid";
import { v7 } from "uuid";

export type PublicIdPrefix = "sp" | "hl" | "rg" | "ar" | "sd";

/** UUIDv7: time-ordered primary key. */
export function newId(): string {
  return v7();
}

export function newPublicId(prefix: PublicIdPrefix): string {
  return `${prefix}_${ulid()}`;
}

export function isPublicId(value: string, prefix: PublicIdPrefix): boolean {
  return new RegExp(`^${prefix}_[0-9A-HJKMNP-TV-Z]{26}$`).test(value);
}
