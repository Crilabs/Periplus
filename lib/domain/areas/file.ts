import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { areaImportFileSchema } from "@/lib/config/schemas";

export type AreaFile = z.infer<typeof areaImportFileSchema>;
export type ImportedArea = AreaFile["areas"][number];

/** Validates a bot delivery file; `source` (the file name) names it in the error. */
export function parseAreaFile(json: unknown, source: string): AreaFile {
  const parsed = areaImportFileSchema.safeParse(json);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
    throw new Error(`Ungültige Revier-Datei ${source}: ${issues}`);
  }
  return parsed.data;
}

/** All `*.json` files of `dir`, sorted by file name. */
export async function loadAreaFiles(dir = "config/area-imports"): Promise<AreaFile[]> {
  const names = readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
  return names.map((name) => {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(join(dir, name), "utf8"));
    } catch (error) {
      throw new Error(`Ungültige Revier-Datei ${name}: ${(error as Error).message}`, { cause: error });
    }
    return parseAreaFile(raw, name);
  });
}
