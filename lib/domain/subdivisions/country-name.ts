/*
 * Client-safe: no database or config imports, so client components (the Reviere panel on the map) can use it.
 */

const countryNames = new Intl.DisplayNames(["de"], { type: "region" });

/** German name of an ISO 3166-1 alpha-2 code; the code itself when the runtime does not know it. */
export function countryName(code: string): string {
  try {
    return countryNames.of(code) ?? code;
  } catch {
    return code;
  }
}
