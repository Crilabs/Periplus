import { existsSync, readdirSync, readFileSync } from "node:fs";
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

// A thrown page or action shows the admin's own German error page inside the layout, never Next's English default (UI-7).
describe("admin error boundary", () => {
  it("app/(admin)/error.tsx is a client component in German that offers a retry", () => {
    const file = path.join(ADMIN, "error.tsx");
    expect(existsSync(file)).toBe(true);
    const source = readFileSync(file, "utf8");
    expect(source.startsWith('"use client";')).toBe(true);
    expect(source).toContain("Erneut versuchen");
    expect(source).toContain("retry()");
  });
});

// Each tab names its page (UI-15): a static `metadata` title or a `generateMetadata` (task, place, source …).
describe("admin page titles", () => {
  it("each page.tsx sets its title", () => {
    const untitled = pageDirs(ADMIN)
      .filter((dir) => !/export (const metadata|async function generateMetadata)/.test(readFileSync(path.join(dir, "page.tsx"), "utf8")))
      .map((dir) => path.relative(ADMIN, dir) || ".");
    expect(untitled).toEqual([]);
  });
});
