import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Db } from "@/lib/db/client";
import { recordExternalCall } from "@/lib/domain/costs";
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
  /** Requests per minute for this service, shared across processes via `takeToken`; omitted = unlimited. */
  ratePerMinute?: number;
};

export type HttpResponse = { status: number; body: Uint8Array; text(): string };

export type Transport = (req: HttpRequest) => Promise<HttpResponse>;

export type CallContext = { db: Db; runId?: string; tileId?: string; stage?: string };

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

const MAX_RATE_WAIT_MS = 60_000;

export function makeResponse(status: number, body: Uint8Array): HttpResponse {
  return { status, body, text: () => new TextDecoder().decode(body) };
}

function userAgent(): string {
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
  let waitedMs = 0;
  for (;;) {
    const token = await takeToken(db, `http:${req.service}`, req.ratePerMinute, now());
    if (token.ok) return;
    if (waitedMs + token.retryAfterMs > MAX_RATE_WAIT_MS) {
      throw new RetryableHttpError(
        `rate limit for ${req.service}: next token in ${token.retryAfterMs} ms, already waited ${waitedMs} ms`,
      );
    }
    await sleep(token.retryAfterMs);
    waitedMs += token.retryAfterMs;
  }
}

/**
 * One call to an external HTTP service: sets the contact User-Agent, waits for a rate-limit token
 * (at most 60 s, else `RetryableHttpError`), calls the transport, records the call in
 * `external_calls` (cost 0, one request) and throws by status (429/5xx retryable, other 4xx not).
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
  await waitForToken(ctx.db, req, deps);

  const record = (meta: Record<string, unknown>) =>
    recordExternalCall(ctx.db, {
      service: req.service,
      operation: req.operation,
      units: 1,
      unit: "request",
      costEur: 0,
      runId: ctx.runId,
      tileId: ctx.tileId,
      stage: ctx.stage,
      meta,
    });

  let res: HttpResponse;
  try {
    res = await transport({ ...req, headers: { ...req.headers, "User-Agent": userAgent() } });
  } catch (error) {
    try {
      await record({ status: null, bytes: 0, error: (error as Error).message });
    } catch (recordError) {
      // The transport error is the one callers must see; the failed bookkeeping is only logged.
      createLogger("http").error({ err: recordError, service: req.service }, "recording failed external call failed");
    }
    throw error;
  }
  await record({ status: res.status, bytes: res.body.byteLength });

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
      signal: AbortSignal.timeout(req.timeoutMs),
    });
    return makeResponse(res.status, new Uint8Array(await res.arrayBuffer()));
  } catch (error) {
    throw new RetryableHttpError(`${method} ${req.url} failed: ${(error as Error).message}`, undefined, {
      cause: error,
    });
  }
};

const DEFAULT_FIXTURE_DIR = "test/fixtures/http";

type FixtureFile = {
  request: { method: string; url: string; body: string | null };
  status: number;
  bodyBase64: string;
};

/** sha256 hex of `method + " " + url + "\n" + body`: stable across processes and machines. */
export function fixtureKey(req: Pick<HttpRequest, "method" | "url" | "body">): string {
  return createHash("sha256")
    .update(`${req.method ?? "GET"} ${req.url}\n${req.body ?? ""}`)
    .digest("hex");
}

function fixturePath(dir: string, req: HttpRequest): string {
  return join(dir, req.service, `${fixtureKey(req)}.json`);
}

/** Replays recorded responses from `<dir>/<service>/<key>.json`; an unrecorded request is an error. */
export function fixtureTransport(dir: string = DEFAULT_FIXTURE_DIR): Transport {
  return async (req) => {
    let raw: string;
    try {
      raw = await readFile(fixturePath(dir, req), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      throw new Error(`no fixture for ${req.service} ${req.method ?? "GET"} ${req.url}`);
    }
    const fixture = JSON.parse(raw) as FixtureFile;
    return makeResponse(fixture.status, new Uint8Array(Buffer.from(fixture.bodyBase64, "base64")));
  };
}

/** Passes requests to `inner` and writes every response as a fixture that `fixtureTransport` replays. */
export function recordingTransport(inner: Transport, dir: string = DEFAULT_FIXTURE_DIR): Transport {
  return async (req) => {
    const res = await inner(req);
    const fixture: FixtureFile = {
      request: { method: req.method ?? "GET", url: req.url, body: req.body ?? null },
      status: res.status,
      bodyBase64: Buffer.from(res.body).toString("base64"),
    };
    const file = fixturePath(dir, req);
    await mkdir(join(dir, req.service), { recursive: true });
    await writeFile(file, `${JSON.stringify(fixture, null, 2)}\n`);
    return res;
  };
}

/** The network everywhere except under test, where recorded fixtures are replayed. */
export function getTransport(): Transport {
  return getEnv().NODE_ENV === "test" ? fixtureTransport() : fetchTransport;
}
