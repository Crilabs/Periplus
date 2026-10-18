import { readFileSync } from "node:fs";
import { join } from "node:path";

export function renderPrompt(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (_m, name: string) => {
    const value = vars[name];
    if (value === undefined) throw new Error(`Missing prompt variable: ${name}`);
    return value;
  });
}

/** Loads `config/prompts/<task>/v<version>.md` and splits it into its `## system` and `## user` sections. */
export function loadPrompt(taskName: string, version: number, dir = "config/prompts"): { system: string; user: string } {
  const file = join(dir, taskName, `v${version}.md`);
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (error) {
    throw new Error(`Cannot read prompt ${file} for task ${taskName}: ${(error as Error).message}`, { cause: error });
  }
  const sections: Record<string, string> = {};
  let current: string | undefined;
  for (const line of raw.split("\n")) {
    const heading = /^##\s+(\w+)\s*$/.exec(line);
    if (heading) {
      current = heading[1]!.toLowerCase();
      sections[current] = "";
    } else if (current) {
      sections[current] += `${line}\n`;
    }
  }
  const system = sections.system?.trim();
  const user = sections.user?.trim();
  if (!system || !user) throw new Error(`Prompt ${file} for task ${taskName} needs non-empty "## system" and "## user" sections`);
  return { system, user };
}
