import { createHash } from "node:crypto";

/** SHA-256 of the UTF-8 text as lower-case hex. */
export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * Canonical Markdown of a version (its `content_hash` is taken over this): LF line ends, no zero-width
 * characters (U+200B–U+200D, U+FEFF; removed before NFC so that the result is idempotent), NFC, no whitespace at line ends, at most one blank line in a row, exactly one final LF.
 */
export function normalizeMarkdown(md: string): string {
  return md
    .replace(/\r\n?/g, "\n")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .normalize("NFC")
    .replace(/[^\S\n]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/\n*$/, "\n");
}

/** `content_hash` of a version: SHA-256 hex of the normalized Markdown. */
export function contentHash(normalizedMd: string): string {
  return sha256Hex(normalizedMd);
}

/**
 * Comparison form of a text passage (chunk hashes here, quote checks in M4): NFC, typographic double quotes → `"`,
 * single quotes → `'`, hyphens and dashes → `-`, every whitespace run (incl. NBSP) → one space, trimmed.
 * Case and accents are kept.
 */
export function normalizeText(t: string): string {
  return t
    .normalize("NFC")
    .replace(/[„“”«»]/g, '"')
    .replace(/[‚‘’‹›]/g, "'")
    .replace(/[‐-―]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}
