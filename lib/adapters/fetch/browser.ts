import type { Browser, BrowserContext, LaunchOptions, Request } from "playwright";
import type { Dispatcher } from "undici";
import { getConfig } from "@/lib/config";
import { readBodyCapped, userAgent } from "../http";
import { blockedCause, getGuardedAgent, guardedFetch } from "./guarded";
import { BlockedUrlError, isPublicHttpUrl } from "./ssrf";
import type { RenderPage } from "./types";

/** Resource types the renderer never loads: they cost time and carry no text. */
const BLOCKED_RESOURCES = new Set(["image", "font", "media"]);
/** Longest wait for the network to go quiet after the DOM is ready (pages that poll never do). */
const NETWORK_IDLE_MS = 5_000;

/** Redirect hops followed per request, like a browser's limit. */
const MAX_REDIRECTS = 10;

/** Headers the browser sends that a fetch sets itself or must not forward. */
const UNFORWARDED_REQUEST_HEADERS = new Set(["host", "connection", "content-length", "keep-alive", "transfer-encoding", "upgrade"]);
/** Headers of an answer that no longer describe the body handed to the browser (fetch decoded it). */
const UNFORWARDED_RESPONSE_HEADERS = new Set(["content-encoding", "content-length", "transfer-encoding", "connection"]);

/**
 * A proxy nobody listens on. Everything the route guard does not intercept (WebRTC TURN over TCP, WebSockets of
 * dedicated workers) goes to this proxy and fails; routed requests are fulfilled before any proxy is asked.
 */
export const DEAD_PROXY = "http://127.0.0.1:9";

/**
 * Chromium launch options: headless; every connection the browser would make itself goes to `DEAD_PROXY` (loopback
 * included); WebRTC may not use UDP outside the proxy, so STUN and TURN over UDP never leave either.
 */
export function chromiumLaunchOptions(): LaunchOptions {
  return {
    headless: true,
    proxy: { server: DEAD_PROXY, bypass: "<-loopback>" },
    args: ["--force-webrtc-ip-handling-policy=disable_non_proxied_udp"],
  };
}

/** An answer larger than the renderer's per-request cap: the request is aborted. */
export class AnswerTooLarge extends Error {
  constructor(url: string, max: number) {
    super(`answer of ${url} exceeds ${max} bytes`);
    this.name = "AnswerTooLarge";
  }
}

export type FetchedAnswer = { status: number; headers: Record<string, string>; body: Buffer; url: string };

export type OutgoingRequest = { url: string; method: string; headers: Record<string, string>; body: Buffer | null };

/**
 * Fetches a request through `dispatcher` with redirects followed hop by hop, every hop's URL checked with
 * `isAllowed` before it is requested; `null` when a hop is not allowed. 301/302 turn a POST into a GET and 303
 * every method but HEAD; 307/308 keep method and body; a hop to another origin drops `cookie` and `authorization`.
 * The body is read up to `maxBodyBytes` (more is `AnswerTooLarge`). The answer's headers lose those that described
 * the encoded body (fetch decodes it).
 */
export async function fetchFollowingRedirects(
  request: OutgoingRequest,
  isAllowed: (url: string) => Promise<boolean>,
  dispatcher: Dispatcher,
  timeoutMs: number,
  maxBodyBytes: number = getConfig().fetch.maxRawBytes,
): Promise<FetchedAnswer | null> {
  let { url, method, body } = request;
  const headers = { ...request.headers };
  for (let hop = 0; ; hop++) {
    if (!(await isAllowed(url))) return null;
    const res = await guardedFetch(url, {
      method,
      headers,
      body: method === "GET" || method === "HEAD" ? undefined : (body ?? undefined),
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
      dispatcher,
    });
    const location = res.headers.get("location");
    if (res.status < 300 || res.status > 399 || !location) {
      const answerHeaders: Record<string, string> = {};
      for (const [name, value] of res.headers) if (!UNFORWARDED_RESPONSE_HEADERS.has(name)) answerHeaders[name] = value;
      const { body: answer, truncated } = await readBodyCapped(res.body as ReadableStream<Uint8Array> | null, maxBodyBytes);
      if (truncated) throw new AnswerTooLarge(url, maxBodyBytes);
      return { status: res.status, headers: answerHeaders, body: Buffer.from(answer), url };
    }
    await res.body?.cancel();
    if (hop >= MAX_REDIRECTS) throw new Error(`more than ${MAX_REDIRECTS} redirects from ${request.url}`);
    if ((res.status === 303 && method !== "HEAD") || ((res.status === 301 || res.status === 302) && method === "POST")) {
      method = "GET";
      body = null;
      delete headers["content-type"];
    }
    const next = new URL(location, url);
    if (next.origin !== new URL(url).origin) {
      for (const name of Object.keys(headers)) {
        if (name.toLowerCase() === "cookie" || name.toLowerCase() === "authorization") delete headers[name];
      }
    }
    url = next.href;
  }
}

/** A routed browser request as Periplus sends it: the browser's headers minus hop-by-hop ones, our User-Agent. */
async function outgoing(request: Request): Promise<OutgoingRequest> {
  const headers = Object.fromEntries(
    Object.entries(await request.allHeaders()).filter(([name]) => !UNFORWARDED_REQUEST_HEADERS.has(name.toLowerCase()) && !name.startsWith(":")),
  );
  headers["user-agent"] = userAgent();
  return { url: request.url(), method: request.method(), headers, body: request.postDataBuffer() };
}

/** The HTML with `<base href>` set to `url`, unless it has one. */
function withBase(html: string, url: string): string {
  if (/<base\s[^>]*href/i.test(html)) return html;
  const tag = `<base href="${url.replaceAll("&", "&amp;").replaceAll('"', "&quot;")}">`;
  return /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (head) => `${head}${tag}`) : `${tag}${html}`;
}

export type Renderer = { render: RenderPage; close(): Promise<void> };

export type RendererOptions = {
  /** URL check before every request and hop (default `isPublicHttpUrl`). */
  isAllowed?: (url: string) => Promise<boolean>;
  /** Dispatcher of the renderer's own fetches (default: the process-wide guarded agent). */
  dispatcher?: Dispatcher;
  /** Starts the browser (default: Chromium via a lazy `import("playwright")` with `chromiumLaunchOptions`). */
  launchBrowser?: () => Promise<Browser>;
};

async function launchChromium(): Promise<Browser> {
  const { chromium } = await import("playwright");
  return chromium.launch(chromiumLaunchOptions());
}

/** Closes the context after dropping its routes, so a late route callback finds no handler instead of a closed context. */
async function closeContext(context: BrowserContext): Promise<void> {
  await context.unrouteAll({ behavior: "ignoreErrors" });
  await context.close();
}

/**
 * Headless Chromium: one browser per renderer, launched on the first render and again after it crashed or was
 * closed; a fresh context per page with the contact User-Agent and service workers blocked; images, fonts and
 * media are blocked, WebSockets closed. A page counts as loaded when its DOM is ready and the network was quiet
 * (at most `NETWORK_IDLE_MS` more).
 *
 * The browser itself requests nothing: every request of the page (the page itself, each redirect hop, every
 * sub-request) is fetched by Periplus through the guarded dispatcher after passing `isAllowed`, else aborted, and
 * handed to the browser with `route.fulfill`. A page that is or ends on a blocked URL is a `BlockedUrlError`.
 */
export function createPlaywrightRenderer(opts: RendererOptions = {}): Renderer {
  const isAllowed = opts.isAllowed ?? ((url: string) => isPublicHttpUrl(url));
  const launchBrowser = opts.launchBrowser ?? launchChromium;
  let browser: Promise<Browser> | undefined;

  function launch(): Promise<Browser> {
    if (browser) return browser;
    const launching: Promise<Browser> = launchBrowser().then(
      (b) => {
        // A crashed or closed browser is launched again on the next render.
        b.on("disconnected", () => {
          if (browser === launching) browser = undefined;
        });
        return b;
      },
      (error: unknown) => {
        if (browser === launching) browser = undefined;
        throw error;
      },
    );
    browser = launching;
    return launching;
  }

  async function connectedBrowser(): Promise<Browser> {
    const current = launch();
    const b = await current;
    if (b.isConnected()) return b;
    if (browser === current) browser = undefined;
    return launch();
  }

  return {
    async render(url, { timeoutMs }) {
      if (!(await isAllowed(url))) throw new BlockedUrlError(url);
      const dispatcher = opts.dispatcher ?? getGuardedAgent();
      const context = await (await connectedBrowser()).newContext({ userAgent: userAgent(), serviceWorkers: "block" });
      try {
        await context.routeWebSocket("**/*", (ws) => ws.close());
        let documentUrl: string | undefined;
        await context.route("**/*", async (route) => {
          const request = route.request();
          if (BLOCKED_RESOURCES.has(request.resourceType())) return route.abort();
          let answer: FetchedAnswer | null;
          try {
            answer = await fetchFollowingRedirects(await outgoing(request), isAllowed, dispatcher, timeoutMs);
          } catch (error) {
            return route.abort(blockedCause(error) ? "blockedbyclient" : "failed");
          }
          if (!answer) return route.abort("blockedbyclient");
          const isMainDocument = request.isNavigationRequest() && request.frame().parentFrame() === null;
          if (isMainDocument) documentUrl = answer.url;
          if (answer.url === request.url() || !isMainDocument) {
            return route.fulfill({ status: answer.status, headers: answer.headers, body: answer.body });
          }
          // The page keeps the requested URL in the browser: a <base> makes its relative links resolve
          // against the URL the content came from.
          return route.fulfill({ status: answer.status, headers: answer.headers, body: withBase(answer.body.toString("utf8"), answer.url) });
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
        await closeContext(context);
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
