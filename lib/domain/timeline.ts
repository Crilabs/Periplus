import { sql, type AnyColumn, type SQL } from "drizzle-orm";

/**
 * Row is valid on `date` (ISO `YYYY-MM-DD`, default today): `valid_from <= d and (valid_to is null or valid_to > d)`.
 * A row ending on `d` is no longer valid that day; a row starting on `d` already is. The only place of this rule.
 */
export function validAt(table: { validFrom: AnyColumn; validTo: AnyColumn }, date?: string): SQL {
  const d = date === undefined ? sql`current_date` : sql`${date}::date`;
  return sql`(${table.validFrom} <= ${d} and (${table.validTo} is null or ${table.validTo} > ${d}))`;
}
