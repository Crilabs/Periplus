import type { APIResponse, Browser, Route } from "playwright";
import { userAgent } from "../http";
import { BlockedUrlError, isPublicHttpUrl } from "./ssrf";
import type { RenderPage } from "./types";

/** Resource types the renderer never loads: they cost time and carry no text. */
const BLOCKED_RESOURCES = new Set(["image", "font", "media"]);
/** Longest wait for the network to go quiet after the DOM is ready (pages that poll never do). */
const NETWORK_IDLE_MS = 5_000;

/** Redirect hops followed per request, like a browser's limit. */
const MAX_REDIRECTS = 10;

/**
 * The answer to a routed request, redirects followed hop by hop, every hop's URL checked with `isAllowed`
 * before it is requested; `null` when a hop is not allowed.
 */
async function fetchChecked(
  route: Route,
  isAllowed: (url: string) => Promise<boolean>,
  timeoutMs: number,
): Promise<{ response: APIResponse; url: string } | null> {
  let url = route.request().url();
  for (let hop = 0; ; hop++) {
    if (!(await isAllowed(url))) return null;
    // After a redirect the browser asks with GET and no body.
    const response = await route.fetch({ url, maxRedirects: 0, timeout: timeoutMs, ...(hop > 0 ? { method: "GET", postData: undefined } : {}) });
    const location = response.headers()["location"];
    if (response.status() < 300 || response.status() > 399 || !location) return { response, url };
    if (hop >= MAX_REDIRECTS) throw new Error(`more than ${MAX_REDIRECTS} redirects from ${route.request().url()}`);
    url = new URL(location, url).href;
  }
}

/** The HTML with `<base href>` set to `url`, unless it has one. */
function withBase(html: string, url: string): string {
  if (/<base\s[^>]*href/i.test(html)) return html;
  const tag = `<base href="${url.replaceAll("&", "&amp;").replaceAll('"', "&quot;")}">`;
  return /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (head) => `${head}${tag}`) : `${tag}${html}`;
}

export type Renderer = { render: RenderPage; close(): Promise<void> };

/**
 * Headless Chromium: one browser per renderer, launched on the first render (`playwright` is imported only
 * then), a fresh context per page with the contact User-Agent; images, fonts and media are blocked. A page
 * counts as loaded when its DOM is ready and the network was quiet (at most `NETWORK_IDLE_MS` more).
 *
 * Every request of the page (the page itself, each redirect hop, every sub-request) must pass `isAllowed`
 * (default: `isPublicHttpUrl`), else it is aborted; a page that is or ends on a blocked URL is a
 * `BlockedUrlError`.
 */
export function createPlaywrightRenderer(opts: { isAllowed?: (url: string) => Promise<boolean> } = {}): Renderer {
  const isAllowed = opts.isAllowed ?? ((url: string) => isPublicHttpUrl(url));
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
      if (!(await isAllowed(url))) throw new BlockedUrlError(url);
      const context = await (await launch()).newContext({ userAgent: userAgent() });
      try {
        // Chromium follows redirects without routing them again, so redirects are followed here hop by hop.
        let documentUrl: string | undefined;
        await context.route("**/*", async (route) => {
          const request = route.request();
          if (BLOCKED_RESOURCES.has(request.resourceType())) return route.abort();
          let answer;
          try {
            answer = await fetchChecked(route, isAllowed, timeoutMs);
          } catch {
            return route.abort("failed");
          }
          if (!answer) return route.abort("blockedbyclient");
          const { response, url: answerUrl } = answer;
          const isMainDocument = request.isNavigationRequest() && request.frame().parentFrame() === null;
          if (isMainDocument) documentUrl = answerUrl;
          if (answerUrl === request.url() || !isMainDocument) return route.fulfill({ response });
          // The page keeps the requested URL in the browser: a <base> makes its relative links resolve
          // against the URL the content came from.
          const headers = { ...response.headers() };
          delete headers["content-length"];
          delete headers["content-encoding"];
          return route.fulfill({ status: response.status(), headers, body: withBase(await response.text(), answerUrl) });
        });
        const page = await context.newPage();
        let response;
        try {
          response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
        } catch (error) {
          // A redirect hop to a blocked address aborts the navigation.
          if ((error as Error).message.includes("ERR_BLOCKED_BY_CLIENT")) throw new BlockedUrlError(url);
          throw error;
        }
        // Best effort: script-loaded content usually arrives before the network goes quiet; a page that
        // keeps polling is taken as it is after the wait.
        await page.waitForLoadState("networkidle", { timeout: Math.min(NETWORK_IDLE_MS, timeoutMs) }).catch(() => undefined);
        const finalUrl = documentUrl ?? page.url();
        if (!(await isAllowed(finalUrl))) throw new BlockedUrlError(finalUrl);
        return { html: await page.content(), finalUrl, status: response?.status() ?? 0 };
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
