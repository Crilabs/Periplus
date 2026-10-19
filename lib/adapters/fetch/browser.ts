import type { Browser } from "playwright";
import { userAgent } from "../http";
import type { RenderPage } from "./types";

/** Resource types the renderer never loads: they cost time and carry no text. */
const BLOCKED_RESOURCES = new Set(["image", "font", "media"]);
/** Longest wait for the network to go quiet after the DOM is ready (pages that poll never do). */
const NETWORK_IDLE_MS = 5_000;

export type Renderer = { render: RenderPage; close(): Promise<void> };

/**
 * Headless Chromium: one browser per renderer, launched on the first render (`playwright` is imported only
 * then), a fresh context per page with the contact User-Agent; images, fonts and media are blocked. A page
 * counts as loaded when its DOM is ready and the network was quiet (at most `NETWORK_IDLE_MS` more).
 */
export function createPlaywrightRenderer(): Renderer {
  let browser: Promise<Browser> | undefined;

  function launch(): Promise<Browser> {
    browser ??= import("playwright")
      .then(({ chromium }) => chromium.launch({ headless: true }))
      .catch((error: unknown) => {
        browser = undefined;
        throw error;
      });
    return browser;
  }

  return {
    async render(url, { timeoutMs }) {
      const context = await (await launch()).newContext({ userAgent: userAgent() });
      try {
        await context.route("**/*", (route) =>
          BLOCKED_RESOURCES.has(route.request().resourceType()) ? route.abort() : route.continue(),
        );
        const page = await context.newPage();
        const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
        // Best effort: script-loaded content usually arrives before the network goes quiet; a page that
        // keeps polling is taken as it is after the wait.
        await page.waitForLoadState("networkidle", { timeout: Math.min(NETWORK_IDLE_MS, timeoutMs) }).catch(() => undefined);
        return { html: await page.content(), finalUrl: page.url(), status: response?.status() ?? 0 };
      } finally {
        await context.close();
      }
    },
    async close() {
      const running = browser;
      browser = undefined;
      if (running) await (await running.catch(() => undefined))?.close();
    },
  };
}

let shared: Renderer | undefined;

/** The process-wide renderer (the worker's); the browser starts on the first render. */
export function getRenderer(): Renderer {
  return (shared ??= createPlaywrightRenderer());
}

/** Closes the process-wide renderer's browser, if one was started (worker shutdown). */
export async function closeRenderer(): Promise<void> {
  const running = shared;
  shared = undefined;
  await running?.close();
}
