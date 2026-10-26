import { sql, type SQL } from "drizzle-orm";

/** Scheme and a leading `www.` of a normalised URL (dropped by the binding key). */
const SCHEME_WWW = "^[a-z][a-z0-9+.-]*://(www\\.)?";

/**
 * The canonical binding key of a normalised URL (final review 2): scheme dropped, a leading `www.` dropped, trailing
 * slashes dropped. `http://www.marina.gr` and `https://marina.gr/` are the same start URL; a page under either is under
 * both. Used for the shared start URL of several places (`attachPlaceWebsite`) and, in the old mention binding, `boundGeoObjectFor`.
 */
export function bindingKey(urlNormalized: string): string {
  return urlNormalized.replace(new RegExp(SCHEME_WWW, "i"), "").replace(/\/+$/, "");
}

/** `bindingKey` in SQL, of the text expression `url`. */
export function bindingKeySql(url: SQL): SQL {
  return sql`rtrim(regexp_replace(${url}, ${SCHEME_WWW}, '', 'i'), '/')`;
}
