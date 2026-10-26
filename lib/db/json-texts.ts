import { sql } from "drizzle-orm";

/** `values` as a subquery of text rows, sent as one JSON parameter (no parameter limit for long lists). */
export function jsonTexts(values: readonly string[]) {
  return sql`(select value from jsonb_array_elements_text(${JSON.stringify(values)}::jsonb))`;
}
