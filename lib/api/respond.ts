import { serializeFile, sha256Hex } from "@/lib/domain/delivery/serialize";

/*
 * Responses of the delivery API (spec 08): errors as `{ error: { code, message } }` without internal details and never
 * cached; bodies with an `ETag`, `Cache-Control: private`, the schema version and the data version; all with
 * `Vary: Authorization`. Pure (no database, no environment), so `proxy.ts` answers its own denials in the same format (ruling M6-P20).
 */

export type ApiErrorStatus = 400 | 401 | 403 | 404 | 429 | 500;

/** The fixed English messages of the errors every route can answer. */
export const API_MESSAGES = {
  unauthorized: "Missing or invalid API key.",
  forbidden: "The API key lacks the required scope.",
  rate_limited: "Rate limit exceeded.",
  internal: "Internal error.",
  not_found: "Not found.",
} as const;

export function apiError(status: ApiErrorStatus, code: string, message: string, headers?: Record<string, string>): Response {
  return Response.json({ error: { code, message } }, { status, headers: { "Cache-Control": "no-store", ...VARY, ...headers } });
}

/** 404 `not_found` with the fixed message. */
export function apiNotFound(): Response {
  return apiError(404, "not_found", API_MESSAGES.not_found);
}

export type BodyMeta = {
  schemaVersion: string;
  /** `Periplus-Data-Version`; null for answers across data versions (area list, schemas). */
  dataVersion: number | null;
  /** Default `application/json`. */
  contentType?: string;
  maxAgeSeconds: number;
  /** The body's sha256 when already known (a stored package file): the ETag without hashing the bytes again. */
  sha256?: string;
};

/** `"` + the first 32 hex characters of the sha256 of the bytes + `"` (a strong validator). */
export function etagOf(bytes: Uint8Array): string {
  return etagOfSha256(sha256Hex(bytes));
}

/** The ETag of bytes whose sha256 (hex) is known. */
export function etagOfSha256(sha256: string): string {
  return `"${sha256.slice(0, 32)}"`;
}

/**
 * Every API answer depends on the `Authorization` header: a private cache must not hand one key's answer to another
 * key (security review M6-F minor 2).
 */
const VARY = { Vary: "Authorization" } as const;

/** True when an `If-None-Match` list (weak `W/` tags allowed, or `*`) names `etag`. */
function noneMatchHits(header: string | null, etag: string): boolean {
  if (header === null) return false;
  return header.split(",").some((part) => {
    const tag = part.trim();
    return tag === "*" || (tag.startsWith("W/") ? tag.slice(2) : tag) === etag;
  });
}

/**
 * A body answer: bytes unchanged, an object serialized as package files are (`serializeFile`). A matching
 * `If-None-Match` gives 304 without a body, with the same validator and cache headers.
 */
export function apiBody(req: Request, body: Uint8Array | object, meta: BodyMeta): Response {
  const bytes = body instanceof Uint8Array ? body : serializeFile(body);
  const etag = meta.sha256 === undefined ? etagOf(bytes) : etagOfSha256(meta.sha256);
  const headers: Record<string, string> = {
    ...VARY,
    ETag: etag,
    "Cache-Control": `private, max-age=${meta.maxAgeSeconds}`,
    "Periplus-Schema-Version": meta.schemaVersion,
  };
  if (meta.dataVersion !== null) headers["Periplus-Data-Version"] = String(meta.dataVersion);
  if (noneMatchHits(req.headers.get("if-none-match"), etag)) return new Response(null, { status: 304, headers });
  return new Response(new Uint8Array(bytes), {
    status: 200,
    headers: { ...headers, "Content-Type": meta.contentType ?? "application/json" },
  });
}
