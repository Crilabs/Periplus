import type { BudgetService } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { assertWithinBudget, recordExternalCall } from "@/lib/domain/costs";
import { takeToken } from "@/lib/domain/rate-limit";
import { getEnv } from "@/lib/env";
import { createLogger } from "@/lib/logger";

export type HttpRequest = {
  service: string;
  operation: string;
  url: string;
  method?: "GET" | "POST";
  body?: string;
  headers?: Record<string, string>;
  timeoutMs: number;
  /** Requests per minute for this bucket, shared across processes via `takeToken`; omitted = unlimited. */
  ratePerMinute?: number;
  /** Rate bucket `http:<rateKey ?? service>`, e.g. one per crawled domain of the same service. */
  rateKey?: string;
  /** Longest total wait for a rate token before giving up with `RetryableHttpError` (default 60 000). */
  maxRateWaitMs?: number;
  /** Statuses returned to the caller instead of thrown (e.g. 304, 404, 410, redirects of a crawl). */
  okStatuses?: number[];
  /** `follow` (default) lets the transport follow redirects; `manual` returns the 3xx answer itself. */
  redirect?: "follow" | "manual";
  /** Paid service whose daily budget is checked before the rate token and the call. */
  budget?: BudgetService;
  /** Units and cost of an answered call (default 1 `request`, 0 EUR); a transport failure is recorded at 0 EUR. */
  costOf?: (res: HttpResponse) => { units: number; unit: string; costEur: number };
  /** Extra fields for the `external_calls.meta` of this call. */
  meta?: Record<string, unknown>;
};

export type HttpResponse = {
  status: number;
  body: Uint8Array;
  /** Response headers, names lower-cased. */
  headers: Record<string, string>;
  /** URL of the answer after redirects the transport followed; `httpCall` fills in the request URL if empty. */
  finalUrl: string;
  text(): string;
};

export type Transport = (req: HttpRequest) => Promise<HttpResponse>;

export type CallContext = { db: Db; runId?: string; tileId?: string; stage?: string; sourceId?: string };

/** Worth retrying later: 429, 5xx, timeout, network failure, or an overloaded service's garbage answer. */
export class RetryableHttpError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "RetryableHttpError";
  }
}

/** A 4xx other than 429: the request itself is wrong, retrying will not help. */
export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

const DEFAULT_MAX_RATE_WAIT_MS = 60_000;

export function makeResponse(
  status: number,
  body: Uint8Array,
  init: { headers?: Record<string, string>; finalUrl?: string } = {},
): HttpResponse {
  const headers = Object.fromEntries(Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
  return { status, body, headers, finalUrl: init.finalUrl ?? "", text: () => new TextDecoder().decode(body) };
}

/** The contact User-Agent of every request Periplus makes (HTTP calls and the rendering browser). */
export function userAgent(): string {
  return `Periplus/0.1 (+mailto:${getEnv().CONTACT_EMAIL})`;
}

export type HttpCallDeps = {
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
};

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function waitForToken(db: Db, req: HttpRequest, deps: HttpCallDeps): Promise<void> {
  if (req.ratePerMinute === undefined) return;
  const now = deps.now ?? (() => new Date());
  const sleep = deps.sleep ?? realSleep;
  const bucket = req.rateKey ?? req.service;
  const maxWaitMs = req.maxRateWaitMs ?? DEFAULT_MAX_RATE_WAIT_MS;
  let waitedMs = 0;
  for (;;) {
    const token = await takeToken(db, `http:${bucket}`, req.ratePerMinute, now());
    if (token.ok) return;
    if (waitedMs + token.retryAfterMs > maxWaitMs) {
      throw new RetryableHttpError(
        `rate limit for ${bucket}: next token in ${token.retryAfterMs} ms, already waited ${waitedMs} ms`,
      );
    }
    await sleep(token.retryAfterMs);
    waitedMs += token.retryAfterMs;
  }
}

/**
 * One call to an external HTTP service: checks the daily budget of a paid service (`BudgetExceeded`),
 * sets the contact User-Agent, waits for a rate-limit token (at most `maxRateWaitMs`, else
 * `RetryableHttpError`), calls the transport, records the call in `external_calls` (cost by `costOf`,
 * default 0 EUR for one request) and throws by status (429/5xx retryable, other 4xx not) unless the
 * status is in `okStatuses`.
 *
 * The call is recorded with `ctx.db`. Fetch before opening an import transaction and pass the
 * plain connection: a rollback would otherwise drop the cost record of a call that did happen.
 */
export async function httpCall(
  transport: Transport,
  req: HttpRequest,
  ctx: CallContext,
  deps: HttpCallDeps = {},
): Promise<HttpResponse> {
  if (req.budget) await assertWithinBudget(ctx.db, req.budget, undefined, deps.now?.());
  await waitForToken(ctx.db, req, deps);

  const free = { units: 1, unit: "request", costEur: 0 };
  const record = (cost: typeof free, meta: Record<string, unknown>) =>
    recordExternalCall(ctx.db, {
      service: req.service,
      operation: req.operation,
      ...cost,
      runId: ctx.runId,
      tileId: ctx.tileId,
      stage: ctx.stage,
      sourceId: ctx.sourceId,
      meta: { ...req.meta, ...meta },
    });

  let res: HttpResponse;
  try {
    res = await transport({ ...req, headers: { ...req.headers, "User-Agent": userAgent() } });
  } catch (error) {
    try {
      await record(free, { status: null, bytes: 0, error: (error as Error).message });
    } catch (recordError) {
      // The transport error is the one callers must see; the failed bookkeeping is only logged.
      createLogger("http").error({ err: recordError, service: req.service }, "recording failed external call failed");
    }
    throw error;
  }
  if (!res.finalUrl) res = { ...res, finalUrl: req.url };
  const meta = { status: res.status, bytes: res.body.byteLength };
  let cost = free;
  if (req.costOf) {
    try {
      cost = req.costOf(res);
    } catch (error) {
      // The call happened: record it at 0 EUR with the reason, then let the caller see the error.
      await record(free, { ...meta, costError: (error as Error).message });
      throw error;
    }
  }
  await record(cost, meta);

  if (req.okStatuses?.includes(res.status)) return res;
  const where = `${req.service} ${req.operation} ${req.method ?? "GET"} ${req.url}`;
  if (res.status === 429 || res.status >= 500) {
    throw new RetryableHttpError(`HTTP ${res.status} from ${where}`, res.status);
  }
  if (res.status >= 400) throw new HttpError(`HTTP ${res.status} from ${where}`, res.status);
  return res;
}

/** The real network. Timeouts and network failures become `RetryableHttpError`. */
export const fetchTransport: Transport = async (req) => {
  const method = req.method ?? "GET";
  try {
    const res = await fetch(req.url, {
      method,
      body: req.body,
      headers: req.headers,
      redirect: req.redirect ?? "follow",
      signal: AbortSignal.timeout(req.timeoutMs),
    });
    return makeResponse(res.status, new Uint8Array(await res.arrayBuffer()), {
      headers: Object.fromEntries(res.headers),
      finalUrl: res.url || req.url,
    });
  } catch (error) {
    throw new RetryableHttpError(`${method} ${req.url} failed: ${(error as Error).message}`, undefined, {
      cause: error,
    });
  }
};

let transportOverride: Transport | undefined;

/**
 * Replaces the transport `getTransport()` hands out; `undefined` restores the default. The test setup
 * (`test/setup.ts`) installs the fixture replay of `./http-fixtures` here, which production code never imports.
 */
export function setTransport(transport: Transport | undefined): void {
  transportOverride = transport;
}

/** The transport set with `setTransport`, else the network; under test it refuses: tests never call the network. */
export function getTransport(): Transport {
  if (transportOverride) return transportOverride;
  if (getEnv().NODE_ENV === "test") throw new Error("no transport set under test: install one with setTransport");
  return fetchTransport;
}
