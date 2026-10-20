import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/*
 * One German term per glossary entry in the admin's copy (design doc §8, gesamt review UI-14): „Highlight“, not POI;
 * „Konflikt“, not Widerspruch; „Zusammenfassung“, „Warteschlange“, „Suchanfrage“, „Ausschnitt“, „Abschnitt“,
 * „Einbettung“ instead of the English words. Comments are code (English) and left out.
 */

const ROOT = path.resolve(__dirname, "../..");
const DIRS = ["(admin)", "login"];
const BANNED: Array<[RegExp, string]> = [
  [/\bPOIs?\b/, "Highlight"],
  [/Widerspruch/, "Konflikt"],
  [/Summary neu|"Summaries"|>Summaries</, "Zusammenfassung"],
  [/\bQueue\b/, "Warteschlange"],
  [/>Query<|"Query"/, "Suchanfrage"],
  [/>Snippet<|"Snippet"/, "Ausschnitt"],
  [/\bChunks\b/, "Abschnitte"],
  [/\bEmbeddings?\b(?![-_])/, "Einbettung"],
];

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === "__tests__" ? [] : sources(p);
    return /\.(tsx?|ts)$/.test(e.name) ? [p] : [];
  });
}

/** The lines of a file without comments (block comments, `//` comments, JSDoc lines). */
function codeLines(file: string): Array<[number, string]> {
  const text = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
  return text
    .split("\n")
    .map((line, i): [number, string] => [i + 1, line.replace(/(^|\s)\/\/.*$/, "")])
    .filter(([, line]) => line.trim() !== "");
}

describe("admin copy uses the glossary's German terms", () => {
  it("no English or second term where the glossary has one", () => {
    const hits: string[] = [];
    for (const dir of DIRS) {
      for (const file of sources(path.join(ROOT, dir))) {
        for (const [n, line] of codeLines(file)) {
          for (const [pattern, term] of BANNED) {
            if (pattern.test(line)) hits.push(`${path.relative(ROOT, file)}:${n} → ${term}: ${line.trim()}`);
          }
        }
      }
    }
    expect(hits).toEqual([]);
  });
});
