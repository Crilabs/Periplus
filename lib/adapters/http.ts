import type { BudgetService } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { assertWithinBudget, recordExternalCall } from "@/lib/domain/costs";
import { takeToken } from "@/lib/domain/rate-limit";
import { getEnv } from "@/lib/env";
import { createLogger } from "@/lib/logger";
import { assertNotSimulated, isOffline } from "./simulation";

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
  /** Bucket capacity (default `ratePerMinute`); 1 spaces the calls evenly (e.g. 60 per minute = one per second). */
  rateBurst?: number;
  /** Longest total wait for a rate token before giving up with `RetryableHttpError` (default 60 000). */
  maxRateWaitMs?: number;
  /** Statuses returned to the caller instead of thrown (e.g. 304, 404, 410, redirects of a crawl). */
  okStatuses?: number[];
  /** `follow` (default) lets the transport follow redirects; `manual` returns the 3xx answer itself. */
  redirect?: "follow" | "manual";
  /** Reads at most this many body bytes while streaming and drops the rest (`HttpResponse.truncated`). */
  maxBodyBytes?: number;
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
  /** The body was cut at `HttpRequest.maxBodyBytes`. */
  truncated?: boolean;
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
  init: { headers?: Record<string, string>; finalUrl?: string; truncated?: boolean } = {},
): HttpResponse {
  const headers = Object.fromEntries(Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    status,
    body,
    headers,
    finalUrl: init.finalUrl ?? "",
    ...(init.truncated ? { truncated: true } : {}),
    text: () => new TextDecoder().decode(body),
  };
}

/** A body cut to `max` bytes (when given), for transports that hold the whole body already (fixtures, stubs). */
export function capBody(body: Uint8Array, max: number | undefined): { body: Uint8Array; truncated: boolean } {
  if (max === undefined || body.byteLength <= max) return { body, truncated: false };
  return { body: body.subarray(0, max), truncated: true };
}

/**
 * Reads a response body stream up to `max` bytes (all of it without `max`) and cancels the rest, so an
 * oversized answer is never held in memory beyond the limit.
 */
export async function readBodyCapped(
  stream: ReadableStream<Uint8Array> | null,
  max: number | undefined,
): Promise<{ body: Uint8Array; truncated: boolean }> {
  if (!stream) return { body: new Uint8Array(0), truncated: false };
  const reader = stream.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (max !== undefined && size + value.byteLength > max) {
      parts.push(value.subarray(0, max - size));
      size = max;
      truncated = true;
      await reader.cancel().catch(() => undefined);
      break;
    }
    parts.push(value);
    size += value.byteLength;
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    body.set(part, offset);
    offset += part.byteLength;
  }
  return { body, truncated };
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

/** A shared request budget: `perMinute` tokens of bucket `http:<key>`, waiting at most `maxWaitMs` in total. */
export type RateLimit = { key: string; perMinute: number; burst?: number; maxWaitMs?: number };

/**
 * Waits for a token of the rate bucket `http:<key>` (shared across processes via `takeToken`); gives up with
 * `RetryableHttpError` once the total wait would exceed `maxWaitMs` (default 60 000). Requests and page renders
 * of the same domain draw from the same bucket.
 */
export async function waitForRateToken(db: Db, limit: RateLimit, deps: HttpCallDeps = {}): Promise<void> {
  const now = deps.now ?? (() => new Date());
  const sleep = deps.sleep ?? realSleep;
  const maxWaitMs = limit.maxWaitMs ?? DEFAULT_MAX_RATE_WAIT_MS;
  let waitedMs = 0;
  for (;;) {
    const token = await takeToken(db, `http:${limit.key}`, limit.perMinute, now(), limit.burst);
    if (token.ok) return;
    if (waitedMs + token.retryAfterMs > maxWaitMs) {
      throw new RetryableHttpError(
        `rate limit for ${limit.key}: next token in ${token.retryAfterMs} ms, already waited ${waitedMs} ms`,
      );
    }
    await sleep(token.retryAfterMs);
    waitedMs += token.retryAfterMs;
  }
}

async function waitForToken(db: Db, req: HttpRequest, deps: HttpCallDeps): Promise<void> {
  if (req.ratePerMinute === undefined) return;
  await waitForRateToken(
    db,
    { key: req.rateKey ?? req.service, perMinute: req.ratePerMinute, burst: req.rateBurst, maxWaitMs: req.maxRateWaitMs },
    deps,
  );
}

/**
 * One call to an external HTTP service: refuses it in a simulation unless the transport answers in the process
 * (`assertNotSimulated`, `markOffline`), checks the daily budget of a paid service (`BudgetExceeded`),
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
  if (!isOffline(transport)) assertNotSimulated(req.service, `${req.operation} ${req.method ?? "GET"}`);
  if (req.budget) await assertWithinBudget(ctx.db, req.budget, undefined, deps.now?.());
  if (req.ratePerMinute !== undefined) {
    await waitForToken(ctx.db, req, deps);
    // Other calls may have spent the budget while this one waited for its token.
    if (req.budget) await assertWithinBudget(ctx.db, req.budget, undefined, deps.now?.());
  }

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

/** The real network (refused in a simulation). Timeouts and network failures become `RetryableHttpError`. */
export const fetchTransport: Transport = async (req) => {
  const method = req.method ?? "GET";
  assertNotSimulated(req.service, `${req.operation} ${method}`);
  try {
    const res = await fetch(req.url, {
      method,
      body: req.body,
      headers: req.headers,
      redirect: req.redirect ?? "follow",
      signal: AbortSignal.timeout(req.timeoutMs),
    });
    const { body, truncated } = await readBodyCapped(res.body, req.maxBodyBytes);
    return makeResponse(res.status, body, { headers: Object.fromEntries(res.headers), finalUrl: res.url || req.url, truncated });
  } catch (error) {
    throw new RetryableHttpError(`${method} ${req.url} failed: ${(error as Error).message}`, undefined, {
      cause: error,
    });
  }
};

let installedTransport: Transport | undefined;

/**
 * Replaces the transport `getTransport()` hands out; `undefined` restores the default. The test setup
 * (`test/setup.ts`) installs the fixture replay of `./http-fixtures` here, which production code never imports.
 */
export function setTransport(transport: Transport | undefined): void {
  installedTransport = transport;
}

/** The transport `setTransport` installed, if any (other transports, e.g. the crawl's, defer to it as well). */
export function transportOverride(): Transport | undefined {
  return installedTransport;
}

/** The transport set with `setTransport`, else the network; under test it refuses: tests never call the network. */
export function getTransport(): Transport {
  if (installedTransport) return installedTransport;
  if (getEnv().NODE_ENV === "test") throw new Error("no transport set under test: install one with setTransport");
  return fetchTransport;
}
