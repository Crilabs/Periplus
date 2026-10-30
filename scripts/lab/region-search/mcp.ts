import { callMcpTool } from "../../mcp-client";

/** Read-only access to production through the MCP server (`sql`, `gate_input`); never a start or control tool. */
function options(): { url: string; token: string; timeoutMs: number } {
  const url = process.env.PERIPLUS_MCP_URL;
  const token = process.env.PERIPLUS_MCP_TOKEN;
  if (!url || !token) throw new Error("PERIPLUS_MCP_URL and PERIPLUS_MCP_TOKEN must be set (.env.local)");
  return { url, token, timeoutMs: 120_000 };
}

export async function mcpTool(name: string, args: object): Promise<unknown> {
  return callMcpTool(options(), name, args);
}

export type SqlResult = { columns: string[]; rows: unknown[][]; rowCount: number; truncated: boolean };

/** One read-only query (500 rows, 15 s on the server). */
export async function mcpSql(query: string): Promise<SqlResult> {
  const result = (await mcpTool("sql", { query })) as Partial<SqlResult>;
  if (!Array.isArray(result.columns) || !Array.isArray(result.rows)) throw new Error(`sql: unexpected answer ${JSON.stringify(result).slice(0, 200)}`);
  return { columns: result.columns, rows: result.rows, rowCount: result.rowCount ?? result.rows.length, truncated: result.truncated ?? false };
}

/** Rows as objects keyed by column name. */
export async function mcpSqlRows<T extends Record<string, unknown>>(query: string): Promise<T[]> {
  const { columns, rows } = await mcpSql(query);
  return rows.map((r) => Object.fromEntries(columns.map((c, i) => [c, r[i]])) as T);
}

/** All rows of a query, 500 at a time; `query` must not contain its own `limit`/`offset` and must have an `order by`. */
export async function mcpSqlAll<T extends Record<string, unknown>>(query: string): Promise<T[]> {
  const out: T[] = [];
  for (let offset = 0; ; offset += 500) {
    const page = await mcpSqlRows<T>(`${query} limit 500 offset ${offset}`);
    out.push(...page);
    if (page.length < 500) return out;
  }
}
