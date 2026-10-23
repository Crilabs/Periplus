import { sql } from "drizzle-orm";
import { HIGHLIGHT_CATEGORIES } from "@/lib/db/schema/geo";

/**
 * `o.category in (…)` over the highlight categories. POIs of the landside categories (`bakery`, `transport`,
 * `landing`, plan N4a) feed the berth state only and are never highlights, highlight inputs or deliveries.
 */
export function inHighlightCategories(column: ReturnType<typeof sql.raw>) {
  return sql`${column} in (${sql.join(HIGHLIGHT_CATEGORIES.map((c) => sql`${c}`), sql`, `)})`;
}
