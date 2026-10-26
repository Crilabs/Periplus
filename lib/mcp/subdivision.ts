import type { Db } from "@/lib/db/client";
import { requireSubdivision, SubdivisionRefused, type SubdivisionRef } from "@/lib/domain/subdivisions/store";
import { ToolError } from "./result";

/**
 * The subdivision `key` for an MCP tool, through `requireSubdivision`: an unknown key, a leftover area key (`saronic`) or
 * an excluded subdivision (unless `allowExcluded`) is a tool error with a German text, never „Interner Fehler“. A tool
 * passes `allowExcluded` only when the domain call behind it reads excluded subdivisions too.
 */
export async function toolSubdivision(db: Db, key: string, opts: { allowExcluded?: boolean } = {}): Promise<SubdivisionRef> {
  try {
    return await requireSubdivision(db, key, opts);
  } catch (e) {
    if (!(e instanceof SubdivisionRefused)) throw e;
    throw new ToolError(e.reason === "unknown" ? `Landesteil ${key} unbekannt` : e.message);
  }
}
