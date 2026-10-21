import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it, vi } from "vitest";
import { createFirecrawlConverter } from "@/lib/adapters/fetch/firecrawl";
import { createConverters, resolveConverter } from "@/lib/adapters/fetch/index";
import { createJinaConverter } from "@/lib/adapters/fetch/jina";
import { createLocalConverter, htmlToMarkdown } from "@/lib/adapters/fetch/local";
import { createServer } from "node:http";
import { createServer as createTcpServer } from "node:net";
import type { AddressInfo } from "node:net";
import type { Browser } from "playwright";
import {
  AnswerTooLarge,
  chromiumLaunchOptions,
  closeRenderer,
  createPlaywrightRenderer,
  fetchFollowingRedirects,
  getRenderer,
} from "@/lib/adapters/fetch/browser";
import { BlockedAddressError, blockedCause, createGuardedAgent } from "@/lib/adapters/fetch/guarded";
import { BlockedUrlError } from "@/lib/adapters/fetch/ssrf";
import { ConverterServiceError, TargetHttpError, type RenderPage } from "@/lib/adapters/fetch/types";
import { HttpError, makeResponse, RetryableHttpError, type HttpRequest, type Transport } from "@/lib/adapters/http";
import { fixtureTransport } from "@/lib/adapters/http-fixtures";
import { getConfig, type FetchConfig } from "@/lib/config";
import { DEFAULT_CRAWL_RULES } from "@/lib/domain/sources/crawl-rules";
import { externalCalls } from "@/lib/db/schema";
import { BudgetExceeded, recordExternalCall } from "@/lib/domain/costs";
import { newId } from "@/lib/domain/ids";
import { testDb, withRollback } from "@/test/db";
import { chromiumInstalled } from "@/test/browser";
import { startSiteServer } from "@/test/site-server";

const boilerplateHtml = readFileSync("test/fixtures/html/boilerplate.html", "utf8");
const db = testDb();
const cfg = (): FetchConfig => getConfig().fetch;
/** First of the pilot URLs recorded with `fixtures:record -- --converters`. */
const PILOT_URL = "https://en.wikivoyage.org/wiki/Aegina";

const shortHtml = `<!doctype html><html><head><title>Kurz</title></head><body><div id="app">Lädt …</div></body></html>`;
const longText = "Der Ankerplatz liegt geschützt in einer tiefen Bucht mit Sandgrund und guter Haltekraft. ".repeat(12);
const renderedHtml = `<!doctype html><html><head><title>Lang</title></head><body><article><h1>Lang</h1><p>${longText}</p></article></body></html>`;

function fakeRenderer(html = renderedHtml): RenderPage & { calls: string[] } {
  const calls: string[] = [];
  const render = async (url: string) => {
    calls.push(url);
    return { html, finalUrl: url, status: 200 };
  };
  return Object.assign(render, { calls });
}

const input = (over: Partial<Parameters<ReturnType<typeof createLocalConverter>["convert"]>[0]> = {}) => ({
  url: "https://x.test.invalid/a",
  html: shortHtml,
  boilerplateSelectors: [],
  render: "auto" as const,
  ...over,
});

describe("htmlToMarkdown", () => {
  it("htmlToMarkdown keeps the table and drops boilerplate", () => {
    const r = htmlToMarkdown(boilerplateHtml, "https://x.gr/a", [".cookie-banner"]);
    expect(r.markdown).toContain("| Tiefe | Plätze |");
    expect(r.markdown).not.toMatch(/Cookie|Newsletter/);
    expect(r.markdown).toMatch(/^# Ankern vor Perdika/m);
    expect(r.markdown).toMatch(/^## Tiefen und Plätze$/m);
    expect(r.markdown).toContain("```\nN 37°41.3' E 023°27.5'\n```");
    expect(r.markdown).not.toMatch(/analytics|JavaScript aktivieren|maps\.example/);
    expect(r.title).toBe("Ankern vor Perdika");
    expect(r.mainChars).toBeGreaterThan(400);
  });

  it("resolves relative links against the page url", () => {
    const html = `<html><head><title>T</title></head><body><article><p>${longText} <a href="/b">weiter</a></p></article></body></html>`;
    expect(htmlToMarkdown(html, "https://x.gr/a/c", []).markdown).toContain("[weiter](https://x.gr/b)");
  });

  it("an invalid boilerplate selector is an error naming the selector", () => {
    expect(() => htmlToMarkdown(boilerplateHtml, "https://x.gr/a", ["div[["])).toThrow(/div\[\[/);
  });
});

describe("local converter", () => {
  it("auto renders once when the main text has fewer than 500 characters", async () => {
    const renderPage = fakeRenderer();
    const converter = createLocalConverter({ renderPage, cfg: cfg() });
    await withRollback(async (tx) => {
      const r = await converter.convert(input(), { db: tx });
      expect(renderPage.calls).toEqual(["https://x.test.invalid/a"]);
      expect(r.rendered).toBe(true);
      expect(r.markdown).toContain("Ankerplatz liegt geschützt");
      expect(r.costEur).toBe(0);
    });
  });

  it("auto does not render a page with enough main text", async () => {
    const renderPage = fakeRenderer();
    const r = await createLocalConverter({ renderPage, cfg: cfg() }).convert(input({ html: renderedHtml }), { db });
    expect(renderPage.calls).toEqual([]);
    expect(r.rendered).toBe(false);
  });

  it("never does not render", async () => {
    const renderPage = fakeRenderer();
    const r = await createLocalConverter({ renderPage, cfg: cfg() }).convert(input({ render: "never" }), { db });
    expect(renderPage.calls).toEqual([]);
    expect(r.rendered).toBe(false);
    expect(r.title).toBe("Kurz");
  });

  it("always renders even a long page", async () => {
    const renderPage = fakeRenderer();
    await withRollback(async (tx) => {
      const r = await createLocalConverter({ renderPage, cfg: cfg() }).convert(input({ html: renderedHtml, render: "always" }), { db: tx });
      expect(renderPage.calls).toHaveLength(1);
      expect(r.rendered).toBe(true);
    });
  });

  it("without a renderer it never renders", async () => {
    const r = await createLocalConverter({ cfg: cfg() }).convert(input({ render: "always" }), { db });
    expect(r.rendered).toBe(false);
    expect(r.title).toBe("Kurz");
  });

  it("records a render as a free external call", async () => {
    const renderPage = fakeRenderer();
    await withRollback(async (tx) => {
      const stage = `render-${newId()}`;
      await createLocalConverter({ renderPage, cfg: cfg() }).convert(input(), { db: tx, stage });
      const rows = await tx.select().from(externalCalls).where(eq(externalCalls.stage, stage));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ service: "playwright", operation: "render", unit: "request" });
      expect(Number(rows[0]!.costEur)).toBe(0);
    });
  });

  it("a render draws a token from the domain's rate bucket", async () => {
    const renderPage = fakeRenderer();
    const converter = createLocalConverter({ renderPage, cfg: cfg() });
    await withRollback(async (tx) => {
      const rate = { key: `domain:${newId()}.test.invalid`, perMinute: 1, maxWaitMs: 0 };
      await converter.convert(input({ rate }), { db: tx });
      // The bucket is empty now: the next render of the domain must wait, and may not wait here.
      await expect(converter.convert(input({ rate }), { db: tx })).rejects.toBeInstanceOf(RetryableHttpError);
      expect(renderPage.calls).toHaveLength(1);
      // Without rendering no token is needed.
      await converter.convert(input({ rate, render: "never" }), { db: tx });
    });
  });
});

describe("jina converter", () => {
  it("jina returns markdown and records its token cost", async () => {
    await withRollback(async (tx) => {
      const stage = `jina-${newId()}`;
      const r = await createJinaConverter(fixtureTransport(), cfg().jina).convert(
        { url: PILOT_URL, html: null, boilerplateSelectors: [], render: "auto" },
        { db: tx, stage },
      );
      expect(r.markdown).toContain("Aegina");
      expect(r.title).toMatch(/Aegina/);
      expect(r.rendered).toBe(false);
      const rows = await tx.select().from(externalCalls).where(eq(externalCalls.stage, stage));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ service: "jina", unit: "tokens" });
      expect(Number(rows[0]!.costEur)).toBeGreaterThan(0);
      expect(r.costEur).toBeCloseTo(Number(rows[0]!.costEur), 6);
    });
  });

  it("sends the key, markdown format and the boilerplate selectors", async () => {
    const requests: HttpRequest[] = [];
    const transport: Transport = async (req) => {
      requests.push(req);
      const body = { code: 200, data: { title: "T", content: "# T\n\nText", publishedTime: "2024-01-01", usage: { tokens: 1000 } } };
      return makeResponse(200, new TextEncoder().encode(JSON.stringify(body)));
    };
    await withRollback(async (tx) => {
      const r = await createJinaConverter(transport, cfg().jina).convert(
        { url: "https://x.test.invalid/a?b=1", html: null, boilerplateSelectors: [".nav", "#footer"], render: "auto" },
        { db: tx },
      );
      expect(r).toMatchObject({ markdown: "# T\n\nText", title: "T", publishedHint: "2024-01-01" });
      expect(r.costEur).toBeCloseTo((1000 * cfg().jina.eurPerMTok) / 1e6, 10);
    });
    expect(requests[0]!.url).toBe(`${cfg().jina.endpoint}https://x.test.invalid/a?b=1`);
    expect(requests[0]!.headers).toMatchObject({
      Authorization: "Bearer test-jina-key",
      Accept: "application/json",
      "X-Return-Format": "markdown",
      "X-Remove-Selector": ".nav, #footer",
    });
    expect(requests[0]!.budget).toBe("jina");
  });

  it("a target status Jina reports is a TargetHttpError for 4xx and retryable for 5xx; Jina's own 4xx is a service error", async () => {
    const answering = (data: Record<string, unknown>): Transport => async () =>
      makeResponse(200, new TextEncoder().encode(JSON.stringify({ code: 200, data: { content: "", usage: { tokens: 10 }, ...data } })));
    const target = { url: "https://x.test.invalid/gone", html: null, boilerplateSelectors: [], render: "auto" as const };
    await withRollback(async (tx) => {
      const gone = await createJinaConverter(answering({ httpStatus: 404 }), cfg().jina).convert(target, { db: tx }).catch((e: unknown) => e);
      expect(gone).toBeInstanceOf(TargetHttpError);
      expect((gone as HttpError).status).toBe(404);
      await expect(createJinaConverter(answering({ httpStatus: 503 }), cfg().jina).convert(target, { db: tx })).rejects.toBeInstanceOf(
        RetryableHttpError,
      );
      const coded: Transport = async () => makeResponse(200, new TextEncoder().encode(JSON.stringify({ code: 422, data: null })));
      await expect(createJinaConverter(coded, cfg().jina).convert(target, { db: tx })).rejects.toBeInstanceOf(TargetHttpError);
      for (const status of [401, 402, 403]) {
        const refused: Transport = async () => makeResponse(status, new TextEncoder().encode(JSON.stringify({ code: status, message: "no" })));
        const err = await createJinaConverter(refused, cfg().jina).convert(target, { db: tx }).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(ConverterServiceError);
        expect(err).not.toBeInstanceOf(HttpError);
      }
    });
  });

  it("jina and firecrawl refuse a non-public target before any request", async () => {
    const transport = vi.fn<Transport>();
    const target = { url: "http://169.254.169.254/latest/meta-data/", html: null, boilerplateSelectors: [], render: "auto" as const };
    await expect(createJinaConverter(transport, cfg().jina).convert(target, { db })).rejects.toBeInstanceOf(BlockedUrlError);
    await expect(createFirecrawlConverter(transport, cfg().firecrawl).convert(target, { db })).rejects.toBeInstanceOf(BlockedUrlError);
    expect(transport).not.toHaveBeenCalled();
  });

  it("an exhausted jina budget throws before any request", async () => {
    const transport = vi.fn<Transport>();
    await withRollback(async (tx) => {
      await recordExternalCall(tx, { service: "jina", operation: "seed", units: 1, unit: "tokens", costEur: 10_000 });
      const err = await createJinaConverter(transport, cfg().jina)
        .convert({ url: PILOT_URL, html: null, boilerplateSelectors: [], render: "auto" }, { db: tx })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(BudgetExceeded);
    });
    expect(transport).not.toHaveBeenCalled();
  });
});

describe("firecrawl converter", () => {
  it("firecrawl returns markdown and records credits", async () => {
    await withRollback(async (tx) => {
      const stage = `firecrawl-${newId()}`;
      const r = await createFirecrawlConverter(fixtureTransport(), cfg().firecrawl).convert(
        { url: PILOT_URL, html: null, boilerplateSelectors: [], render: "auto" },
        { db: tx, stage },
      );
      expect(r.markdown).toContain("Aegina");
      const rows = await tx.select().from(externalCalls).where(eq(externalCalls.stage, stage));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ service: "firecrawl", unit: "credits" });
      expect(Number(rows[0]!.units)).toBeGreaterThanOrEqual(1);
      expect(Number(rows[0]!.costEur)).toBeCloseTo(Number(rows[0]!.units) * cfg().firecrawl.eurPerCredit, 6);
      expect(r.costEur).toBeCloseTo(Number(rows[0]!.costEur), 6);
    });
  });

  it("success false and Firecrawl's own 4xx are service errors, a target 4xx is a TargetHttpError", async () => {
    const transport: Transport = async () =>
      makeResponse(200, new TextEncoder().encode(JSON.stringify({ success: false, error: "blocked" })));
    await withRollback(async (tx) => {
      const err = await createFirecrawlConverter(transport, cfg().firecrawl)
        .convert({ url: "https://x.test.invalid/a", html: null, boilerplateSelectors: [], render: "auto" }, { db: tx })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ConverterServiceError);
      expect(err).not.toBeInstanceOf(HttpError);
      expect((err as Error).message).toMatch(/blocked/);
      const target = { url: "https://x.test.invalid/a", html: null, boilerplateSelectors: [], render: "auto" as const };
      const noCredit: Transport = async () => makeResponse(402, new TextEncoder().encode(JSON.stringify({ success: false, error: "credits" })));
      await expect(createFirecrawlConverter(noCredit, cfg().firecrawl).convert(target, { db: tx })).rejects.toBeInstanceOf(ConverterServiceError);
      const gone: Transport = async () =>
        makeResponse(200, new TextEncoder().encode(JSON.stringify({ success: true, data: { markdown: "", metadata: { statusCode: 404 } } })));
      await expect(createFirecrawlConverter(gone, cfg().firecrawl).convert(target, { db: tx })).rejects.toBeInstanceOf(TargetHttpError);
    });
  });

  it("posts main-content markdown with the boilerplate selectors as excluded tags", async () => {
    const requests: HttpRequest[] = [];
    const transport: Transport = async (req) => {
      requests.push(req);
      const body = { success: true, data: { markdown: "Text", metadata: { title: "T", creditsUsed: 2, statusCode: 200 } } };
      return makeResponse(200, new TextEncoder().encode(JSON.stringify(body)));
    };
    await withRollback(async (tx) => {
      const r = await createFirecrawlConverter(transport, cfg().firecrawl).convert(
        { url: "https://x.test.invalid/a", html: null, boilerplateSelectors: [".nav"], render: "auto" },
        { db: tx },
      );
      expect(r.costEur).toBeCloseTo(2 * cfg().firecrawl.eurPerCredit, 10);
      expect(r.title).toBe("T");
    });
    expect(JSON.parse(String(requests[0]!.body))).toEqual({
      url: "https://x.test.invalid/a",
      formats: ["markdown"],
      onlyMainContent: true,
      excludeTags: [".nav"],
    });
    expect(requests[0]!.method).toBe("POST");
    expect(requests[0]!.headers?.Authorization).toBe("Bearer test-firecrawl-key");
  });
});

describe("resolveConverter", () => {
  it("resolveConverter prefers the rule, then the per-source decision, then the default", () => {
    const base: FetchConfig = { ...cfg(), defaultConverter: "local", converterBySource: { "boat.example": "jina" } };
    expect(resolveConverter({ ...DEFAULT_CRAWL_RULES, converter: "firecrawl" }, "boat.example", base)).toBe("firecrawl");
    expect(resolveConverter(DEFAULT_CRAWL_RULES, "boat.example", base)).toBe("jina");
    expect(resolveConverter(DEFAULT_CRAWL_RULES, "other.example", base)).toBe("local");
  });

  it("createConverters builds all three", () => {
    const converters = createConverters({ transport: fixtureTransport(), cfg: cfg() });
    expect(Object.keys(converters).sort()).toEqual(["firecrawl", "jina", "local"]);
    expect(converters.local.name).toBe("local");
  });
});

describe("playwright renderer", () => {
  // The site server listens on 127.0.0.1, which the default guard blocks: these tests block "/secret" instead and
  // connect through an agent that allows every address.
  const openAgent = createGuardedAgent({ isAllowedAddress: () => true });
  const renderer = createPlaywrightRenderer({
    isAllowed: async (url) => !new URL(url).pathname.startsWith("/secret"),
    dispatcher: openAgent,
  });
  afterAll(async () => {
    await renderer.close();
    await openAgent.close();
  });

  it("refuses a non-public address before starting a browser", async () => {
    const guarded = createPlaywrightRenderer();
    await expect(guarded.render("http://169.254.169.254/latest/meta-data/", { timeoutMs: 1000 })).rejects.toBeInstanceOf(BlockedUrlError);
    await expect(guarded.render("file:///etc/passwd", { timeoutMs: 1000 })).rejects.toBeInstanceOf(BlockedUrlError);
    await guarded.close();
  });

  it.skipIf(!chromiumInstalled())("a redirect hop to a blocked address is never requested", async () => {
    const site = await startSiteServer();
    try {
      site.set("/hop", { status: 302, body: "", headers: { location: "/secret" } });
      site.set("/secret", { body: "<p>intern</p>", headers: { "content-type": "text/html" } });
      site.set("/page", {
        body: `<!doctype html><html><body><p>Seite</p><script>fetch("/secret-api").catch(() => {});</script></body></html>`,
        headers: { "content-type": "text/html" },
      });
      await expect(renderer.render(`${site.origin}/hop`, { timeoutMs: 15_000 })).rejects.toBeInstanceOf(BlockedUrlError);
      const r = await renderer.render(`${site.origin}/page`, { timeoutMs: 15_000 });
      expect(r.html).toContain("<p>Seite</p>");
      expect(site.requests.map((q) => q.path)).toEqual(["/hop", "/page"]);
    } finally {
      await site.close();
    }
  }, 60_000);

  it.skipIf(!chromiumInstalled())("follows an allowed redirect", async () => {
    const site = await startSiteServer();
    try {
      site.set("/old", { status: 301, body: "", headers: { location: "/new" } });
      site.set("/new", { body: "<!doctype html><html><body><p>Neu</p></body></html>", headers: { "content-type": "text/html" } });
      const r = await renderer.render(`${site.origin}/old`, { timeoutMs: 15_000 });
      expect(r.finalUrl).toBe(`${site.origin}/new`);
      expect(r.html).toContain("<p>Neu</p>");
    } finally {
      await site.close();
    }
  }, 60_000);

  it("chromium is launched behind a dead proxy (loopback included) and without non-proxied WebRTC UDP", () => {
    expect(chromiumLaunchOptions()).toEqual({
      headless: true,
      proxy: { server: "http://127.0.0.1:9", bypass: "<-loopback>" },
      args: ["--force-webrtc-ip-handling-policy=disable_non_proxied_udp"],
    });
  });

  it.skipIf(!chromiumInstalled())("TURN over TCP and a worker's websocket open no connection past the route guard", async () => {
    const site = await startSiteServer();
    let connections = 0;
    const victim = createTcpServer((socket) => {
      connections++;
      socket.destroy();
    });
    await new Promise<void>((resolve) => victim.listen(0, "127.0.0.1", resolve));
    const port = (victim.address() as AddressInfo).port;
    try {
      site.set("/probe", {
        body: `<!doctype html><html><body><p>Sonde</p><script>
          const pc = new RTCPeerConnection({ iceServers: [{ urls: "turn:127.0.0.1:${port}?transport=tcp", username: "u", credential: "p" }] });
          pc.createDataChannel("d");
          pc.createOffer().then((offer) => pc.setLocalDescription(offer));
          const code = 'new WebSocket("ws://127.0.0.1:${port}/")';
          new Worker(URL.createObjectURL(new Blob([code], { type: "text/javascript" })));
          </script></body></html>`,
        headers: { "content-type": "text/html" },
      });
      const r = await renderer.render(`${site.origin}/probe`, { timeoutMs: 15_000 });
      expect(r.html).toContain("Sonde");
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      expect(connections).toBe(0);
    } finally {
      await site.close();
      await new Promise((resolve) => victim.close(resolve));
    }
  }, 60_000);

  it("a sub-request answer above the cap is refused; a cross-origin hop drops cookie and authorization", async () => {
    const seen: Array<{ path: string; host: string; cookie?: string; authorization?: string }> = [];
    const server = createServer((req, res) => {
      seen.push({ path: req.url ?? "", host: req.headers.host ?? "", cookie: req.headers.cookie, authorization: req.headers.authorization });
      if (req.url === "/big") return void res.writeHead(200, { "content-type": "text/plain" }).end("x".repeat(2_000));
      if (req.url === "/same") return void res.writeHead(302, { location: "/other" }).end();
      if (req.url === "/away") return void res.writeHead(302, { location: `http://localhost:${port}/other` }).end();
      res.writeHead(200, { "content-type": "text/plain" }).end("ok");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    const origin = `http://127.0.0.1:${port}`;
    const agent = createGuardedAgent({ isAllowedAddress: () => true, resolveAll: async () => [{ address: "127.0.0.1", family: 4 }] });
    const get = (path: string, max: number) =>
      fetchFollowingRedirects(
        { url: `${origin}${path}`, method: "GET", headers: { cookie: "s=1", authorization: "Bearer t" }, body: null },
        async () => true,
        agent,
        5000,
        max,
      );
    try {
      await expect(get("/big", 1_000)).rejects.toBeInstanceOf(AnswerTooLarge);
      expect((await get("/big", 2_000))!.body).toHaveLength(2_000);
      await get("/same", 1_000);
      await get("/away", 1_000);
      const others = seen.filter((q) => q.path === "/other");
      expect(others).toEqual([
        { path: "/other", host: `127.0.0.1:${port}`, cookie: "s=1", authorization: "Bearer t" },
        { path: "/other", host: `localhost:${port}`, cookie: undefined, authorization: undefined },
      ]);
    } finally {
      await agent.close();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("a context blocks service workers, closes websockets, drops its routes before closing; a crashed browser is relaunched", async () => {
    const calls: string[] = [];
    const launched: Array<{ connected: boolean; emit(): void }> = [];
    const launchBrowser = async () => {
      const listeners: Array<() => void> = [];
      const state = { connected: true, emit: () => listeners.forEach((l) => l()) };
      launched.push(state);
      const context = {
        routeWebSocket: async (_url: string, handler: (ws: { close(): void }) => void) => {
          calls.push("routeWebSocket");
          handler({ close: () => calls.push("ws.close") });
        },
        route: async () => void calls.push("route"),
        newPage: async () => {
          throw new Error("stop after setup");
        },
        unrouteAll: async (o: unknown) => void calls.push(`unrouteAll ${JSON.stringify(o)}`),
        close: async () => void calls.push("close"),
      };
      return {
        on: (event: string, listener: () => void) => {
          if (event === "disconnected") listeners.push(listener);
        },
        isConnected: () => state.connected,
        newContext: async (options: unknown) => {
          calls.push(`newContext ${JSON.stringify(options)}`);
          return context;
        },
        close: async () => undefined,
      } as unknown as Browser;
    };
    const fake = createPlaywrightRenderer({ isAllowed: async () => true, launchBrowser });
    await expect(fake.render("https://x.test.invalid/", { timeoutMs: 1000 })).rejects.toThrow("stop after setup");
    expect(calls).toEqual([
      `newContext ${JSON.stringify({ userAgent: "Periplus/0.1 (+mailto:test@example.invalid)", serviceWorkers: "block" })}`,
      "routeWebSocket",
      "ws.close",
      "route",
      `unrouteAll ${JSON.stringify({ behavior: "ignoreErrors" })}`,
      "close",
    ]);
    expect(launched).toHaveLength(1);

    // Crash: the disconnected event drops the browser, the next render launches a new one.
    launched[0]!.connected = false;
    launched[0]!.emit();
    await expect(fake.render("https://x.test.invalid/", { timeoutMs: 1000 })).rejects.toThrow("stop after setup");
    expect(launched).toHaveLength(2);

    // A browser that died without the event is noticed before its next context.
    launched[1]!.connected = false;
    await expect(fake.render("https://x.test.invalid/", { timeoutMs: 1000 })).rejects.toThrow("stop after setup");
    expect(launched).toHaveLength(3);
    await fake.close();
  });

  it("307 and 308 keep method and body, 303 turns them into a GET", async () => {
    const seen: Array<{ method: string; path: string; body: string }> = [];
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (c: Buffer) => (body += c.toString()));
      req.on("end", () => {
        seen.push({ method: req.method ?? "", path: req.url ?? "", body });
        const redirects: Record<string, [number, string]> = { "/a": [307, "/b"], "/b": [308, "/c"], "/c": [303, "/d"] };
        const hop = redirects[req.url ?? ""];
        if (hop) res.writeHead(hop[0], { location: hop[1] }).end();
        else res.writeHead(200, { "content-type": "text/plain" }).end("ok");
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const answer = await fetchFollowingRedirects(
        { url: `${origin}/a`, method: "POST", headers: { "content-type": "text/plain" }, body: Buffer.from("payload") },
        async () => true,
        openAgent,
        5000,
      );
      expect(answer).toMatchObject({ status: 200, url: `${origin}/d` });
      expect(seen).toEqual([
        { method: "POST", path: "/a", body: "payload" },
        { method: "POST", path: "/b", body: "payload" },
        { method: "POST", path: "/c", body: "payload" },
        { method: "GET", path: "/d", body: "" },
      ]);
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("refuses a sub-request whose host resolves to a private address at connect time", async () => {
    const guarded = createGuardedAgent({ resolveAll: async () => [{ address: "127.0.0.1", family: 4 }] });
    try {
      const error = await fetchFollowingRedirects(
        { url: "http://rebind.test.invalid:8080/", method: "GET", headers: {}, body: null },
        async () => true,
        guarded,
        5000,
      ).catch((e: unknown) => e);
      expect(blockedCause(error)).toBeInstanceOf(BlockedAddressError);
    } finally {
      await guarded.close();
    }
  });

  it.skipIf(!chromiumInstalled())("a page's websocket is closed without reaching the server", async () => {
    const site = await startSiteServer();
    let upgraded = false;
    const ws = createServer();
    ws.on("upgrade", (_req, socket) => {
      upgraded = true;
      socket.destroy();
    });
    await new Promise<void>((resolve) => ws.listen(0, "127.0.0.1", resolve));
    const wsPort = (ws.address() as AddressInfo).port;
    try {
      site.set("/socket", {
        body: `<!doctype html><html><body><p id="s">offen</p><script>
          const s = new WebSocket("ws://127.0.0.1:${wsPort}/");
          s.onclose = () => { document.getElementById("s").textContent = "geschlossen"; };
          </script></body></html>`,
        headers: { "content-type": "text/html" },
      });
      const r = await renderer.render(`${site.origin}/socket`, { timeoutMs: 15_000 });
      expect(r.html).toContain("geschlossen");
      expect(upgraded).toBe(false);
    } finally {
      await site.close();
      ws.closeAllConnections();
      await new Promise((resolve) => ws.close(resolve));
    }
  }, 60_000);

  it("getRenderer is one renderer per process until closeRenderer", async () => {
    const first = getRenderer();
    expect(getRenderer()).toBe(first);
    // Nothing was rendered: closing launches no browser.
    await closeRenderer();
    expect(getRenderer()).not.toBe(first);
    await closeRenderer();
  });

  it.skipIf(!chromiumInstalled())("the playwright renderer returns script-built html from the site server", async () => {
    const site = await startSiteServer();
    try {
      site.set("/app", {
        body: `<!doctype html><html><body><div id="app"></div><img src="/pic.png">
          <script>document.getElementById("app").innerHTML = "<p>Gebaut vom Skript</p>";</script></body></html>`,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
      const r = await renderer.render(`${site.origin}/app`, { timeoutMs: 15_000 });
      expect(r.status).toBe(200);
      expect(r.finalUrl).toBe(`${site.origin}/app`);
      expect(r.html).toContain("<p>Gebaut vom Skript</p>");
      const page = site.requests.find((q) => q.path === "/app");
      expect(page?.headers["user-agent"]).toBe("Periplus/0.1 (+mailto:test@example.invalid)");
      // Images are blocked: the browser never asks for them.
      expect(site.requests.some((q) => q.path === "/pic.png")).toBe(false);
    } finally {
      await site.close();
    }
  }, 60_000);
});
