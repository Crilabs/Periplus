import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ADMIN = path.resolve(__dirname, "..");

function pageDirs(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory()) return entry.name.startsWith("_") ? [] : pageDirs(path.join(dir, entry.name));
    return entry.name === "page.tsx" ? [dir] : [];
  });
}

// Every admin page reads the session at request time (requireAdmin). Without its own Suspense boundary below the
// shared layout, a client navigation into it blocks ("blocking-prerender-dynamic"); see _components/page-loading.tsx.
describe("admin pages", () => {
  it("each page.tsx has a loading.tsx beside it", () => {
    const dirs = pageDirs(ADMIN);
    expect(dirs.length).toBeGreaterThan(10);
    const missing = dirs.filter((dir) => !existsSync(path.join(dir, "loading.tsx"))).map((dir) => path.relative(ADMIN, dir) || ".");
    expect(missing).toEqual([]);
  });
});
