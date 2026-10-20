/*
 * Archive keys of place images the admin may view (spec 13): renders and candidates of the generation, approved images.
 */

const ALLOWED_KEYS = [/^imagery\/(renders|candidates)\/[0-9a-f-]{36}\/[\w.-]+$/, /^images\/places\/[0-9a-f-]{36}\/[\w.-]+$/];

const CONTENT_TYPES: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg" };

/**
 * The content type of an image file the admin route serves, by extension (PNG or JPEG); null for a key outside
 * `imagery/renders/<uuid>/`, `imagery/candidates/<uuid>/` or `images/places/<uuid>/`, a dot segment, or another type.
 */
export function imageFileContentType(key: string): string | null {
  if (!ALLOWED_KEYS.some((re) => re.test(key))) return null;
  const name = key.slice(key.lastIndexOf("/") + 1);
  if (name === "." || name === "..") return null;
  return CONTENT_TYPES[name.slice(name.lastIndexOf(".") + 1).toLowerCase()] ?? null;
}

/** The admin URL of an archived image (`/images/file?key=…`). */
export const imageFileHref = (key: string) => `/images/file?key=${encodeURIComponent(key)}`;
