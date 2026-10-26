import { sql, type AnyColumn, type SQL } from "drizzle-orm";

/**
 * Row is valid on `date` (ISO `YYYY-MM-DD`, default today): `valid_from <= d and (valid_to is null or valid_to > d)`.
 * A row ending on `d` is no longer valid that day; a row starting on `d` already is. The only place of this rule.
 */
export function validAt(table: { validFrom: AnyColumn; validTo: AnyColumn }, date?: string | SQL): SQL {
  const d = dateSql(date);
  return sql`(${table.validFrom} <= ${d} and (${table.validTo} is null or ${table.validTo} > ${d}))`;
}

/** `validAt` for a raw-SQL table alias (`validAtAlias("o", today)` → `o.valid_from <= … and (o.valid_to …)`). */
export function validAtAlias(alias: string, date?: string | SQL): SQL {
  if (!/^[a-z_][a-z0-9_]*$/.test(alias)) throw new Error(`not a table alias: ${alias}`);
  const a = sql.raw(alias);
  const d = dateSql(date);
  return sql`(${a}.valid_from <= ${d} and (${a}.valid_to is null or ${a}.valid_to > ${d}))`;
}

/** A date (`YYYY-MM-DD`) or an SQL date expression; by default the database's `current_date`. */
function dateSql(date: string | SQL | undefined): SQL {
  if (date === undefined) return sql`current_date`;
  return typeof date === "string" ? sql`${date}::date` : date;
}
