import { sql } from "drizzle-orm";

/** `values` as a subquery of uuid rows, sent as one JSON parameter (no parameter limit for long lists). */
export function jsonUuids(values: readonly string[]) {
  return sql`(select value::uuid from jsonb_array_elements_text(${JSON.stringify(values)}::jsonb))`;
}
