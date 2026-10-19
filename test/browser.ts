import { existsSync } from "node:fs";
import { chromium } from "playwright";

/** Whether Playwright's Chromium is installed here (`npx playwright install chromium`); tests needing it skip otherwise. */
export function chromiumInstalled(): boolean {
  try {
    return existsSync(chromium.executablePath());
  } catch {
    return false;
  }
}
